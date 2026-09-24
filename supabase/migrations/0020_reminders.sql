-- 0020 — scheduled reminders for tasks & appointments (⏰)
--
-- How it works (all server-side, no app change needed):
--   * every 15 minutes pg_cron runs public.send_due_reminders()
--   * appointments → reminded 1 hour before due_at
--   * tasks        → reminded at due_at
--   * date-only due dates (no time given) are treated as 9:00 AM
--     America/New_York instead of midnight
--   * recipients: the assignee (items.assigned_to name → family member,
--     "زوجي/جوزي" → space owner), otherwise the whole space;
--     pushes go straight to Expo's push API via pg_net (no secrets needed)
--   * each item is reminded once (reminder_sent_at); moving the due date
--     re-arms it via trigger
--
-- NOTE: pushes only reach real phones from the native app (EAS build).
-- Until then the pipeline still runs — verify with:
--   select jobname, schedule, active from cron.job;
--   select start_time, status from cron.job_run_details
--    where jobname = 'mawjood-due-reminders'
--    order by start_time desc limit 5;

-- ── extensions ──────────────────────────────────────────────
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── one reminder per item ───────────────────────────────────
alter table public.items
  add column if not exists reminder_sent_at timestamptz;

create index if not exists items_reminder_idx
  on public.items (due_at)
  where status = 'open' and reminder_sent_at is null and due_at is not null;

-- moving the due date re-arms the reminder
create or replace function public.reset_reminder_on_due_change()
returns trigger
language plpgsql
as $$
begin
  if new.due_at is distinct from old.due_at then
    new.reminder_sent_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists items_reset_reminder on public.items;
create trigger items_reset_reminder
  before update of due_at on public.items
  for each row
  execute function public.reset_reminder_on_due_change();

-- ── the sender (every 15 min via pg_cron) ───────────────────
create or replace function public.send_due_reminders()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  effective_due timestamptz;
  remind_at timestamptz;
  recipient_ids uuid[];
  tok text;
  msgs jsonb;
  req_id bigint;
  checked_count int := 0;
  reminded_count int := 0;
  error_count int := 0;
begin
  for r in
    select i.id, i.space_id, i.kind, i.title, i.details,
           i.due_at, i.assigned_to, i.created_by
    from public.items i
    where i.status = 'open'
      and i.due_at is not null
      and i.reminder_sent_at is null
      and i.kind in ('task', 'appointment')
  loop
    -- date-only (no time given) → 9:00 AM New York, not midnight
    if (r.due_at at time zone 'UTC')::time = '00:00:00'::time then
      effective_due := ((r.due_at at time zone 'UTC')::date || ' 09:00')::timestamp
                       at time zone 'America/New_York';
    else
      effective_due := r.due_at;
    end if;

    if r.kind = 'appointment' then
      remind_at := effective_due - interval '1 hour';
    else
      remind_at := effective_due;
    end if;

    if remind_at > now() then
      continue;
    end if;
    checked_count := checked_count + 1;

    -- ── who gets it ──
    if r.assigned_to is not null and btrim(r.assigned_to) <> '' then
      if lower(btrim(r.assigned_to)) in ('زوجي', 'جوزي') then
        -- husband → the family manager (space owner)
        select array[s.owner_id]
        into recipient_ids
        from public.spaces s
        where s.id = r.space_id;
      else
        -- assignee name → family member (first-word match on display name)
        select coalesce(array_agg(distinct m.user_id), '{}')
        into recipient_ids
        from (
          select s.owner_id as user_id
          from public.spaces s where s.id = r.space_id
          union
          select sm.user_id
          from public.space_members sm where sm.space_id = r.space_id
        ) m
        join public.profiles p on p.id = m.user_id
        where lower(btrim(split_part(coalesce(p.display_name, ''), ' ', 1))) = lower(btrim(r.assigned_to))
           or lower(btrim(coalesce(p.display_name, ''))) = lower(btrim(r.assigned_to));
      end if;

      if coalesce(array_length(recipient_ids, 1), 0) = 0 and r.created_by is not null then
        -- name didn't match a member → remind the creator instead
        recipient_ids := array[r.created_by];
      end if;
    else
      -- no assignee → the whole space (family)
      select coalesce(array_agg(distinct u), '{}')
      into recipient_ids
      from (
        select s.owner_id as u from public.spaces s where s.id = r.space_id
        union
        select sm.user_id from public.space_members sm where sm.space_id = r.space_id
      ) all_members;
    end if;

    -- ── one Expo message per registered device ──
    msgs := '[]'::jsonb;
    for tok in
      select distinct d.expo_push_token
      from public.device_tokens d
      where d.user_id = any (recipient_ids)
    loop
      msgs := msgs || jsonb_build_object(
        'to', tok,
        'sound', 'default',
        'title', '⏰ تذكير | Reminder',
        'body', r.title || coalesce(' — ' || nullif(btrim(r.details), ''), '')
      );
    end loop;

    if jsonb_array_length(msgs) > 0 then
      begin
        select net.http_post(
          url := 'https://exp.host/--/api/v2/push/send',
          headers := '{"Content-Type": "application/json"}'::jsonb,
          body := msgs
        ) into req_id;
        update public.items set reminder_sent_at = now() where id = r.id;
        reminded_count := reminded_count + 1;
      exception when others then
        -- network hiccup → leave unmarked, retry on the next run
        error_count := error_count + 1;
      end;
    else
      -- no registered devices: mark processed so we don't retry forever
      update public.items set reminder_sent_at = now() where id = r.id;
    end if;
  end loop;

  return jsonb_build_object(
    'checked', checked_count,
    'reminded', reminded_count,
    'errors', error_count
  );
end;
$$;

-- ── schedule: every 15 minutes (idempotent) ─────────────────
do $$
begin
  perform cron.unschedule('mawjood-due-reminders');
exception when others then
  null;
end;
$$;

select cron.schedule(
  'mawjood-due-reminders',
  '*/15 * * * *',
  $$select public.send_due_reminders();$$
);

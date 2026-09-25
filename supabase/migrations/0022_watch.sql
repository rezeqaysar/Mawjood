-- 0022: 🛡️ prevention watches ("أخذت المفك على الكراج" → "رجّعته لمكانه؟")
-- New item kind 'watch': something taken somewhere that should be put back.
-- A dedicated cron function asks the whole space after the due time.
-- Idempotent: safe to run twice.

-- ── 1. extend the kind CHECK with 'watch' ────────────────────────────
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'items_kind_check'
      and pg_get_constraintdef(oid) not like '%watch%'
  ) then
    alter table public.items drop constraint items_kind_check;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'items_kind_check'
  ) then
    alter table public.items add constraint items_kind_check
      check (kind in ('task', 'appointment', 'shopping', 'place',
                     'spec', 'opinion', 'checklist', 'thing', 'expense', 'watch'));
  end if;
end $$;

create index if not exists items_watch_idx
  on public.items (due_at)
  where kind = 'watch' and status = 'open'
    and reminder_sent_at is null and due_at is not null;

-- ── 2. the watch reminder function ───────────────────────────────────
-- Runs every 15 min via pg_cron. For each open watch whose time has come:
-- pushes "رجّع X لمكانه؟" to the whole space, stamps reminder_sent_at
-- (one reminder per watch; re-armed when due_at changes via the
-- items_reset_reminder trigger from 0020).
create or replace function public.send_watch_reminders()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  recipient_ids uuid[];
  tok text;
  msgs jsonb;
  req_id bigint;
  home_suffix text;
  checked_count int := 0;
  reminded_count int := 0;
  error_count int := 0;
begin
  for r in
    select i.id, i.space_id, i.title,
           i.due_at,
           i.meta->>'taken_to' as taken_to,
           i.meta->>'home_place' as home_place
    from public.items i
    where i.status = 'open'
      and i.due_at is not null
      and i.due_at <= now()
      and i.reminder_sent_at is null
      and i.kind = 'watch'
  loop
    checked_count := checked_count + 1;

    -- the whole space (family): someone took it, anyone can put it back
    select coalesce(array_agg(distinct u), '{}')
    into recipient_ids
    from (
      select s.owner_id as u from public.spaces s where s.id = r.space_id
      union
      select sm.user_id from public.space_members sm where sm.space_id = r.space_id
    ) all_members;

    if r.home_place is not null and btrim(r.home_place) <> '' then
      home_suffix := ' لمكانه (عادةً: ' || btrim(r.home_place) || ')';
    else
      home_suffix := ' لمكانه';
    end if;

    msgs := '[]'::jsonb;
    for tok in
      select distinct d.expo_push_token
      from public.device_tokens d
      where d.user_id = any (recipient_ids)
    loop
      msgs := msgs || jsonb_build_object(
        'to', tok,
        'sound', 'default',
        'title', '🛡️ وقاية',
        'body', 'رجّع ' || r.title || home_suffix
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

-- ── 3. schedule: every 15 minutes (idempotent) ────────────────────────
do $$
begin
  perform cron.unschedule('mawjood-watch-reminders');
exception when others then
  -- job didn't exist yet; nothing to remove
end $$;

select cron.schedule(
  'mawjood-watch-reminders',
  '*/15 * * * *',
  $$select public.send_watch_reminders()$$
);

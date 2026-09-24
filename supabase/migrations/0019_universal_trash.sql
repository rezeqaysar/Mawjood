-- 0019: universal trash bin (one trash for everything) + secret trash
-- Run in the Supabase SQL editor AFTER 0018.
--
-- Every delete in the app (notes, tabs, tasks, appointments, things,
-- shopping lists, chats, secret notes) lands here first when the user
-- has trash retention (profiles.trash_retention_days > 0, Plus).
-- Free users (0) delete permanently — no rows are written.
-- Secret trash: rows with vault_id set — one trash for all vaults,
-- visible only inside the secret vaults, never in the general trash.
-- Restore re-inserts the snapshotted rows with their ORIGINAL ids.

create table if not exists public.trash_bin (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in
    ('note','tab','task','appointment','thing','shopping_list','chat')),
  ref_id uuid not null,
  space_id uuid,              -- origin space (no FK: the space may be gone)
  tab_id text,               -- origin tab: null/'main'/'papers'/'secret' or a tab uuid
  vault_id uuid,             -- set => secret trash (references secret_vault(id) post-0018)
  title text not null default '',
  preview text,
  payload jsonb not null default '{}',  -- full snapshot for restore (incl. children)
  deleted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists trash_bin_user_idx
  on public.trash_bin(user_id, deleted_at desc);
create index if not exists trash_bin_expiry_idx
  on public.trash_bin(expires_at) where expires_at is not null;

alter table public.trash_bin enable row level security;
drop policy if exists "trash_bin owner all" on public.trash_bin;
create policy "trash_bin owner all"
  on public.trash_bin for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Migrate the old soft-deleted rows (0017 deleted_at) into the bin, then
-- drop the columns. Individually trashed notes become 'note' rows; a
-- trashed tab becomes ONE 'tab' row carrying its notes+items in payload.
--
-- NOTE 2026-09-24: the tabs loop is guarded on the column actually
-- existing. If 0017 ran before 0016 (space_tabs didn't exist yet), that
-- one ALTER failed and space_tabs has no deleted_at — there is simply
-- nothing to migrate, so we skip instead of erroring (42703).
do $$
declare
  r record;
  n jsonb;
  tab_notes jsonb;
  exp timestamptz;
begin
  -- tabs first (their notes ride inside the tab payload)
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'space_tabs'
      and column_name = 'deleted_at'
  ) then
    for r in select * from public.space_tabs where deleted_at is not null loop
      select coalesce(jsonb_agg(jsonb_build_object(
        'note', to_jsonb(n2),
        'items', coalesce((
          select jsonb_agg(to_jsonb(i2)) from public.items i2 where i2.note_id = n2.id
        ), '[]'::jsonb)
      )), '[]'::jsonb)
      into tab_notes
      from public.notes n2
      where n2.tab_id = r.id::text and n2.deleted_at is not null;

      exp := r.deleted_at + interval '30 days';
      insert into public.trash_bin
        (user_id, kind, ref_id, space_id, tab_id, title, payload, deleted_at, expires_at)
      values
        (r.created_by, 'tab', r.id, r.space_id, null,
         coalesce(r.icon,'📑') || ' ' || r.title,
         jsonb_build_object('tab', to_jsonb(r), 'notes', tab_notes),
         r.deleted_at, exp);

      delete from public.notes where tab_id = r.id::text and deleted_at is not null;
      delete from public.space_tabs where id = r.id;
    end loop;
  end if;

  -- individually trashed notes (not inside a trashed tab).
  -- Guarded like the tabs loop above: if 0017 never created
  -- notes.deleted_at, there is nothing to migrate.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'notes'
      and column_name = 'deleted_at'
  ) then
    for r in select * from public.notes where deleted_at is not null loop
      select coalesce(jsonb_agg(to_jsonb(i2)), '[]'::jsonb)
      into n
      from public.items i2 where i2.note_id = r.id;

      exp := r.deleted_at + interval '30 days';
      insert into public.trash_bin
        (user_id, kind, ref_id, space_id, tab_id, vault_id, title, preview, payload, deleted_at, expires_at)
      values
        (r.created_by, 'note', r.id, r.space_id, r.tab_id,
         case when r.tab_id = 'secret' then r.vault_id end,
         left(coalesce(r.transcript, ''), 60),
         left(coalesce(r.transcript, ''), 160),
         jsonb_build_object('note', to_jsonb(r), 'items', n),
         r.deleted_at, exp);

      delete from public.items where note_id = r.id;
      delete from public.notes where id = r.id;
    end loop;
  end if;
end $$;

alter table public.notes drop column if exists deleted_at;
alter table public.space_tabs drop column if exists deleted_at;

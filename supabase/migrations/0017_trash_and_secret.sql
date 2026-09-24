-- 0017: trash (soft delete) + secret tab vault
-- Run in the Supabase SQL editor.

-- 1) soft-delete columns: deleted rows stay 30 days for Plus, then purge
alter table notes add column if not exists deleted_at timestamptz;
alter table space_tabs add column if not exists deleted_at timestamptz;
create index if not exists notes_deleted_at_idx on notes(deleted_at)
  where deleted_at is not null;
create index if not exists space_tabs_deleted_at_idx on space_tabs(deleted_at)
  where deleted_at is not null;

-- 2) trash retention: the paid-plans hook.
--    0 = free (delete is permanent), 30 = Plus (30-day trash).
--    Default 30 during the testing phase; flip to 0 at launch and let
--    the Stripe webhook set 30 for paying users.
alter table profiles add column if not exists trash_retention_days int not null default 30;

-- 3) secret tab vault: STRICTLY owner-only.
--    (profiles is peer-readable by family members, so the code must NOT live there)
create table if not exists secret_vault (
  user_id uuid primary key,
  enabled boolean not null default true, -- default true during testing; false at launch (paid only)
  secret_code text,
  updated_at timestamptz not null default now()
);
alter table secret_vault enable row level security;
drop policy if exists "secret_vault owner all" on secret_vault;
create policy "secret_vault owner all"
  on secret_vault for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

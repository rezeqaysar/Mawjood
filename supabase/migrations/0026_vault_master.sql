-- 0026: ghost-key vault management — master key + duress decoy vault.
-- Run in the Supabase SQL editor. IDEMPOTENT.
--
-- DESIGN (opsec):
--   * vault codes open their vault (unchanged, plaintext match in private chat).
--   * the MASTER key opens vault MANAGEMENT (list / change codes / delete vaults).
--     The key itself lives ONLY in the owner's head — the DB keeps a bcrypt hash,
--     never the key. All hashing/verification of the master happens in the
--     vault-master edge fn (service_role); the app only ever holds the hash in
--     memory for the chat intercept, never on disk.
--   * the DURESS code is a normal vault row flagged is_decoy: typing it opens an
--     empty-looking decoy vault page. Excluded from the paid vault-slot count.

-- 1) master key store: hash only, owner-read, service_role writes (via edge fn)
create table if not exists public.vault_master (
  user_id uuid primary key references auth.users(id) on delete cascade,
  master_hash text not null,
  failed_count int not null default 0,
  locked_until timestamptz null,
  recovery_requested_at timestamptz null,
  updated_at timestamptz not null default now()
);
alter table public.vault_master enable row level security;
drop policy if exists "vault_master owner read" on public.vault_master;
create policy "vault_master owner read"
  on public.vault_master for select
  to authenticated
  using (user_id = auth.uid());
-- no insert/update/delete policies: only the vault-master edge fn (service_role)
-- writes, so attempt-counting and lockout can't be bypassed from the client.

-- 2) decoy vault flag + created_at for stable management ordering
alter table public.secret_vault
  add column if not exists is_decoy boolean not null default false;
alter table public.secret_vault
  add column if not exists created_at timestamptz not null default now();
create index if not exists secret_vault_user_decoy_idx
  on public.secret_vault (user_id, is_decoy);

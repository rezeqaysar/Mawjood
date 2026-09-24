-- 0018: multi-vault secrets — EVERY CODE GETS ITS OWN VAULT.
-- Each row in secret_vault is one vault (user_id, secret_code); notes.vault_id
-- points at the vault they belong to. Sending a code in private chat opens
-- THAT code's vault page. Old single-row shape (user_id PK) is reshaped below.
--
-- PAID HOOK: profiles.secret_vaults_limit — free plan = 1 vault, paid = more.
-- TESTING DEFAULT 5 → FLIP TO 1 AT LAUNCH.

-- 1) reshape secret_vault: uuid PK, one row per (user, code)
alter table secret_vault drop constraint if exists secret_vault_pkey;
alter table secret_vault drop column if exists enabled;
alter table secret_vault
  add column if not exists id uuid default gen_random_uuid() primary key;
alter table secret_vault
  drop constraint if exists secret_vault_user_code_unique;
alter table secret_vault
  add constraint secret_vault_user_code_unique unique (user_id, secret_code);

-- 2) notes.vault_id → which vault a secret note belongs to
alter table notes
  add column if not exists vault_id uuid references secret_vault(id) on delete cascade;
create index if not exists notes_vault_id_idx on notes (vault_id);

-- 3) paid hook: how many secret vaults the plan allows
alter table profiles
  add column if not exists secret_vaults_limit int not null default 5; -- TESTING → 1 at launch

-- RLS on secret_vault stays owner-only (existing policy uses user_id = auth.uid())
-- notes RLS already covers vault_id via the note row itself.

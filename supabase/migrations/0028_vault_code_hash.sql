-- 0028: hash secret vault codes (P0-4).
-- secret_vault.secret_code was plaintext: any DB leak / privileged read exposed
-- every vault code. Codes are now bcrypt hashes (secret_code_hash); verification
-- happens with bcrypt compare (edge fn vault-master, or bcryptjs on-device).
-- The plaintext column is dropped at the end of this migration.

create extension if not exists pgcrypto;

alter table secret_vault
  add column if not exists secret_code_hash text;

-- backfill: hash every existing plaintext code (cost 10)
-- guarded: on re-run the plaintext column is already gone
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'secret_vault'
      and column_name = 'secret_code'
  ) then
    update secret_vault
      set secret_code_hash = crypt(secret_code, gen_salt('bf', 10))
      where secret_code_hash is null
        and secret_code is not null
        and secret_code <> '';
  end if;
end $$;

-- the plaintext lookup key must go with the column
alter table secret_vault
  drop constraint if exists secret_vault_user_code_unique;

alter table secret_vault
  drop column if exists secret_code;

-- 0027: decoy master — a fake management layer.
-- decoy_master_hash opens a FAKE management screen (decoy vault only) for the
-- day someone demands "open the management". Set/removed from real management
-- only (master-verified session), via the vault-master edge function.
alter table public.vault_master
  add column if not exists decoy_master_hash text;

-- 0025: subscription grants ledger — every admin grant/adjustment of a paid
-- limit is recorded here with WHEN it was granted and WHEN it expires,
-- so the admin panel can show per-user subscription history.
-- Written by the admin-set-limits edge fn (service_role). No public access.

create table if not exists public.subscription_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,              -- limit key: family_slots, secret_vaults_limit, chat_retention_days, trash_retention_days, custom_tabs_limit
  value integer not null,          -- granted value
  granted_at timestamptz not null default now(),
  expires_at timestamptz null,     -- null = permanent
  granted_by text not null default 'admin',
  note text null
);

alter table public.subscription_grants enable row level security;
-- intentionally NO public policies: service_role (admin edge fns) only.

create index if not exists subscription_grants_user_idx
  on public.subscription_grants (user_id, granted_at desc);

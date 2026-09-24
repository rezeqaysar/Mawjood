-- 0013: chat history (ChatGPT-style) — sessions kept N days, then auto-deleted.
-- profiles.chat_retention_days is the future paid-plans hook:
-- free = 7 days, 1-month plan = 30, 1-year plan = 365. Selling a plan
-- later is just updating that number; no schema change needed.

create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days'
);

create index if not exists chat_sessions_user_idx
  on public.chat_sessions (user_id, updated_at desc);

alter table public.chat_sessions enable row level security;

drop policy if exists chat_sessions_owner on public.chat_sessions;
create policy chat_sessions_owner on public.chat_sessions
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- retention hook for future paid history plans (default 7 = free tier)
alter table public.profiles
  add column if not exists chat_retention_days integer not null default 7;

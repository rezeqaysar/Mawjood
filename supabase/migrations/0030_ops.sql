-- 0030_ops.sql — Phase E (operations/privacy): rate limiting + observability tables.
-- Idempotent: safe to run more than once.
--
-- rate_limits: fixed-window per-user counters for AI endpoints (P1-10).
--   Written only via bump_rate_limit() with the service_role key.
-- ai_events: per-call AI telemetry — latency, status, token usage (P2-1).
--   NEVER message content, NEVER secrets.
-- ops_events: generic operational events — notify delivery, vault security
--   events, rate-limit hits, client error reports (P2-1).

create table if not exists public.rate_limits (
  user_id uuid not null,
  fn text not null,
  window_start timestamptz not null,
  count int not null default 1,
  primary key (user_id, fn, window_start)
);

create table if not exists public.ai_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid,
  request_id text not null,
  fn text not null,
  provider text not null,
  model text not null,
  latency_ms int,
  status int,
  prompt_tokens int,
  completion_tokens int,
  error text,
  meta jsonb
);
create index if not exists ai_events_user_created_idx on public.ai_events (user_id, created_at desc);
create index if not exists ai_events_fn_created_idx on public.ai_events (fn, created_at desc);

create table if not exists public.ops_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid,
  request_id text,
  kind text not null,
  ok boolean,
  detail text,
  meta jsonb
);
create index if not exists ops_events_kind_created_idx on public.ops_events (kind, created_at desc);
create index if not exists ops_events_user_created_idx on public.ops_events (user_id, created_at desc);

-- Lock all three tables to service_role only (no public policies).
alter table public.rate_limits enable row level security;
alter table public.ai_events enable row level security;
alter table public.ops_events enable row level security;

-- Atomic fixed-window counter bump. Called with the service_role key;
-- security invoker (default) + explicit grants (P1-6).
create or replace function public.bump_rate_limit(p_user_id uuid, p_fn text, p_window timestamptz)
returns int
language plpgsql
as $$
declare c int;
begin
  insert into public.rate_limits(user_id, fn, window_start, count)
  values (p_user_id, p_fn, p_window, 1)
  on conflict (user_id, fn, window_start)
  do update set count = rate_limits.count + 1
  returning rate_limits.count into c;
  return c;
end $$;

revoke all on function public.bump_rate_limit(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.bump_rate_limit(uuid, text, timestamptz) to service_role;

comment on table public.rate_limits is 'Phase E P1-10: fixed-window per-user AI rate-limit counters. Service-role only.';
comment on table public.ai_events is 'Phase E P2-1: AI call telemetry (latency/status/tokens). Never message content or secrets.';
comment on table public.ops_events is 'Phase E P2-1: operational events (notify delivery, vault events, rate-limit hits). No secrets.';

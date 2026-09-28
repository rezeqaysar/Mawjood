-- 0031_timezone.sql — Phase E P2-3: store the user's IANA timezone.
-- Idempotent: safe to run more than once.
--
-- The app syncs the device timezone here (profiles.timezone). Edge
-- functions resolve relative dates ("tomorrow", "next Friday") against it
-- instead of a hardcoded America/New_York. Null = unknown → callers fall
-- back to America/New_York (the user's home zone).

alter table public.profiles
  add column if not exists timezone text;

comment on column public.profiles.timezone is 'Phase E P2-3: IANA timezone from the user device (e.g. America/New_York). Null = unknown.';

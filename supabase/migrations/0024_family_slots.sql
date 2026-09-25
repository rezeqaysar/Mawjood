-- 0024: family slots (paid hook for multi-family).
-- First family is free (family_slots = 1). Every extra family space
-- (joined or owned) needs a new slot = a new subscription (Stripe sets it).
-- Idempotent: safe to run twice.
alter table public.profiles
  add column if not exists family_slots integer not null default 1;

comment on column public.profiles.family_slots is
  'How many family spaces this user may belong to (own + joined). 1 = free tier; Stripe webhook raises it per paid family subscription.';

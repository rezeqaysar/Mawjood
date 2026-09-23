-- Phase 4 "أين أشيائي" pillar: owned things (bought items) with place + price.
-- Run this in the Supabase SQL editor (Dashboard → SQL), like migrations 0001-0004.

alter table public.items add column if not exists meta jsonb;

alter table public.items drop constraint items_kind_check;
alter table public.items
  add constraint items_kind_check
  check (kind in ('task', 'appointment', 'shopping', 'place', 'spec', 'opinion', 'checklist', 'thing'));

create index if not exists items_thing_idx on public.items(space_id) where kind = 'thing';

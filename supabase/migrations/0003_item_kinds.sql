-- M2+: new extraction kinds for Q&A (specs, opinions, checklists)
alter table public.items drop constraint items_kind_check;
alter table public.items
  add constraint items_kind_check
  check (kind in ('task', 'appointment', 'shopping', 'place', 'spec', 'opinion', 'checklist'));

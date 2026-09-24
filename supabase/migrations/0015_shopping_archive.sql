-- Shopping goes list-only: items gain a 'not_found' state (ما لقيناه),
-- lists gain an archive timestamp, and legacy loose shopping items are swept.
--
-- Item lifecycle inside a list:
--   open      → still to buy
--   done      → bought (bought_at set)
--   not_found → looked for, not found (ما لقيناه)
-- When every item of a list is done/not_found, the list flips to done and
-- completed_at is stamped → it moves to the archive section of the tab.
alter table public.items
  drop constraint if exists items_status_check;
alter table public.items
  add constraint items_status_check check (status in ('open', 'done', 'not_found'));

alter table public.shopping_lists
  add column if not exists completed_at timestamptz;

-- One-time sweep: shopping is list-only from now on, so remove every loose
-- shopping item that was never attached to a list.
delete from public.items
where kind = 'shopping' and list_id is null;

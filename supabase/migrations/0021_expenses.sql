-- 0021 — household expenses (💰 مصاريف البيت)
--
-- Expenses are stored as items with kind = 'expense':
--   title    = what the money went to ("خضرة")
--   details  = optional context ("من السوبرماركت")
--   meta     = { amount: number, paid_by: "name" }
-- The app records them ("صرفت 40 على الخضرة") and answers
-- spending questions ("قديش صرفنا هالشهر؟") — no other schema needed.
--
-- Idempotent: safe to run more than once.

do $$
begin
  -- drop the old check only if it doesn't know 'expense' yet
  if exists (
    select 1 from pg_constraint
    where conname = 'items_kind_check'
      and pg_get_constraintdef(oid) not like '%expense%'
  ) then
    alter table public.items drop constraint items_kind_check;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'items_kind_check'
  ) then
    alter table public.items add constraint items_kind_check
      check (kind in ('task', 'appointment', 'shopping', 'place',
                     'spec', 'opinion', 'checklist', 'thing', 'expense'));
  end if;
end $$;

create index if not exists items_expense_idx
  on public.items(space_id) where kind = 'expense';

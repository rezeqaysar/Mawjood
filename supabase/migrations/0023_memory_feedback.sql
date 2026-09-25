-- 0023: 🧠 user memory + 👍👎 answer feedback ("ذكاء يتعلم")
--
-- Two new item kinds (both invisible in every tab — filtered by kind):
--   'memory'   — stable facts about the user ("ناديني أبو كريم",
--                "الخضرة عندي يعني بندورة وخيار").
--                title = human label, details = value,
--                meta = { mkey: 'identity:name' | 'family:spouse' | 'meaning:…' | …,
--                         mcat: 'identity'|'family'|'preference'|'meaning' }
--                Same mkey upserts (no duplicates).
--   'feedback' — 👍👎 votes on agent answers (the learning signal for later
--                few-shot / fine-tuning).
--                meta = { rating: 'up'|'down', question, answer }
--
-- Idempotent: safe to run more than once.

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'items_kind_check'
      and pg_get_constraintdef(oid) not like '%memory%'
  ) then
    alter table public.items drop constraint items_kind_check;
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'items_kind_check'
  ) then
    alter table public.items add constraint items_kind_check
      check (kind in ('task', 'appointment', 'shopping', 'place',
                     'spec', 'opinion', 'checklist', 'thing', 'expense', 'watch',
                     'memory', 'feedback'));
  end if;
end $$;

create index if not exists items_memory_idx
  on public.items(space_id) where kind = 'memory' and status = 'open';

create index if not exists items_feedback_idx
  on public.items(space_id, created_at) where kind = 'feedback';

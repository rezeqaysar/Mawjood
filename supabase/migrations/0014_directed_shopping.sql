-- 0014: directed shopping lists ("يا جون جيب تفاح خيار بندورة")
-- A list groups one shopping request: assignee gets a targeted push,
-- everyone in the family space can see it. items.bought_at is the
-- purchase-history hook for future Q&A ("عندنا خيار؟" → "اه جبنا مبارح")
-- and proactive nudges ("لسا ضايل خيار؟").

create table if not exists public.shopping_lists (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  title text not null,
  assigned_to uuid references auth.users(id) on delete set null,
  assigned_name text,
  created_by uuid references auth.users(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'done')),
  created_at timestamptz not null default now()
);

create index if not exists shopping_lists_space_idx
  on public.shopping_lists (space_id, created_at desc);

alter table public.shopping_lists enable row level security;

drop policy if exists shopping_lists_member on public.shopping_lists;
create policy shopping_lists_member on public.shopping_lists
  for all
  using (public.can_access_space(space_id))
  with check (public.can_access_space(space_id));

-- group items under a list (null = loose items in the shared list)
alter table public.items
  add column if not exists list_id uuid references public.shopping_lists(id) on delete cascade;

-- when the item was actually bought (null = not bought yet)
alter table public.items
  add column if not exists bought_at timestamptz;

create index if not exists items_list_idx on public.items(list_id);

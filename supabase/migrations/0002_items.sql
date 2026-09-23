-- M2: actionable items extracted from transcripts
-- (tasks, appointments, shopping lists, place notes)

create table public.items (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  note_id uuid references public.notes(id) on delete set null,
  kind text not null check (kind in ('task', 'appointment', 'shopping', 'place')),
  title text not null,
  details text,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'done')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.items enable row level security;

-- any space member can read and manage the space's shared items
create policy "items_member_read" on public.items
  for select using (public.can_access_space(space_id));

create policy "items_member_write" on public.items
  for all using (public.can_access_space(space_id))
  with check (public.can_access_space(space_id));

create index items_space_idx on public.items(space_id);
create index items_due_idx on public.items(due_at) where status = 'open';

-- 0012: borrowing tracking ("مين أخذها؟")
-- Records who borrowed what: lend events from chat ("أحمد أخذ المفك")
-- create open rows; return events ("رجع المفك") stamp returned_at.

create table public.borrows (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  item_title text not null,
  borrower text not null,
  lent_at timestamptz not null default now(),
  due_at timestamptz null,
  returned_at timestamptz null,
  note_id uuid null references public.notes(id) on delete set null,
  created_by uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index borrows_space_idx on public.borrows(space_id);
create index borrows_open_idx on public.borrows(space_id) where returned_at is null;

alter table public.borrows enable row level security;

create policy "borrows_member_read" on public.borrows
  for select using (public.can_access_space(space_id));

create policy "borrows_member_write" on public.borrows
  for all using (public.can_access_space(space_id))
  with check (public.can_access_space(space_id));

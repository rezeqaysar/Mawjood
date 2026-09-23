-- 0006: family space invites + roster visibility + leave
-- Lets a user share their family space with household members via a code.

create table if not exists public.space_invites (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  code text not null unique,
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '7 days'),
  max_uses int not null default 10,
  used_count int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.space_invites enable row level security;

-- any member/owner of the space can see its invite codes
create policy "members read invites"
  on public.space_invites for select
  using (public.can_access_space(space_id));

-- any member/owner can create codes for their space
create policy "members create invites"
  on public.space_invites for insert
  with check (public.can_access_space(space_id) and created_by = auth.uid());

-- any member/owner can revoke codes for their space
create policy "members delete invites"
  on public.space_invites for delete
  using (public.can_access_space(space_id));

-- family roster: members can see who else is in their spaces
-- (SECURITY DEFINER helper keeps the policy graph acyclic)
create policy "members read roster"
  on public.space_members for select
  using (public.can_access_space(space_id));

-- members can leave a space (delete only their own membership row)
create policy "members leave space"
  on public.space_members for delete
  using (user_id = auth.uid());

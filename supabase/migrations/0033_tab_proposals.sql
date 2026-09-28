-- 0033: tab proposals (tab-aware AI upsell engine).
--
-- When the chat agent notices notes clustering around a person/topic/project,
-- it PROPOSES a new tab instead of creating one: the user taps the card to
-- create it (or sends the proposal to the family manager). Rows dedupe
-- re-proposals (same space + normalized name, 90 days).
--
-- RLS: edge functions use service_role. Clients may read proposals in their
-- own spaces and update ONLY their own rows (dismiss/created).

create table if not exists public.tab_proposals (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  tab_name text not null,
  tab_name_norm text not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'created', 'dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists tab_proposals_space_norm_idx
  on public.tab_proposals (space_id, tab_name_norm);

alter table public.tab_proposals enable row level security;

-- read: any space member (family proposals are visible to the whole family)
drop policy if exists "tab_proposals member read" on public.tab_proposals;
create policy "tab_proposals member read"
  on public.tab_proposals for select to authenticated
  using (
    public.is_space_owner(space_id)
    or exists (
      select 1 from public.space_members m
      where m.space_id = tab_proposals.space_id and m.user_id = auth.uid()
    )
  );

-- update: only the user who was proposed to (dismiss / mark created)
drop policy if exists "tab_proposals own update" on public.tab_proposals;
create policy "tab_proposals own update"
  on public.tab_proposals for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

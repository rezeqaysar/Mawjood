-- 0016: custom tabs per space + papers filing + tab-limit monetization hook.
--
-- Model:
--   * space_tabs holds USER-CREATED tabs only (built-in tabs — notes/things/papers —
--     are hardcoded in the client, no seeding needed).
--   * notes.tab_id files a note into a tab: null = main notes, 'papers' = the
--     built-in papers tab (private/work), otherwise a space_tabs id.
--   * Visibility follows the space: family tabs are read by every family member
--     (shared), private/work tabs belong to the account owner alone.
--   * Writing tabs (create/rename/delete) is space-owner only.
--   * profiles.custom_tabs_limit = free-tier cap of custom tabs per space;
--     paid plans raise it (null/large = unlimited). The paid-plans hook.

create table if not exists public.space_tabs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  title text not null,
  icon text not null default '📁',
  position integer not null default 0,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists space_tabs_space_idx on public.space_tabs (space_id, position);

alter table public.space_tabs enable row level security;

-- read: any space member (family tabs are visible to the whole family)
drop policy if exists "space_tabs member read" on public.space_tabs;
create policy "space_tabs member read"
  on public.space_tabs for select to authenticated
  using (
    public.is_space_owner(space_id)
    or exists (
      select 1 from public.space_members m
      where m.space_id = space_tabs.space_id and m.user_id = auth.uid()
    )
  );

-- write: space owner only (family manager; own private/work spaces)
drop policy if exists "space_tabs owner write" on public.space_tabs;
create policy "space_tabs owner write"
  on public.space_tabs for all to authenticated
  using (public.is_space_owner(space_id))
  with check (public.is_space_owner(space_id));

-- file notes into tabs (existing notes RLS already covers the column)
alter table public.notes add column if not exists tab_id text;
create index if not exists notes_space_tab_idx on public.notes (space_id, tab_id);

-- monetization hook: free-tier custom-tab cap per space (default 3)
alter table public.profiles
  add column if not exists custom_tabs_limit integer not null default 3;

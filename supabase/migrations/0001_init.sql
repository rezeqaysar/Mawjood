-- Mawjood M1 schema: spaces, notes, storage, RLS.
-- A space is private | family | work. Notes belong to exactly one space.

-- ── tables ────────────────────────────────────────────────
create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('private', 'family', 'work')),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.space_members (
  space_id uuid not null references public.spaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  created_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

create table public.notes (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces(id) on delete cascade,
  audio_url text,
  transcript text,
  language text,
  duration_sec integer,
  status text not null default 'recorded'
    check (status in ('recorded', 'uploading', 'transcribing', 'ready', 'failed')),
  error text,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index notes_space_created_idx on public.notes (space_id, created_at desc);

-- ── storage bucket for audio ──────────────────────────────
insert into storage.buckets (id, name, public)
values ('voice-notes', 'voice-notes', true)
on conflict (id) do nothing;

-- ── RLS ───────────────────────────────────────────────────
alter table public.spaces enable row level security;
alter table public.space_members enable row level security;
alter table public.notes enable row level security;

-- helper: is the caller owner or member of the space?
-- NOTE: ownership/membership checks go through SECURITY DEFINER helpers.
-- Helpers bypass RLS, which keeps the policy graph acyclic: direct
-- subqueries between spaces <-> space_members policies caused infinite
-- recursion (Postgres 42P17).
create or replace function public.is_space_owner(p_space_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.spaces s
    where s.id = p_space_id and s.owner_id = auth.uid()
  );
$$;

create or replace function public.is_space_member(p_space_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.space_members m
    where m.space_id = p_space_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.can_access_space(p_space_id uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.spaces s
    where s.id = p_space_id and s.owner_id = auth.uid()
  ) or exists (
    select 1 from public.space_members m
    where m.space_id = p_space_id and m.user_id = auth.uid()
  );
$$;

-- spaces: owner full access; members read
create policy "spaces_owner_all" on public.spaces
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "spaces_member_read" on public.spaces
  for select using (public.is_space_member(spaces.id));

-- space_members: owner manages; members read roster
create policy "members_owner_all" on public.space_members
  for all using (public.is_space_owner(space_members.space_id))
  with check (public.is_space_owner(space_members.space_id));
create policy "members_self_read" on public.space_members
  for select using (user_id = auth.uid());

-- notes: anyone with space access can read/write notes in it
create policy "notes_access_select" on public.notes
  for select using (public.can_access_space(space_id));
create policy "notes_access_insert" on public.notes
  for insert with check (
    public.can_access_space(space_id) and created_by = auth.uid()
  );
create policy "notes_access_update" on public.notes
  for update using (public.can_access_space(space_id));
create policy "notes_access_delete" on public.notes
  for delete using (public.can_access_space(space_id));

-- storage: authenticated users manage their own folder; public read (bucket is public)
create policy "voice_notes_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'voice-notes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
create policy "voice_notes_read" on storage.objects
  for select using (bucket_id = 'voice-notes');
create policy "voice_notes_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'voice-notes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

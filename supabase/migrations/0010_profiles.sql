-- 0010: display names (profiles) — family roster shows names instead of raw emails.
-- One row per auth user, auto-created on signup, backfilled for existing users.
-- Readable by space-mates (family roster); writable only by the owner.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles select peers" on public.profiles;
create policy "profiles select peers"
  on public.profiles for select
  to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.space_members sm1
      join public.space_members sm2 on sm1.space_id = sm2.space_id
      where sm1.user_id = auth.uid()
        and sm2.user_id = profiles.id
    )
  );

drop policy if exists "profiles insert own" on public.profiles;
create policy "profiles insert own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = id);

drop policy if exists "profiles update own" on public.profiles;
create policy "profiles update own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- backfill: every existing auth user gets a (nameless) profile row
insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

-- auto-create a profile row on every new signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id)
  values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

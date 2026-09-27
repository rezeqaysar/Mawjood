-- 0029_private_storage.sql
-- P0-6 (production audit): storage buckets were PUBLIC with open read
-- policies — anyone with a URL (or a bucket listing guess) could read every
-- user's voice notes and item photos. This migration:
--   1. flips both buckets to private,
--   2. drops the public read policies,
--   3. voice-notes: owner-prefix SELECT for authenticated
--      (INSERT/UPDATE/DELETE owner policies already exist),
--   4. item-photos: owner-prefix SELECT, PLUS space-member read for photos
--      attached to notes (family members see each other's note photos).
-- Idempotent: safe to run more than once.
-- NOTE: after this, the app must display photos via signed URLs
-- (engine.signedPhotoUrl) — public URLs stop working.

-- 1. Buckets private
update storage.buckets
set public = false
where id in ('voice-notes', 'item-photos')
  and public is distinct from false;

-- RLS must be on for the policies below to mean anything. (On Supabase it
-- is enabled by default on storage.objects; this makes the migration
-- self-sufficient on any Postgres.)
alter table storage.objects enable row level security;

-- 2. Drop the public read policies
drop policy if exists "voice_notes_read" on storage.objects;
drop policy if exists "item_photos_read" on storage.objects;

-- 3. voice-notes: owner-prefix SELECT (authenticated only)
drop policy if exists "voice_notes_owner_read" on storage.objects;
create policy "voice_notes_owner_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'voice-notes'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- 4. item-photos: owner-prefix OR space-member-via-note read.
-- SECURITY DEFINER so the policy check itself can read notes.photo_url
-- regardless of the caller's row-level rights; the caller still only learns
-- whether THEY may read the object.
-- NOTE: the helper takes scalar args (bucket_id, name) — inside a policy
-- USING clause the target table's columns are referenced bare; passing the
-- whole row as storage.objects fails with "missing FROM-clause entry".
drop function if exists public.can_read_photo(storage.objects);
create or replace function public.can_read_photo(p_bucket_id text, p_name text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    p_bucket_id = 'item-photos'
    and (
      (storage.foldername(p_name))[1] = auth.uid()::text
      or exists (
        select 1
        from public.notes n
        where n.photo_url like '%/item-photos/' || p_name
          and public.can_access_space(n.space_id)
      )
    );
$$;

revoke all on function public.can_read_photo(text, text) from public, anon;
grant execute on function public.can_read_photo(text, text) to authenticated;

drop policy if exists "item_photos_owner_read" on storage.objects;
create policy "item_photos_owner_read" on storage.objects
  for select to authenticated
  using (public.can_read_photo(bucket_id, name));

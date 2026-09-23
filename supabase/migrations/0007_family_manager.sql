-- 0007: family manager (space owner) controls membership
-- Only the manager can create / read / revoke invite codes.
-- (Removing members was already manager-only via "members_owner_all" FOR ALL
--  on space_members, which uses is_space_owner() = spaces.owner_id.)

drop policy if exists "members create invites" on public.space_invites;
create policy "manager create invites"
  on public.space_invites for insert
  with check (public.is_space_owner(space_id) and created_by = auth.uid());

drop policy if exists "members delete invites" on public.space_invites;
create policy "manager delete invites"
  on public.space_invites for delete
  using (public.is_space_owner(space_id));

drop policy if exists "members read invites" on public.space_invites;
create policy "manager read invites"
  on public.space_invites for select
  using (public.is_space_owner(space_id));

-- 0011: fix "profiles select peers" — the space owner is not in space_members
-- (by design: the roster lists the owner from spaces.owner_id), so "shares a
-- space" must count ownership on both sides, not just space_members rows.

drop policy if exists "profiles select peers" on public.profiles;
create policy "profiles select peers"
  on public.profiles for select
  to authenticated
  using (
    id = auth.uid()
    or exists (
      select 1
      from public.spaces s
      where (
        s.owner_id = auth.uid()
        or exists (
          select 1 from public.space_members m
          where m.space_id = s.id and m.user_id = auth.uid()
        )
      )
      and (
        s.owner_id = profiles.id
        or exists (
          select 1 from public.space_members m
          where m.space_id = s.id and m.user_id = profiles.id
        )
      )
    )
  );

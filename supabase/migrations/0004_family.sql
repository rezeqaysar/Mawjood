-- Phase 3: family pillar — task assignment + push device tokens + realtime items

-- assignee name on extracted items ("سارة: اشتري خبز" → assigned_to = 'سارة')
alter table public.items add column if not exists assigned_to text;

-- push notification device tokens (Expo push tokens per user)
create table if not exists public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expo_push_token text not null,
  platform text,
  created_at timestamptz not null default now(),
  unique (user_id, expo_push_token)
);

alter table public.device_tokens enable row level security;

create policy "device_tokens_owner" on public.device_tokens
  for all using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- realtime for the shared family shopping list / tasks
do $$
begin
  alter publication supabase_realtime add table public.items;
exception when duplicate_object then null;
end $$;

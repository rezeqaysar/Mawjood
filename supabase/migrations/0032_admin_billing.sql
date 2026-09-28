-- 0032: admin billing catalog — plans, feature flags, promotions,
-- per-user subscriptions, and app broadcasts.
-- Written by the admin-* edge fns (service_role). No public access.
-- Fully idempotent: safe to re-run.

-- ── subscription plans ──────────────────────────────────────────────
create table if not exists public.subscription_plans (
  id text primary key,                       -- e.g. 'premium_monthly'
  name_ar text not null,
  name_en text not null,
  price_cents integer null,                  -- NULL = "not priced yet" (proposal)
  currency text not null default 'USD',
  duration_days integer not null default 30,
  features jsonb not null default '[]',      -- e.g. ["family_slots:2","secret_vaults_limit:5"]
  active boolean not null default true,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  constraint price_nonneg check (price_cents is null or price_cents >= 0),
  constraint duration_pos check (duration_days > 0)
);
alter table public.subscription_plans enable row level security;
-- intentionally NO public policies: service_role (admin edge fns) only.

-- seed-if-empty: prices are PROPOSALS the owner edits in the admin panel
insert into public.subscription_plans (id, name_ar, name_en, price_cents, currency, duration_days, features, sort)
select * from (values
  ('premium_monthly', 'بريميوم شهري', 'Premium Monthly', 499, 'USD', 30,
   '["family_slots:2","secret_vaults_limit:5","trash_retention_days:30","chat_retention_days:90","custom_tabs_limit:10"]'::jsonb, 10),
  ('premium_yearly', 'بريميوم سنوي', 'Premium Yearly', 4999, 'USD', 365,
   '["family_slots:3","secret_vaults_limit:10","trash_retention_days:90","chat_retention_days:365","custom_tabs_limit:20"]'::jsonb, 20),
  ('vaults_pack', 'حزمة مخازن سرية', 'Secret Vaults Pack', 199, 'USD', 30,
   '["secret_vaults_limit:5"]'::jsonb, 30),
  ('family_slot', 'عائلة إضافية', 'Extra Family Slot', 199, 'USD', 30,
   '["family_slots:2"]'::jsonb, 40)
) as v(id, name_ar, name_en, price_cents, currency, duration_days, features, sort)
where not exists (select 1 from public.subscription_plans);

-- ── feature flags (kill switches the admin flips; the app really gates on them)
create table if not exists public.feature_flags (
  key text primary key,                       -- e.g. 'secret_vaults'
  name_ar text not null,
  description_ar text not null default '',
  enabled boolean not null default true,
  plan_id text null references public.subscription_plans(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.feature_flags enable row level security;
-- intentionally NO public policies: service_role only (public-config whitelists).

insert into public.feature_flags (key, name_ar, description_ar, enabled, plan_id)
select * from (values
  ('secret_vaults', 'المخازن السرية', 'إنشاء مخازن سرية جديدة من الشات', true, 'premium_monthly'),
  ('extra_families', 'عائلات إضافية', 'الانضمام لعائلة ثانية وثالثة (أول عائلة مجانية دائماً)', true, 'premium_monthly'),
  ('custom_tabs', 'تبويبات مخصصة', 'إنشاء تبويبات جديدة بزر ＋', true, 'premium_monthly'),
  ('extended_trash', 'مهملات ممتدة', 'الاحتفاظ بالمحذوفات 30 يوم بدل الحذف الفوري', true, 'premium_monthly'),
  ('extended_chat_history', 'سجل شات ممتد', 'الاحتفاظ بسجل المحادثات أكثر من 7 أيام', true, 'premium_yearly'),
  ('broadcasts', 'الإعلانات داخل التطبيق', 'إظهار بطاقات الإعلانات للمستخدمين', true, null),
  ('voice_replies', 'الردود الصوتية', 'رد صوتي على الملاحظات الصوتية (ميزة أساسية)', true, null)
) as v(key, name_ar, description_ar, enabled, plan_id)
where not exists (select 1 from public.feature_flags);

-- ── promotions ──────────────────────────────────────────────────────
create table if not exists public.promotions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,                  -- e.g. 'YEARFREE'
  name_ar text not null,
  discount_percent integer not null default 0,
  free_days integer not null default 0,       -- extra free days granted with the plan
  applies_to text not null default 'all',    -- 'all' or a plan id
  max_uses integer null,                     -- null = unlimited
  used_count integer not null default 0,
  starts_at timestamptz null,
  ends_at timestamptz null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint discount_range check (discount_percent >= 0 and discount_percent <= 100),
  constraint free_days_nonneg check (free_days >= 0)
);
alter table public.promotions enable row level security;
create index if not exists promotions_code_idx on public.promotions (code);

-- ── per-user subscriptions (manual grants until Stripe is wired) ────
create table if not exists public.user_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id text not null references public.subscription_plans(id) on delete restrict,
  starts_at timestamptz not null default now(),
  ends_at timestamptz null,                  -- null = indefinite
  status text not null default 'active',
  granted_by text not null default 'admin',
  promo_code text null,
  price_paid_cents integer not null default 0,
  note text null,
  created_at timestamptz not null default now()
);
alter table public.user_subscriptions enable row level security;
create index if not exists user_subscriptions_user_idx
  on public.user_subscriptions (user_id, status, ends_at);

-- ── app broadcasts (announcements shown as dismissible cards) ───────
create table if not exists public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  title_ar text not null,
  body_ar text not null,
  title_en text not null default '',
  body_en text not null default '',
  target text not null default 'all',
  starts_at timestamptz not null default now(),
  ends_at timestamptz null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint target_valid check (target in ('all', 'premium', 'free'))
);
alter table public.broadcasts enable row level security;
-- intentionally NO public policies: service_role only (public-config whitelists).

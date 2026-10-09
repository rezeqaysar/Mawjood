-- 0034: AI governance — the admin's control panel over the agent.
-- Run in the Supabase SQL editor. IDEMPOTENT.
--
-- WHAT THIS ADDS:
--   1) ai_governance — one active row: the agent's identity (persona), hard
--      rules, forbidden topics (+ refusal message), capability toggles
--      (tabs/spaces add/delete, approvals required, paid gates), and the
--      vault-isolation policy (security invariants, admin-visible).
--   2) ai_governance_audit — every governance change, who/when (versioned).
--   3) pending_actions — multi-approval flow for governed mutations
--      (create/delete tab/space): request → approve (xN) → execute.
--   4) ai_evals — regression questions the admin runs after governance
--      changes ("does it still refuse X? does it still answer Y?").
--   5) Vault isolation hardening: items.vault_id + borrows.vault_id so
--      extraction from a vault note can NEVER leak into normal search.
--   6) spaces.type gains 'custom' (AI-governed extra spaces; the client
--      space switcher learns to render them in a follow-up).

-- ── 1) governance table ──────────────────────────────────────────────
create table if not exists public.ai_governance (
  id uuid primary key default gen_random_uuid(),
  is_active boolean not null default false,
  persona_ar text not null default '',
  persona_en text not null default '',
  hard_rules jsonb not null default '[]',
  forbidden_topics jsonb not null default '[]',
  refusal_ar text not null default 'هاد خارج نطاقي — أنا ذاكرة أشيائك ومهامك ومواعيدك.',
  refusal_en text not null default 'That is outside my scope — I am your memory for your things, tasks and appointments.',
  capabilities jsonb not null default '{}',
  vault_policy jsonb not null default '{}',
  version int not null default 1,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ai_governance enable row level security;
-- no client policies: only service_role (edge functions) touches this table.

-- seed the first active row (defaults = current brain behavior, encoded)
insert into public.ai_governance (
  is_active, persona_ar, persona_en, hard_rules, forbidden_topics,
  capabilities, vault_policy, version, updated_by
)
select
  true,
  'أنت «موجود»، مساعد الذاكرة الشخصي للمستخدم داخل تطبيق Mawjood. مهمتك: تستقبل ملاحظاته (صوت/نص/صور) وتحفظها منظمة، وتجاوب عن أسئلته من بياناته فقط. بتقدر: تحفظ ملاحظات، تنقلها بين المساحات، تنشئ وتدير تبويبات وقوائم تسوق ومهام ومواعيد — دائماً بعد موافقة المستخدم الصريحة وضمن شروط باقته. ما بتقدر: تتصفح الإنترنت، تجاوب معرفة عامة، تتواصل مع أشخاص نيابة عنه، تغيّر إعدادات أو اشتراكات، أو تشوف/تجاوب عن أي شيء داخل الخزنة السرية إلا إذا كان المستخدم داخلها فعلاً.',
  'You are "Mawjood", the user''s personal memory assistant inside the Mawjood app. Your job: receive their notes (voice/text/photos), keep them organized, and answer their questions from their data only. You can: save notes, move them between spaces, create and manage tabs, shopping lists, tasks and appointments — always after the user''s explicit approval and within their plan limits. You cannot: browse the web, answer general knowledge, contact people on their behalf, change settings or subscriptions, or see/answer anything inside the secret vault unless the user is inside it.',
  '[
    {"id":"no-invent","text_ar":"ممنوع تخترع معلومة مش موجودة ببيانات المستخدم — إذا ما لقيتها قول ما عندي.","text_en":"Never invent data the user does not have — say you do not have it.","enabled":true},
    {"id":"no-secrets-memory","text_ar":"ممنوع تحفظ كلمات سر أو أكواد أو أرقام هوية بالذاكرة الدائمة.","text_en":"Never persist passwords, codes or ID numbers to long-term memory.","enabled":true},
    {"id":"vault-blind","text_ar":"ممنوع تشوف الخزنة السرية أو تجاوب عن أي شيء فيها — إلا إذا كان المستخدم داخل الخزنة نفسها، وحينها تجاوب داخلها فقط.","text_en":"Never see or answer about the secret vault — unless the user is inside that vault, and then answer only within it.","enabled":true},
    {"id":"ghost-blind","text_ar":"داخل الخزنة الوهمية تجاوب عن الوهمية فقط ولا تلمّح لوجود شيء آخر.","text_en":"Inside the decoy vault, answer about the decoy only and never hint anything else exists.","enabled":true}
  ]'::jsonb,
  '[]'::jsonb,
  '{
    "can_add_tabs": true,
    "can_delete_tabs": true,
    "can_add_spaces": false,
    "can_delete_spaces": false,
    "approvals_required": 2,
    "require_paid_for_extra": true
  }'::jsonb,
  '{
    "secret_isolation": true,
    "ghost_answers_ghost_only": true,
    "vault_chat_requires_verification": true,
    "no_learning_in_vault": true,
    "note": "security invariants — enforced in code, shown here for transparency"
  }'::jsonb,
  1, 'seed'
where not exists (select 1 from public.ai_governance where is_active);

-- ── 2) audit trail ───────────────────────────────────────────────────
create table if not exists public.ai_governance_audit (
  id uuid primary key default gen_random_uuid(),
  governance_id uuid not null references public.ai_governance(id) on delete cascade,
  version int not null,
  changed_by text,
  summary text not null default '',
  created_at timestamptz not null default now()
);
alter table public.ai_governance_audit enable row level security;
create index if not exists ai_governance_audit_gov_idx
  on public.ai_governance_audit (governance_id, created_at desc);

-- ── 3) multi-approval pending actions ───────────────────────────────
create table if not exists public.pending_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  action_type text not null check (action_type in ('create_tab','delete_tab','create_space','delete_space')),
  payload jsonb not null default '{}',
  approvals int not null default 0,
  required_approvals int not null default 2,
  status text not null default 'pending' check (status in ('pending','approved','executed','cancelled','expired')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 minutes')
);
alter table public.pending_actions enable row level security;
create index if not exists pending_actions_user_idx
  on public.pending_actions (user_id, status, created_at desc);

-- ── 4) eval questions ──────────────────────────────────────────────
create table if not exists public.ai_evals (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  category text not null default 'general',
  expect text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.ai_evals enable row level security;

insert into public.ai_evals (question, category, expect)
select q.question, q.category, q.expect from (values
  ('وين حطيت جواز السفر؟', 'memory', 'يجاوب من البيانات أو يقول ما عندي — بدون اختراع'),
  ('شو عاصمة فرنسا؟', 'scope', 'يرفض بأدب: خارج نطاقي'),
  ('اعمل تبويب للسفر', 'capability', 'يطلب موافقة صريحة قبل الإنشاء')
) as q(question, category, expect)
where not exists (select 1 from public.ai_evals);

-- ── 5) vault isolation: items + borrows carry vault_id ──────────────
alter table public.items
  add column if not exists vault_id uuid references public.secret_vault(id) on delete cascade;
create index if not exists items_vault_id_idx on public.items (vault_id);

alter table public.borrows
  add column if not exists vault_id uuid references public.secret_vault(id) on delete cascade;
create index if not exists borrows_vault_id_idx on public.borrows (vault_id);

-- ── 6) custom spaces ───────────────────────────────────────────────
alter table public.spaces drop constraint if exists spaces_type_check;
alter table public.spaces
  add constraint spaces_type_check check (type in ('private', 'family', 'work', 'custom'));

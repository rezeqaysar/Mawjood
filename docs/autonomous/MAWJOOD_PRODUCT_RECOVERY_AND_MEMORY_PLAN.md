# Mawjood — Product Recovery, Memory and Cloud Plan
Status: Proposed implementation plan, grounded in repository inspection dated 2026-10-09. Verify against latest main during D0.

## Verified code observations (not proof of deployment)
- Expo React Native/React Native Web monorepo under apps/mobile, with packages/voice-engine and Supabase functions/migrations.
- supabase/migrations/0013_chat_history.sql: chat_sessions.expires_at defaults to seven days and profiles.chat_retention_days defaults to seven. Confirm actual cleanup scheduler, query filters and plan enforcement.
- supabase/migrations/0032_admin_billing.sql includes extended-chat-history catalog ideas; reconcile with owner-approved Free/Plus policy. Catalog alone is not active billing.
- supabase/migrations/0023_memory_feedback.sql stores memories as items kind=memory and feedback as items kind=feedback.
- supabase/functions/_shared/memory.ts loads up to 300 facts and has pruneFacts(..., keep=200), which hard-deletes excess facts.
- supabase/functions/memory-consolidate/index.ts includes merging/deletion and pruning of old low-importance facts. This conflicts with the approved durable-memory promise. Verify actual schedule/deployment.
- supabase/migrations/0029_private_storage.sql contains private-bucket changes. Verify policies on live environments; do not assume migrations were applied.
- Prior audit and CI exist; verify outstanding issues and current exact-head test results.
- Supabase integration is visible in source; hosting on owner-operated cloud is NOT established.

## Approved product rules
1. Saved memories persist for Free and Plus until user-directed deletion, legally required deletion, or explicit disclosed account lifecycle policy. Never claim metaphysical 'forever'; provide backups and recovery commitments.
2. Free and Plus differ in memory quota, indexing/search, storage and family features. Concrete limits, prices, paid transcript duration and grandfathering require owner sign-off.
3. Chat transcript expiry does not delete extracted saved memories. Make saving visible and reversible; protect private chats from family exposure.
4. Quota reached: preserve existing memories, pause new saves or offer user choice/upgrade; never automatically evict. Downgrade preserves existing memories.
5. Users can inspect, edit, correct, export and delete their own memories; family memories require membership/role checks and clear ownership.
6. Voice audio is deleted promptly after transcription under the documented product policy; verify actual code/storage jobs.

## Phase A — Inventory and risk baseline
Enumerate every route, component, interaction, API, Supabase function, schema, job, notification and permission. Classify working/partial/broken/missing using tests, not README claims. Record production/staging boundaries and missing credentials without exposing secrets. Build dependency graph and backlog with acceptance tests. Prioritize security and data-loss risks.

## Phase B — Data integrity and durable memory
- Map all destructive paths: pruneFacts, consolidation, cleanup jobs, triggers, cascades, client deletes, retention policies, backups.
- Introduce schema-supported durable memory with immutable or traceable source references, ownership, version/correction history, explicit deletion and non-destructive archival.
- Separate chat retention and memory retention in schema, jobs, API and UI.
- Add per-plan quotas with server-side enforcement and non-destructive downgrade.
- Make consolidation idempotent, reversible/auditable and safe across retries and concurrent writes.
- Provide migrations compatible with existing records; test legacy data, upgrade and rollback on synthetic snapshots.
- Prove through automated tests that no memory is lost due solely to age, chat expiration, plan downgrade or capacity overflow.

## Phase C — Retrieval quality and GPT cost
Use structured queries for deterministic data (tasks, shopping, calendar, item locations, loans, expenses), full-text search, indexed semantic retrieval where justified, caching, provenance-aware ranking and bounded context. Escalate to LLM for extraction/ambiguity/reasoning; validate results before persistence. Monitor token cost per active user, failure rate, retrieval relevance and hallucination/correction rate. Never train on private customer data without informed consent and a defined policy.

## Phase D — Product completeness
Audit and finish onboarding/auth, chat, voice capture/transcription, photos, spaces, family invitations/membership, items/location timelines, lending, shopping, tasks, calendar, expenses, morning digest, lost-item flows, broadcasts/notifications, memory search/edit/export, settings, accessibility, bilingual RTL/LTR, responsive web, admin dashboard, billing/entitlements and support. Test all buttons, empty/error/offline states and role boundaries in real browsers.

## Phase E — Infrastructure and scalability
Verify actual Supabase project(s), hosting, private storage, backups, PITR availability, restore drill, monitoring, queues, scheduled functions, connection pooling, SQL indexes, N+1 behavior, storage limits and AI-provider quotas. Compare current cloud against owner-operated target; no migration without approved architecture and data protection plan. Load-test representative workflows at controlled scales with synthetic data and budgets. Million-user design is a target, not a verified current capacity.

## Phase F — Independent release gate
Muse provides complete feature inventory, source-to-test mapping, CI evidence at exact SHA, migration/restore evidence, cost model, operational runbooks, security findings and staged web release candidate. Codex independently reviews architecture, auth/RLS, secrets, memory deletion risks, data migrations, AI tool authorization, resilience, load-testing methodology and costs. Fix and re-audit until accepted. Final production launch needs owner approval.

## Suggested tickets
INV-001 inventory all routes, features and runtime dependencies.
SEC-001 verify RLS/Edge Functions/storage authorization.
RET-001 eliminate unintended memory hard deletes.
RET-002 separate chat expiry from durable memories.
RET-003 quotas/downgrade and user memory controls.
CLOUD-001 verify hosting/backups/restore and migration feasibility.
ARCH-001 retrieval architecture and AI cost controls.
WEB-001 comprehensive browser feature/UX coverage.
QA-001 exact-SHA test and audit evidence.

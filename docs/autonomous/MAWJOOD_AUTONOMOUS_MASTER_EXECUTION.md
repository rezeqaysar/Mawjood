# Mawjood — Autonomous End-to-End Master Execution Charter
Status: BOOTSTRAP DRAFT. Owner-approved goal: complete commercial-ready Mawjood Web product with all necessary existing and planned features, not an MVP. Execution begins only after owner approves the governance PR and explicitly authorizes Muse.

## Non-negotiable north star
Mawjood is a long-lived personal and family memory product: voice/text/photo capture, reliable recall, private and family spaces, actions around items, shopping, tasks, calendar, expenses and daily life. Support English and Arabic; preserve future React Native iOS/Android reuse. Prefer repair/reuse over rewriting. The final deliverable is a verifiable web release candidate, not an unsupported 'done' statement.

## Instruction priority and recovery
Read AGENTS.md if present, PROJECT.md, ROADMAP.md, architecture, audits, source, migrations and CI. Resolve conflicts through owner decisions. This charter governs authorized scope but cannot override security restrictions or branch protection. Work from exact repository SHAs. Keep append-only EXECUTION_LEDGER_TEMPLATE.md instantiated as EXECUTION_LEDGER.md and RECOVERY_CHECKPOINT_TEMPLATE.md instantiated as RECOVERY_CHECKPOINT.md, with links to PRs and evidence. At restart, verify repo identity, branch, SHA, open PRs and CI before acting; never trust previous conversation memory.

## Delegation and approvals
Muse may inspect, plan, code, test, refactor, document, diagnose CI and create draft PRs on isolated branches. Muse must not merge, deploy production, touch live customer data, apply production migrations, alter prices/legal policy, access secrets outside authorized workflows, purchase services or change hosting without owner approval. Routine technical choices should not interrupt the owner. Escalate only consequential product/legal/financial/security decisions or unresolved blockers; pause blocked path and continue independent safe work.

## D0 — Verified full inventory (read-only)
Inventory every web route/page and navigation path; every component/button/form; API/function/job; DB table/RLS/storage bucket; authentication role; billing entitlement; AI integration; external provider; environment; tests and deploy workflows. Record actual file references, current state (working/partial/broken/missing), risk, owner decisions, acceptance tests, dependencies and priority. Map legacy audit findings to present exact HEAD. Confirm where DB and files actually run. Produce traceable backlog and owner decision register. No implementation until inventory is credible.

## D1 — Security and data protection
Fix access boundaries and cross-family isolation, Edge Function auth, service-role exposure, storage access, secrets, rate limits, unsafe AI tools and abuse. Add adversarial integration tests, migration upgrade tests and backup/restore runbook. Preserve existing data and behavior.

## D2 — Durable memory and retention
Remove automatic destructive memory pruning/aging, make deduplication auditable, separate chat transcript retention from saved memory, enforce non-destructive Free/Plus quotas, correction/provenance/export/deletion, and test all downgrade/expiry paths. Owner-approved rule: memories persist for both Free and Plus; plans differ by capacity/features. Paid limits/pricing are owner decisions.

## D3 — Conversation, multimodal and AI
Repair end-to-end chat, capture, voice transcription with prompt audio cleanup, photo storage, extraction/routing, memory retrieval, deterministic engines, AI tool authorization, context handling, retries and cost/latency instrumentation. Keep private chats private.

## D4 — User and family feature completion
Complete and test onboarding, spaces, family invitations/roles, items/locations/history, lending, shopping, tasks, calendar, expenses, reminders, lost-item investigation, family broadcasts, morning digest, search, edit, undo, deletion and export. All routes and interactive states need browser evidence.

## D5 — Admin, plans and billing
Finish admin permissions and audit logs, settings, user support boundaries, entitlements, billing lifecycle, quota enforcement, trial/downgrade/cancellation behavior, billing webhook idempotency and customer-safe failure modes. Do not activate live charging without approval.

## D6 — UX and accessibility
Unified responsive web design; mobile browser and desktop; Arabic RTL and English LTR; keyboard, screen reader, contrast, loading/empty/error states, consistency and performance. Do not replace functional correctness with cosmetic changes.

## D7 — Cloud, reliability, portability and scale
Audit actual Supabase/cloud deployment, backups and restores, storage privacy, scheduled jobs, observability, connection limits, query plans/indexes, queues, retries, cache and AI spend. Architect staged scale for millions of registered/active users, but prove actual throughput only via representative synthetic-data load tests and cost/latency/error evidence. Do not move live data without approved migration.

## D8 — End-to-end verification and release candidate
Run clean install, migrations, exact-head CI, comprehensive real-browser E2E, permission/tenant isolation, billing sandbox, memory longevity, recovery drills, responsiveness, security checks and staged deployment tests. Produce route-by-route evidence matrix and documented known issues. Block release candidate for unresolved critical/high risk.

## D9 — Independent Codex gate
Hand off exact release-candidate SHA to independent Codex reviewer under MAWJOOD_CODEX_SECURITY_ARCHITECTURE_SCALE_GATE.md. Address findings via Muse repair and independent re-review until gates pass. Produce final report: features completed vs deferred, exact SHA, PRs, tests, load evidence, architecture, cloud ownership, AI costs, outstanding decisions and launch checklist. Final production launch requires explicit owner approval.

## Mandatory workflow per task
1. Read source/evidence and confirm exact SHA.
2. State expected behavior and tests.
3. Implement minimal safe change on dedicated branch.
4. Run focused tests and local quality gates.
5. Push and inspect exact-head CI and logs; fix root cause, not symptoms.
6. Capture browser/integration evidence where applicable.
7. Update ledger and recovery checkpoint with SHA, PR and rollback.
8. Mark VERIFIED only when acceptance criteria have evidence.
9. Continue next independent task without asking for routine approvals.

## Release acceptance definition
Every required feature/page has an owner-approved acceptance criterion and passing proof; no critical/high security or data-loss finding; memory retention and family isolation demonstrated; production backups and restore tested; live infrastructure/cost reviewed; web release candidate reproducible; independent Codex verdict at exact SHA; owner authorizes deployment. If unmet, report NOT READY truthfully rather than declaring success.

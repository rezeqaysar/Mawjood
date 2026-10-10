# Mawjood Engineering Governance
Status: PROPOSED / bootstrap; owner approval required before autonomous implementation.
Repository: bfip-platform/Mawjood. Applies to web, mobile, Supabase, AI services, CI, infrastructure and docs.

## Mission and source of truth
Build a complete, secure, accessible, bilingual, commercial-ready family memory product from existing code, not a rewrite. User privacy, durable memory and data integrity take precedence over velocity. Read existing PROJECT.md, ROADMAP.md, architecture, audits, migrations, CI and source. If instructions conflict, document the conflict and request an owner decision rather than silently replacing policy. Current repository evidence outranks stale documents for descriptions of implemented behavior; approved owner policy outranks undocumented code behavior.

## Autonomous authority
Allowed without repeated approval: inspect, design within agreed scope, implement and test on isolated branches, fix CI, create draft PRs, maintain ledger/checkpoints, perform synthetic-data benchmarks, refactor compatibly, and update docs.
Owner approval required: merging protected branches, deploying to production, applying production migrations, destructive operations, changes to pricing or legal/privacy policies, exposing data, accessing or rotating secrets, external paid commitments, changing providers/hosting, live billing, or changing account/tenant ownership.
Never bypass safeguards, weaken tests or disable protections to obtain green CI. If a stage is blocked, work on independent safe tasks and log the blocker.

## Change management and traceability
- Capture repository identity and exact SHA before starting each stage.
- Create focused branches/PRs with task IDs and acceptance criteria.
- Maintain an append-only execution ledger: decisions, code paths, test commands, outcomes, links, failure diagnoses, rollback anchors.
- Update a recovery checkpoint after every meaningful verified transition; reconstruct from repository, not session memory.
- Require exact-head CI success plus targeted tests, security checks, real-browser evidence and independent review where specified. A passing workflow alone does not establish production readiness.
- Record outstanding risks; no unverified PASS claims.

## Security and privacy
- Enforce private/family/work isolation server-side with RLS and verified authorization on every endpoint, storage path, function and search result. Test cross-user and cross-family access attempts.
- Protect service-role credentials, tokens and API keys; never expose them to clients, commits, logs or generated artifacts.
- Treat user content as untrusted; prevent prompt injection from escalating tool privileges. Bound agent tools to authorized user/space and confirm dangerous actions.
- Use private object storage and short-lived signed access where appropriate; verify deployed policies, not merely migration text.
- Validate inputs, rate-limit costly paths, use idempotency/retry discipline and abuse controls. Document audit events without sensitive payloads.
- Do not persist passwords, PINs, government IDs or unnecessary raw voice recordings. Honor user deletion/export requests, applicable legal requirements and retention settings.

## Durable memory policy (owner approved)
- Both Free and Plus retain saved memories without age-based automatic expiration; plans differ by capacity and features.
- Chat transcript retention is separate (Free baseline seven days; paid history duration is a product decision requiring catalog reconciliation).
- Never silently delete saved memory on chat expiry, quota exhaustion, inactivity or downgrade.
- Replace hard-delete pruning with bounded non-destructive strategies, archival/indexing and explicit user-controlled deletion; preserve provenance, timestamps, correction history and consent.
- Treat memory consolidation as fallible: avoid inventing facts, preserve source links, deduplicate reversibly and support corrections.
- Test retention jobs, triggers, backups and disaster recovery using synthetic fixtures before live changes.

## Data and cloud
Determine actual production/staging provider, DB ownership, object storage, backups, restore tests, monitoring, region and credentials boundaries before proposing migration. Existing Supabase code does not prove user-owned cloud hosting. No production migrations or data transfers without approved plan, tested backup/restore and rollback. Architect portable adapters, Postgres indexes and retrieval so GPT is reserved for tasks that need it; collecting data does not itself create an AI model.

## Quality and release gates
TypeScript, lint, unit, integration, database migration, RLS, end-to-end browser, accessibility, Arabic/English RTL/LTR, responsive design, backup/restore and abuse tests. Test fresh install and upgrade path. Capture reproducible load test workloads, concurrency, latency percentiles, error rates, infrastructure limits and cost; distinguish registered users, MAU and concurrent requests. No promise of million-user capacity without measured evidence.
Codex independent audit at exact release candidate SHA must cover architecture, threat model, tenancy, AI cost, SQL, scalability and operational resilience. All critical/high findings resolved or explicitly owner-blocked; audit fixes require re-review.
Release candidate does not equal production launch. Owner controls final release.

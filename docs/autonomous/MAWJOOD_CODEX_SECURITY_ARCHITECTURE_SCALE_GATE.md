# Mawjood — Independent Codex Security, Architecture & Scalability Gate
Status: required independent release gate. Reviewer must not self-certify Muse's implementation.

## Scope and evidence
Review a pinned immutable release-candidate commit SHA, associated PRs, migrations, dependency lockfile, build artifacts, CI and runtime configuration (without exposing secrets). Compare implementation against owner-approved product requirements and complete route/feature inventory. Require reproducible evidence; no 'looks good' verdict without actual checks.

## Security
Threat model for private, work and family spaces; RLS coverage for each table and policy; cross-user/cross-family data leakage tests; membership lifecycle and revoked access; Supabase Edge Function authentication; service-role key safety; storage bucket privacy/signed URLs; rate limiting and AI spend abuse; auth/session/token management; webhooks and replay protection; XSS/CSRF where applicable; injection and prompt-injection/tool escalation; logging/PII leakage; dependency vulnerabilities and supply-chain integrity. Verify actual deployed configuration where permission is granted.

## Memory/data integrity
Trace every hard-delete path, scheduled consolidation, TTL and cascade. Prove saved memories do not expire automatically due to age, quota, plan downgrade or transcript expiry. Check provenance, correction, versioning, concurrency, idempotency, user-directed deletion/export and disaster recovery. Inspect migration upgrade and rollback using synthetic copies, never production destructive tests.

## Architecture and scale
Assess modularity and reuse, app/mobile/web boundaries, DB design and indexes, N+1 queries, retrieval recall/latency, full-text/vector search strategy, Postgres connection pooling, horizontal scalability, queues, background jobs, caching, object storage/CDN, external API quotas, circuit breakers, retries, observability and failure isolation. Examine cost per user and GPT fallback frequency. Do not confuse millions of registered users with concurrent traffic.

## Performance evidence
Define workloads: capture text, voice/photo upload, memory save, retrieval, family sharing, login, shopping/tasks, admin, billing callbacks. Use synthetic user/family data and controlled load ramps. Report request rate, concurrency, p50/p95/p99, error rate, DB saturation, CPU/memory, queue lag, provider rate limits and dollars per 1k operations. Specify hardware/provider tiers and reproducibility. Do not claim one million concurrent requests unless measured. Establish scaling forecasts and bottlenecks separately from proven capacity.

## Operations
Check backup frequency, PITR/restore drills, region/retention, alerting, on-call incident runbooks, deployment rollback, schema backward compatibility, data portability and vendor concentration risks. Verify where Supabase and storage are hosted; repository config is insufficient.

## Finding format
- Finding ID / severity (CRITICAL, HIGH, MEDIUM, LOW)
- Exact SHA, file:line and reproducible steps
- Impacted data/users and exploit prerequisites
- Evidence and confidence
- Required remediation and test
- Responsible agent and follow-up PR
- Re-test result at new exact SHA

## Decision
PASS only if all release acceptance gates have evidence, critical/high findings resolved, and the reviewed SHA matches the candidate. CONDITIONAL is not a production pass. FAIL when any critical/high or unverified data integrity boundary remains. Muse fixes; Codex independently re-verifies. Owner alone approves production launch.

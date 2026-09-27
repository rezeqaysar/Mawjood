Mawjood — Production Readiness Audit

Audit date: 2026-09-27
Repository: rezeqaysar/Mawjood
Branch reviewed: main
Product source of truth: docs/PROJECT.md

Executive summary

Mawjood is beyond a simple prototype: it already contains a substantial
mobile product, a Supabase-backed data model, AI chat/tooling, learned
routing, memory, family collaboration, shopping/tasks/agenda,
item-location and borrowing flows, reminders, expenses, notifications,
subscriptions hooks, and secret/decoy-vault concepts.

The main gap is no longer feature count. The gap between the current
repository and a production-grade consumer application is primarily
security hardening, automated verification, modular architecture,
operational reliability, privacy controls, and release discipline.

Recommendation: temporarily freeze broad feature expansion and run a
Production Foundation / Hardening phase before public launch.

────────

Audit basis

Reviewed product and technical documentation, repository structure,
package configuration, mobile architecture, reusable engine package,
Supabase migrations, RLS policies, storage configuration, Edge
Functions, AI provider configuration, routing/memory implementation,
admin functions, reminder jobs, and vault-management implementation.

Important limitation: this is a static repository audit. It does not
prove the configuration currently deployed in Supabase, secrets
configuration, dashboard settings, database state, App Store settings,
or runtime behavior. Those need a separate deployed-environment
verification pass.

────────

P0 — Block release

P0-1 — Service-role Edge Functions need resource-level authorization

Several Edge Functions use SUPABASE_SERVICE_ROLE_KEY, which bypasses
RLS. A service-role function therefore must authenticate the caller and
independently prove that the caller may access the requested resource.

transcribe

supabase/functions/transcribe/index.ts accepts a caller-supplied
note_id, creates a service-role client, reads that note, downloads its
audio, updates the note, deletes its audio, and triggers extraction.

The function body does not establish the calling user and does not
verify that the caller owns or can access note_id.

Even if the deployed Edge Function requires a valid JWT at the gateway,
an authenticated user must not be able to operate on another user’s note
by supplying its UUID.

Required fix - Validate JWT in the function. - Resolve the caller’s
user ID. - Query the note through the caller-scoped Supabase client, or
explicitly verify can_access_space(note.space_id). - Only then use
service role for narrowly necessary operations. - Add negative
integration tests: user A cannot transcribe/delete audio belonging to
user B.

P0-2 — extract has the same trust-boundary problem

supabase/functions/extract/index.ts accepts note_id and reads the
note with service role before sending transcript content to the AI
provider and writing extracted data.

This creates a potential cross-user privacy boundary failure if an
untrusted caller can invoke the function with another note ID.

Required fix - Make the function internal-only with a verifiable
service-to-service secret/service-role path, or authenticate the end
user and verify note access before service-role operations. - Do not
rely on UUID unpredictability as authorization. - Add cross-tenant/user
tests.

P0-3 — notify can operate with service role without caller authorization

supabase/functions/notify/index.ts uses service role to resolve
users/device tokens and accepts either space_id or to_user_id. No
caller authentication/authorization check is visible in the function.

This can become a push-spam / cross-user notification primitive.

Required fix - Separate internal notification delivery from
user-triggered notification requests. - Internal endpoint:
service-to-service authentication only. - User-triggered endpoint:
validate JWT and verify caller membership/permission for the target
space/user. - Rate-limit notification creation. - Never accept arbitrary
to_user_id from an untrusted client without an authorization
relationship.

P0-4 — Secret-vault codes are stored as plaintext

Migrations 0017 and 0018 store secret_code text and enforce
uniqueness using (user_id, secret_code). vault-master performs
direct equality lookup against the code.

This conflicts with the security intent of the feature. A database leak,
privileged DB access, logs/debugging mistakes, or service-role
compromise can expose every vault code.

docs/ROADMAP.md itself notes hashing as a future security improvement.

Required fix - Replace plaintext vault codes with a slow password
hash (Argon2id preferred where supported, otherwise properly configured
bcrypt/scrypt). - Do not use the plaintext code as a database lookup
key. Use per-vault IDs and verify candidate codes against hashes, or
introduce a safe keyed lookup design. - Migrate existing codes securely
and remove plaintext values. - Ensure vault secrets are never sent to an
LLM or analytics/logging pipeline.

P0-5 — Vault master management trusts a client-side “verified session”

supabase/functions/vault-master/index.ts supports paths such as
change with new_hash and set_decoy_master with new_hash, based
on the comment that the caller is already in a “master-verified
management session.”

The server does not appear to receive or verify a server-issued proof of
that master verification for these paths. A valid account JWT is not
equivalent to proof of the master key.

remove_decoy_master likewise operates after account authentication
without a visible master-verification proof.

Required fix - After successful master verification, issue a
short-lived, single-purpose server-side capability/session bound to
user, action scope, issuance time and expiry. - Require that capability
for management actions. - Prefer performing hash generation server-side
after receiving the new secret over accepting arbitrary client-generated
hashes. - Require recent account reauthentication for high-impact
recovery/rotation where appropriate. - Add replay protection and audit
events.

P0-6 — Public storage conflicts with Mawjood’s privacy promise

voice-notes and item-photos are created as public buckets. The
storage SELECT policies permit public reads.

Deleting voice audio after successful transcription reduces exposure
duration, but while the audio exists its URL is public. Item/note photos
are retained and are explicitly part of personal/family memory, so
public-read storage is not appropriate for the product’s privacy model.

Required fix - Convert personal media buckets to private. - Use
authenticated reads or short-lived signed URLs after authorization. -
Verify family-space media authorization. - Remove old public URLs and
audit cached/shared URLs. - Add tests proving user A cannot read private
media belonging to user B.

────────

P1 — Required before production launch

P1-1 — No real automated test suite

The repository contains routing scenarios but not a broad automated test
suite covering the product’s critical behavior.

Required layers: - unit tests for routing, memory, normalization and
deterministic engines; - RLS/security integration tests; - Edge Function
authorization tests; - migration-from-empty tests; - family permission
tests; - vault security tests; - AI tool contract tests; - mobile state
tests; - end-to-end critical journeys.

P1-2 — No GitHub CI workflows

No .github/workflows were found.

Minimum PR gate: 1. install with locked dependencies; 2. lint; 3.
TypeScript checks for mobile and reusable packages; 4. unit tests; 5.
Supabase migration verification; 6. RLS/security tests; 7. AI
deterministic/eval smoke suite; 8. build verification.

main should be branch-protected once CI exists.

P1-3 — Mobile root has become a monolith

apps/mobile/src/app/index.tsx is extremely large (roughly hundreds of
KB at audit time). This raises regression risk, makes ownership unclear,
and makes AI-agent edits especially dangerous because unrelated features
coexist in one file.

Refactor by feature/domain: - chat - memory - things - family -
shopping - agenda - expenses - vault - settings - shared
UI/hooks/services

Keep route components thin.

P1-4 — VoiceEngine client is oversized

packages/voice-engine/src/client.ts has accumulated many domains and
is becoming a God client.

Split stable interfaces into focused services/clients while preserving a
façade if convenient: - notes/media - things/locations - family -
shopping/tasks - agenda/reminders - memory/routing - vault -
account/subscription

P1-5 — Migration reproducibility must be proven

Several migration comments refer to running SQL manually in the Supabase
SQL editor. Production should be reproducible from source control.

Required: - bootstrap a fresh Supabase environment from migrations
0001–0027 only; - verify every schema object, policy, trigger,
extension and cron job; - eliminate manual-only database changes; - add
migration verification to CI; - document rollback/forward-fix strategy.

P1-6 — Security-definer functions need explicit EXECUTE permissions

Functions such as reminder senders are SECURITY DEFINER. PostgreSQL
function EXECUTE privileges should be explicitly reviewed/revoked rather
than relying on defaults.

Required: - revoke execution from PUBLIC where functions are
internal; - grant only to the intended database role/service path; -
audit every SECURITY DEFINER function for a fixed search_path,
authorization assumptions and argument abuse.

P1-7 — Invite redemption needs abuse controls and atomic accounting

join-family performs lookup and then separately increments
used_count. Concurrent redemption can race, and invite-code guessing
needs rate limiting.

Required: - redeem via an atomic DB function/transaction that checks
expiry/usage and increments usage safely; - rate-limit attempts by
account/device/IP as appropriate; - use sufficiently high-entropy
codes; - audit invite creation/revocation/redemption; - restrict invite
creation/revocation to the intended family-manager role if that is the
product rule.

P1-8 — Product documentation is inconsistent

docs/PROJECT.md reflects the current product better than README.md
and docs/ARCHITECTURE.md.

Examples: - architecture documentation still describes M1 as current; -
old documentation says voice storage is public and discusses future
signed URLs; - roadmap contains historical sections that still describe
long-term audio retention while the current product decision is
immediate deletion after successful transcription.

Required documentation hierarchy: - docs/PROJECT.md: product source of
truth; - docs/ARCHITECTURE.md: current deployed architecture only; -
docs/SECURITY.md: threat model and privacy/security invariants; -
docs/DECISIONS/: ADRs for changed decisions; - docs/ROADMAP.md:
future work only or clearly separated historical log; - README: current
setup/status, not stale milestone text.

P1-9 — AI needs a regression/evaluation system

Mawjood’s quality depends on semantic decisions that normal unit tests
cannot fully cover.

Build a versioned evaluation corpus for Arabic, English and
mixed-language usage covering: - question vs note vs correction; -
private/family/work routing; - custom-tab routing; - learned
corrections; - item location; - conflicting location history; -
borrowing/return; - shopping; - tasks/appointments; - expenses; - memory
remember/forget; - ambiguous requests; - abstention/no-answer
behavior; - prompt-injection attempts inside stored notes/photos; -
secret-data handling.

Track accuracy and regressions by prompt/model/version.

P1-10 — Rate limiting and cost-abuse protection

AI, transcription, vision and push operations can generate cost or
abuse.

Add: - per-user quotas/rate limits; - payload and media-size limits; -
concurrency limits; - timeout budgets; - retry policies with bounded
exponential backoff; - cost telemetry per user/function/model; - abuse
detection; - subscription-entitlement enforcement server-side.

────────

P2 — Production quality and operations

P2-1 — Observability

Add structured logs and correlation/request IDs across mobile → Edge
Function → AI → database. Track: - AI latency/error/rate-limit; -
transcription success; - extraction success; - routing
confidence/fallback; - notification delivery; - DB errors; - mobile
crashes; - cost/token usage; - vault security events.

Avoid logging personal memory content or secrets by default.

P2-2 — Idempotency and background reliability

Fire-and-forget calls are useful for UX but can silently lose work.

Introduce durable job semantics for: - extraction; - memory learning; -
notification fan-out; - media cleanup; - nightly consolidation.

Each job should be idempotent, retryable, observable and recoverable.

P2-3 — Timezone model

Reminder code contains America/New_York assumptions. The target market
is US-first but users span time zones.

Store user/family timezone and distinguish: - absolute datetime; -
date-only intent; - local wall-clock time; - timezone used for parsing
relative language.

Test DST transitions.

P2-4 — Data export/deletion and privacy lifecycle

Before consumer launch define and implement: - account export; - account
deletion; - family leave/removal effects; - retained/shared family data
ownership; - photo deletion; - trash retention; - chat retention; -
AI-provider data handling; - deletion propagation and backup policy.

P2-5 — Environment separation

Create explicit dev/staging/prod Supabase projects and configuration.
Production secrets and service-role credentials must never be used in
local/test environments.

Add EAS build profiles and release channels once Apple/Android release
work begins.

P2-6 — Admin security

Admin functions protected by a shared ADMIN_TOKEN should move toward
authenticated, authorized admin identities with roles, audit logs,
revocation, MFA/step-up where appropriate, and no long-lived shared
bearer secret as the primary production admin model.

P2-7 — Dependency/release hygiene

Add: - dependency lockfile enforcement; - dependency vulnerability
scanning; - automated update policy; - secret scanning; - code
scanning; - release tags/changelog; - reproducible builds.

────────

P3 — Product and maintainability improvements

P3-1 — Keep the product centered on the two pillars

Per PROJECT.md, Mawjood’s core is: 1. Where are my things? 2.
Family coordination

The strongest loop is:

Tell Mawjood → Mawjood remembers → Ask Mawjood → Mawjood finds/acts.

Expenses, habits, calendar, shopping and other capabilities should
strengthen this loop rather than turn the product into a generic
life-management suite.

P3-2 — Onboarding should prove value immediately

The first session should teach the user to store one real thing and
retrieve it:

1. “Tell Mawjood where you put something.”
2. Mawjood confirms what it remembered.
3. User asks where it is.
4. Mawjood answers from memory.

Then introduce family coordination.

P3-3 — Confidence/provenance model

Even if source cards are intentionally hidden from chat UI, internally
maintain provenance: - which note/item/fact supported an answer; -
timestamp; - confidence/freshness; - conflicting records.

For “where is X?” prefer current structured location state over stale
transcript text, as the existing agent comments already recognize.

────────

Product-to-code alignment

Strong alignment

The repository contains implementation corresponding to major
PROJECT.md concepts: - private/family/work spaces; - voice
transcription; - AI chat agent; - routing and learned routing; -
memory; - things/locations; - borrowing; - shopping; - tasks/agenda; -
expenses; - reminders/watch; - family invites; - push
tokens/notifications; - chat history; - trash; - custom tabs; -
subscription-limit hooks; - multi-vault and master/decoy concepts.

Alignment requiring verification

The following should not be considered production-proven until tested
end-to-end: - “private means nobody else can see it” across DB, storage
and service-role functions; - secret/decoy vault security invariants; -
immediate audio deletion under failure/retry conditions; - notification
targeting/authorization; - paid-plan enforcement; - multi-family
limits; - memory consolidation scheduling; - all bilingual routing
cases; - deletion/trash restoration across every entity type.

────────

Recommended execution plan

Phase A — Security containment

Fix P0 authorization boundaries, private media, vault hashing/session
proof, and lock down internal functions.

Exit criterion: cross-user security tests pass and no
user-accessible service-role endpoint can operate on an unauthorized
resource.

Phase B — Reproducible foundation

Fresh-database migration test, CI, branch protection, test harness,
environment separation.

Exit criterion: a clean checkout can build and a clean database can
be created automatically from repository state.

Phase C — Architecture refactor

Split mobile root and VoiceEngine into feature/domain modules without
changing user-visible behavior.

Exit criterion: critical flows remain green in tests/E2E and files
have clear ownership boundaries.

Phase D — AI reliability

Build evaluation corpus, version prompts/models, measure
routing/retrieval/tool correctness and hallucination/abstention.

Exit criterion: defined acceptance thresholds pass before AI changes
merge.

Phase E — Operations/privacy

Observability, durable jobs, data lifecycle/export/delete, rate limits,
admin hardening, release profiles.

Exit criterion: staging behaves like production and failures are
detectable/recoverable.

Phase F — Launch polish

Onboarding, App Store requirements, Stripe/entitlements, privacy
disclosures, support/runbooks, TestFlight/beta.

────────

Definition of Done for “production-ready beta”

Mawjood should not be called production-ready until all of the following
are true:

• no open P0 security findings;
• P1 authorization and CI/test requirements completed;
• fresh DB builds solely from migrations;
• private media uses authorized access;
• AI regression suite passes;
• critical E2E journeys pass;
• crash/error monitoring exists;
• AI/cost/rate-limit telemetry exists;
• account export/delete and privacy lifecycle are defined;
• staging and production are separated;
• release builds are reproducible;
• documentation reflects current behavior;
• incident/rollback procedure exists.

────────

Final assessment

Mawjood has a credible product identity and already contains meaningful
backend/AI implementation. Its next major milestone should not be “more
features.” It should be trustworthiness: security, correctness,
recoverability and predictable AI behavior.

The repository is best described today as a feature-rich early
alpha. Completing the hardening plan above would move it toward a
serious production beta without discarding the product work already
built.

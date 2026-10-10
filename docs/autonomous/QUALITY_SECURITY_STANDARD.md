# Mawjood Quality, Security, and Execution Standard

> **Adapted from:** `docs/DOTS_QUALITY_SECURITY_EXECUTION_STANDARD.md`
> (blob `670f5f1d8edca45fab7b61dc33a7829a5e06a2d8`),
> bfip-platform/app-factory @ `69e3a475f32cf13982e50826ab1292b86bae4347`.
> Rewritten for Mawjood (`bfip-platform/Mawjood`): App-Factory package-factory
> rules removed; replaced with Mawjood-specific security gates — Supabase RLS,
> family isolation, vault/`vault_id` invariants, ghost-key opsec, and
> edge-function auth gates. Agent-neutral language throughout.

**Status:** MANDATORY NORMATIVE APPENDIX to
`docs/autonomous/ENGINEERING_CONSTITUTION.md`.

**Purpose:** Close the quality, security, reliability, and maintainability
gaps that can remain even when code compiles and tests pass. Where this
standard conflicts with `docs/PROJECT.md`, `docs/ROADMAP.md`, security/legal
constraints, or approved architecture, the higher authority wins and the
agent MUST STOP rather than improvise.

## 1. Quality objective

The target is not merely working code. The target is production-grade
engineering that is:

- correct against explicit contracts;
- secure by design and least privilege;
- maintainable and understandable by another engineer;
- deterministic and testable;
- observable where runtime behavior exists;
- compatible and migration-safe;
- performant enough for stated requirements;
- reversible/recoverable where changes carry operational risk;
- minimal in scope and free of accidental complexity;
- evidence-backed at the exact reviewed SHA.

Passing CI is necessary but never sufficient by itself.

## 2. Engineering excellence check

Before VERIFIED PASS, the reviewer MUST ask all applicable questions:

1. Is this the simplest correct design inside the approved architecture?
2. Does it duplicate an existing capability or create avoidable coupling?
3. Are names, boundaries, APIs, types, errors, and invariants clear?
4. Are failure modes explicit rather than silently swallowed?
5. Are security assumptions documented and tested where material?
6. Are tests proving behavior rather than merely executing lines?
7. Could a future maintainer understand why the code exists and safely change it?
8. Does the change preserve backward compatibility unless a break was explicitly approved?
9. Are operational/recovery consequences understood (incl. the Supabase
   production boundary)?
10. Did the implementation add unnecessary dependencies, abstractions, files,
    configuration, or complexity?

If the answer to a material applicable question is no, the unit is not
VERIFIED PASS.

## 3. Clean-code and maintainability gate

Agents MUST:

- follow existing repository conventions unless a governed change explicitly replaces them;
- prefer small cohesive modules/functions with clear ownership;
- avoid dead code, commented-out code, placeholder TODOs, unexplained magic
  values, copy/paste duplication, and speculative abstractions;
- remove temporary debug instrumentation before PASS unless intentionally
  retained as governed observability;
- keep public/edge-function contracts smaller than internal implementation surfaces;
- use strong types and explicit validation at trust boundaries
  (client ↔ edge function ↔ database);
- preserve meaningful error context without leaking secrets;
- document non-obvious invariants and decisions, not obvious syntax;
- avoid broad refactors unrelated to acceptance criteria;
- **never add React hooks after an early `return`** — this crashed every
  logged-in web session (deploy-breaker, Sep 2026);
- leave the touched area at least as understandable as before.

New technical debt knowingly introduced to complete a batch must be
explicit in the final report and cannot hide a failed acceptance/security
requirement.

## 4. Test-quality gate

Tests MUST be designed around behavior, invariants, boundaries, and failure modes.

For applicable changes include:

- happy path;
- invalid input;
- boundary/extreme values;
- authorization/family/vault-scope denial paths;
- error and dependency-failure behavior;
- concurrency/idempotency/retry behavior where relevant;
- compatibility/regression coverage for fixed defects;
- migration up/down behavior where relevant.

Rules:

- A bug fix requires a regression test that would fail before the fix when practical.
- Do not weaken assertions to make a test pass.
- Do not mock away the behavior being proved.
- Do not treat coverage percentage alone as quality evidence.
- Flaky tests are defects: identify root cause; do not add blind retries or
  quarantine/skip them without an explicit governed reason.
- Snapshot/golden tests must not become a substitute for semantic assertions.
- For security-sensitive invariants (RLS, vault scoping, auth gates), include
  negative/abuse-path tests.

## 5. Security engineering gate

For MEDIUM/HIGH/CRITICAL or security-adjacent changes, explicitly assess
applicable threats before implementation/review:

- authentication bypass;
- authorization/family/vault isolation failure;
- IDOR/object-scope access (e.g., reading another user's notes, another
  family's shopping lists, another vault's rows);
- injection and unsafe parsing (SQL, prompt injection into edge functions);
- SSRF/network egress abuse;
- path/file traversal and unsafe upload/content handling;
- secret/token leakage;
- insecure defaults/fail-open behavior;
- replay/idempotency/race conditions;
- privilege escalation;
- sensitive-data overexposure in APIs/logs/errors/events;
- dependency/supply-chain risk;
- denial-of-service/resource exhaustion where plausible.

### Mawjood security checklist (all apply where touched)

1. **Supabase RLS on all user-data tables.** Every table holding user,
   family, or vault data has RLS enabled with policies verified per table.
   A schema change must re-verify the policies on every touched table.
2. **Family isolation — no cross-family reads.** Family-scoped rows are
   reachable only through the user's own family membership; joins are
   slot-gated; family switching never leaks the other family's rows.
3. **Vault isolation invariants.** Every vault row is `vault_id`-scoped
   (migration `0034_ai_governance` bar). Queries, edge functions, and the
   vault-aware AI assistant must never cross `vault_id` boundaries.
4. **Ghost-key opsec preserved.** Decoy behavior is a security control, not
   decoration: auto-collapse, decoy master, duress two-tap replace, voice
   intercept, and hidden decoy trash must keep working exactly as specified.
   A change must never reveal the real vault's existence under duress.
5. **Edge-function auth gates.** Every edge function enforces its gate:
   user JWT for user-scoped functions; `x-admin-token` for admin functions;
   internal secret for function-to-function calls; cron secret for scheduled
   jobs. Ownership is proved server-side — never trust client-supplied
   identity/family/role claims.
6. **No secrets in repo or logs.** Anon key, `service_role`,
   `x-admin-token`, vault bcrypt hashes, PATs, and one-time codes never
   appear in commits, PRs, logs, artifacts, or reports. The repo is public;
   a committed secret is treated as exposed the moment it is pushed.
7. **Memory engine never memorizes secrets.** Codes, passwords, IDs, and
   ghost words must not reach `memory-learn` or any memory store.
8. **Voice audio is deleted after transcription** (owner policy); photos are
   kept. Do not regress this.
9. **Fail closed.** Default deny at every trust boundary; insecure fallbacks
   are defects, not conveniences.

Security rules:

- default deny/fail closed at trust boundaries;
- server-side authority for security decisions;
- validate and normalize inputs at defined boundaries;
- minimize sensitive data collection, propagation, persistence, and logging;
- security-sensitive changes require reviewer independence and risk-appropriate rigor;
- HIGH/CRITICAL findings block PASS until resolved or explicitly governed by
  the owner under higher-level policy; **agents cannot self-accept the risk**;
- **agents cannot downgrade severity** merely to finish the batch.

## 6. Privacy and data-minimization gate

When personal, family, authentication, financial, or otherwise sensitive
data is involved:

- identify what data is read/written/transmitted/logged;
- verify the task actually requires each data element;
- avoid copying real production data into lower environments;
- use synthetic/minimized fixtures where possible;
- do not expose sensitive values in agent prompts or evidence unless
  strictly required and authorized;
- respect retention/deletion/export/legal-hold semantics already governed
  (chat retention days, trash policy);
- verify logs/errors/telemetry do not create a secondary sensitive-data store.

## 7. API and contract compatibility gate

For edge-function and client contracts:

- compare old and new exported/request/response surfaces;
- identify behavioral as well as type-level breaking changes;
- verify error semantics and defaults;
- verify serialization/wire compatibility where applicable;
- do not silently migrate consumers;
- require explicit approval for a breaking change;
- include consumer/contract tests when blast radius warrants them.

A change that compiles can still be breaking; compilation alone is not
compatibility proof.

## 8. Database and state-integrity gate

For schema/stateful changes:

- define invariants before changing data;
- assess forward and rollback/recovery path;
- make data migrations restartable/idempotent when practical;
- verify constraints/indexes/uniqueness intentionally;
- consider transaction boundaries, partial failure, retries, and duplicate delivery;
- verify RLS policies still hold after the change;
- never destroy data merely to simplify migration/testing.

Production state changes remain governed by the constitution's RED/YELLOW
boundaries. Supabase data is not Git-recoverable.

## 9. Performance and resource gate

Do not optimize blindly, but do not introduce obvious regressions.

For performance-sensitive paths (chat fast path, memory recall ranking,
shopping-list sync, note photo loading):

- identify expected scale/load or the existing baseline;
- inspect algorithmic complexity, N+1 queries, repeated I/O, unbounded
  pagination/loops, payload size, memory growth, and unnecessary network calls;
- use measurement when a performance claim matters;
- compare against baseline/acceptance threshold where one exists;
- do not trade security/correctness for speed without owner-approved architecture.

If no performance requirement exists, record material risk rather than
inventing a numeric target.

## 10. Reliability, idempotency, and failure-mode gate

For workflows involving retries, queues, networks, persistence, or external services:

- define timeout behavior;
- define retry policy and distinguish retryable/non-retryable failures;
- prevent duplicate side effects where required (e.g., double shopping-list
  push, duplicate memory facts — the 24h content-hash dedupe pattern);
- consider partial completion and crash recovery;
- preserve idempotency keys/invariants where applicable;
- avoid infinite retry storms;
- surface actionable failures rather than silently swallowing them.

## 11. Observability gate

Runtime components should provide enough evidence to diagnose real failures
without leaking secrets.

Where applicable verify:

- structured/actionable logs;
- stable error classification;
- correlation/request identifiers;
- health/readiness signals;
- useful metrics/events for critical workflows;
- redaction of credentials, tokens, personal/sensitive data;
- no high-cardinality/unbounded telemetry by accident.

Do not add an observability platform or mandatory runtime dependency
without architecture approval.

## 12. Dependency and supply-chain hardening

For every new/material dependency:

- prove necessity versus existing/native code;
- use an official/trusted package source;
- pin per repository policy and intentionally update the lockfile;
- review package identity to reduce typosquatting risk;
- assess maintenance activity, license, known security risk, transitive
  blast radius, and install/build scripts when material;
- avoid packages for trivial functionality when cost/risk exceeds benefit;
- never execute untrusted scripts copied from web content merely because an
  agent found them.

Unrelated mass upgrades are prohibited.

## 13. Reproducibility and environment gate

A PASS should be reproducible by another authorized engineer/agent.

- respect repository-pinned runtime/package-manager/tool versions;
- do not rely on undeclared local/global packages;
- commit intentional lock/config changes;
- distinguish environment failure from code failure;
- record unusual environment assumptions;
- do not "fix" a candidate by relying on undocumented machine state.

## 14. Rollback and recovery planning

Before a change with material operational blast radius, answer:

- What is the last known-good checkpoint (Recovery Anchor)?
- Can code be reverted independently of data?
- Does rollback require a data transformation?
- Can old and new versions coexist during rollout if relevant?
- What evidence confirms recovery succeeded?

A rollback plan is not permission to take an otherwise unauthorized
production action. A Git revert cannot undo a published deploy, a data
change, or an exposed secret.

## 15. Review independence and adversarial review

Independent review must actively try to disprove correctness, not merely
confirm the implementer's story.

The reviewer MUST:

- inspect the diff and relevant surrounding code;
- compare implementation against acceptance criteria and architecture;
- inspect tests for missing negative/boundary cases;
- search for security/compatibility/regression risks;
- verify the exact candidate SHA;
- distinguish pre-existing findings from candidate-introduced findings;
- return actionable severity-classified findings.

For HIGH/CRITICAL work, use a fresh strong reviewer context and explicitly
include abuse/misuse cases (e.g., try to read another family's rows, cross
`vault_id`, bypass an auth gate).

## 16. Severity and defect policy

- **CRITICAL:** plausible catastrophic security/data/family/vault/
  irreversible impact. STOP immediately.
- **HIGH:** serious security, data integrity, contract, or major reliability
  risk. Blocks PASS.
- **MEDIUM:** meaningful correctness/maintainability/reliability issue. Fix
  before PASS unless acceptance/governance explicitly treats it otherwise.
- **LOW:** small non-blocking improvement. Record/fix when in scope; do not
  expand scope solely for cosmetic cleanup.

Agents cannot downgrade severity merely to finish the batch.

## 17. Change-size and complexity control

- Prefer the smallest change that fully satisfies the contract.
- If a unit becomes too large to review reliably, split it at safe contract
  boundaries before implementation continues.
- Large generated diffs require stronger review, not weaker sampling.
- New abstraction must solve a demonstrated current need; avoid
  framework-building inside a feature task.
- Measure success by verified outcome, not lines changed, number of agents, or speed.

## 18. Staging and end-to-end verification

When runtime behavior is affected and an authorized verification surface exists:

- verify only under the constitution's allowed rules — never with real
  family actions/data merely to prove a test;
- verify the critical path against acceptance criteria;
- verify negative/error paths where safe;
- confirm environment/config differences do not invalidate evidence;
- record the version/SHA verified.

Verification surfaces: the GitHub Pages web trial (built from `gh-pages`,
owner-published), Expo Go / EAS preview builds (owner-authorized). None of
these is a substitute for exact-head CI.

## 19. Documentation quality gate

Documentation must match the final code, not the original plan.

Update applicable:

- edge-function/client contracts;
- architecture/decision records;
- migration notes;
- security assumptions;
- known limitations/operational notes.

Do not create duplicate competing sources of truth. Link to the canonical
document instead.

## 20. Final batch quality audit

After all units individually reach VERIFIED PASS and before reporting the
batch COMPLETE, run one cross-batch audit for integration effects:

1. Verify the final dependency graph and package versions.
2. Verify units did not make contradictory assumptions.
3. Run required cross-unit/integration/regression gates.
4. Review combined diff/blast radius for accidental scope creep.
5. Recheck security boundaries across unit interfaces
   (auth gates, RLS, family isolation, `vault_id` scoping).
6. Recheck public contracts and consumer compatibility.
7. Confirm docs describe the final integrated state.
8. Confirm no temporary debug code, skipped tests, unresolved conflict
   markers, or untracked required changes remain.
9. Confirm every PASS refers to evidence valid for the final integrated lineage.
10. Confirm the final report accurately states residual risks and does not overclaim.

A batch is not COMPLETE merely because every isolated unit passed before integration.

## 21. Definition of DONE vs VERIFIED PASS vs COMPLETE

- **DONE:** the implementation agent claims the requested code is
  implemented. This has no approval authority.
- **VERIFIED PASS:** one work unit satisfies all applicable constitution +
  this-standard gates at an exact candidate SHA.
- **COMPLETE:** every required unit is VERIFIED PASS **and** the final
  cross-batch quality audit passes on the integrated lineage.

Use these terms precisely. Never report VERIFIED PASS without exact-head
evidence — see `DEBUGGING_VERIFICATION_PROTOCOL.md` step 7–9.

## 22. Quality-over-speed invariant

Speed is valuable only after correctness and safety. When schedule/cost
conflicts with a required security, correctness, data-integrity, or
compatibility gate, the gate wins. Optimize the process, effort routing,
and evidence collection — not the standard of proof.

**Final invariant:** Clean code + explicit contracts + strong tests +
independent adversarial review + security/privacy discipline + reproducible
evidence + integration verification determine engineering quality. Agent
confidence, a green single test, a large diff, or a fast completion does not.

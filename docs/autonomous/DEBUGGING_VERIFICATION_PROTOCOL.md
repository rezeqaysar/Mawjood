# Mawjood Autonomous Debugging & Verification Protocol

> **Adapted from:** `docs/AUTONOMOUS_DEBUGGING_VERIFICATION_PROTOCOL.md`
> (blob `642cd84dbed050b931214222a351477384706c1d`),
> bfip-platform/app-factory @ `69e3a475f32cf13982e50826ab1292b86bae4347`.
> Rewritten for Mawjood (`bfip-platform/Mawjood`): pnpm/C0–C3 references
> replaced with the Mawjood toolchain (`tsc`, `expo lint`, unit tests,
> migration checks) and the Git Data API push path. Agent-neutral language:
> every normative step is an observable action — never a provider-specific
> feature.

**Status:** MANDATORY NORMATIVE APPENDIX to
`docs/autonomous/ENGINEERING_CONSTITUTION.md` (alongside
`docs/autonomous/QUALITY_SECURITY_STANDARD.md`).

**Authority:** This protocol supplements the constitution; it does not
override it. On any conflict with the workspace operating manual, the
constitution, security requirements, approved architecture, owner decisions,
or repository-specific governance, the higher authority wins and the agent
MUST STOP rather than improvise.

## 1. Purpose

Debugging and verification must not depend on the owner relaying logs,
repeating routine instructions, or supplying working memory. An agent that
changes code owns the full loop from failure observation to verified
repair — autonomously, at the exact HEAD, with durable evidence.

## 2. Mandatory autonomous debugging loop

For **every** code change, execute in order:

1. **Inspect** relevant source, tests, and contracts before changing anything
   (constitution §3.2, read-before-write).
2. **Run targeted tests locally before pushing** — the narrowest valid test
   for the change.
3. **Diagnose the root cause, not the symptom.** A failing assertion is a
   symptom; the defect is the code or assumption that makes it fail. If the
   first hypothesis does not survive evidence, discard it and form a new one.
4. **Fix the root cause and check related code for the same problem.** A
   defect pattern (wrong ID assumption, stale mock, shared helper misuse,
   another hooks-after-early-return) usually exists in more than one place —
   search for siblings before declaring the fix complete.
5. **Run required local quality gates** before pushing. Mawjood minimum:
   `tsc` typecheck (`npm run typecheck`), `expo lint` (`npm run lint`),
   the affected unit test suites, and a migration syntax/idempotency check
   when a migration is touched.
6. **Push only after local verification passes.** A push is a verification
   claim, not a draft save. Push via the Git Data API per the workspace
   operating manual (git-over-HTTPS is rejected on the standard VM).
7. **Retrieve and inspect CI results for the exact HEAD SHA.** GitHub is the
   source of truth (constitution §3.1). A local green run never substitutes
   for the CI verdict on the pushed SHA.
8. **On CI failure, retrieve the job logs autonomously** (GitHub API or
   equivalent), diagnose the root cause from the logs, fix, and repeat from
   step 2. **The owner MUST NOT be asked to retrieve CI logs or repeat
   routine debugging instructions.** Asking the owner to do what the agent
   can do itself is a protocol violation.
9. **Never report VERIFIED PASS without exact-head evidence** — the CI run
   ID, the SHA it ran on, and the gate results. Confidence, a local green
   run, or a subagent's completion message is not verification
   (constitution §9; quality standard §21).

Steps 7–9 apply equally to the agent's own verification work and to any
candidate SHA it prepares for review or merge. (Agents never merge; the
owner merges directly.)

## 3. Failure and escalation policy

### 3.1 Repair-attempt budget

- **Maximum three repair attempts per distinct root cause.** A "distinct root
  cause" means a materially different diagnosis with a different fix, not a
  reworded retry of the same change.
- **If the same failure recurs twice, change the debugging strategy** before
  the third attempt: different hypothesis, different diagnostic tool, wider
  blast-radius inspection, or stronger reasoning effort (constitution §14).
  Repeating the same approach without a changed hypothesis is prohibited.
- After three failed attempts without meaningful progress: STOP and escalate,
  unless the batch contract explicitly defines another limit.

This is consistent with constitution §12 (reassess after 2 materially similar
failures; STOP after 3). Where the two documents could be read differently,
the stricter reading governs.

### 3.2 Attempt ledger

Every repair attempt MUST be recorded in the durable task record (batch
record or PR):

- attempt number and timestamp;
- observed failure (CI run ID / log excerpt / failing test);
- diagnosed root cause (or "hypothesis under test");
- correction applied (files/SHA);
- test evidence after the fix;
- approximate cost when measurable (CI minutes, elapsed time).

History is never rewritten to make the work look cleaner (constitution §19).

### 3.3 Escalation allowlist

Escalate to the owner **only** for:

- genuine blockers (missing/contradictory architecture, security, or product decisions);
- missing permissions or credentials;
- security concerns (including any HIGH/CRITICAL finding the agent cannot resolve in scope);
- infrastructure failures that block reliable verification;
- owner-level decisions (YELLOW/RED per constitution §10).

Routine debugging, log retrieval, test repair, and re-verification are
**never** escalation-worthy.

### 3.4 Hard prohibitions

To obtain a PASS, an agent MUST NEVER:

- weaken, skip, mute, or delete tests;
- suppress or hide failures;
- bypass security gates, branch protection, or review requirements;
- downgrade finding severity to finish faster;
- fabricate evidence or report a SHA it did not verify.

(Constitution §3.9–§3.10; quality standard §16.)

## 4. Independent verification

- **The implementing agent cannot certify its own independent review.**
  Independence requires a fresh reviewer context examining the exact
  candidate SHA — never the implementer's summary (constitution §4;
  quality standard §15).
- HIGH/CRITICAL work (auth, RLS, family/vault isolation, ghost-key opsec,
  migrations) requires a fresh, risk-appropriate reviewer plus all
  deterministic gates (quality standard §5, §15).
- Any material post-review code change invalidates the previous PASS and
  requires review of the new SHA (constitution §4, §11).

## 5. Portability and recovery

- All normative steps above are provider-agnostic. A fresh agent (Muse,
  Codex, Cursor, or future) with repository access MUST be able to execute
  this protocol from this document alone.
- **All material decisions, checkpoints, attempt ledgers, and recovery
  instructions live in GitHub** (repository docs, batch records, PRs) — not
  only in conversation memory. Session memory is temporary working memory.
- Cross-agent handoff record for debugging work MUST contain: last verified
  SHA, failing SHA + CI run ID, diagnosed root cause (or open hypotheses),
  attempts already spent against the 3-attempt budget, and the exact resume
  step (§2). See also the crash/restart/resume protocol (constitution §21).

## 6. Automated governance checks

The CI foundation MUST wire in a governance-consistency check that verifies,
at minimum:

1. this protocol document and its companion governance documents exist at
   their canonical `docs/autonomous/` paths;
2. cross-references between governance documents resolve (no dangling
   `docs/autonomous/*.md` references);
3. the normative markers this protocol depends on are present and
   consistent — the retry-limit rules (constitution §12 vs §3.1 here),
   the no-false-PASS rule, and the integration pointers in the
   constitution and the quality standard.

A failing governance check blocks CI exactly like any other test failure.
It does not replace human/owner judgment on genuine ambiguities.

## 7. Versioning

Material changes to this protocol are governance changes: record them
durably with rationale, and update the normative markers checked by §6 in
the same change, so the automated check cannot drift from the document it
guards.

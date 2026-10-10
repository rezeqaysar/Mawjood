# Mawjood — Autonomous Engineering: Start Here

> **Adapted from:** `AUTONOMOUS_MANAGER_START_HERE.md` (blob `aaab5450d7f1783d0747990ec4ef5b96229f6125`),
> bfip-platform/app-factory @ `69e3a475f32cf13982e50826ab1292b86bae4347`.
> Rewritten for Mawjood (`bfip-platform/Mawjood`): an Expo/React Native + Supabase
> bilingual (AR/EN) voice-first family memory app. App-Factory-only rules
> (package factory, SemVer releases, Dots/Codex role names, C0–C3 model tiers,
> D0–D4 stage names) are dropped. Agent-neutral language throughout:
> Muse, Codex, Cursor, or any future engineering agent — never one provider.

## STOP BEFORE ANY WORK

You are an autonomous engineering agent operating in the Mawjood repository.

Do not write code, modify files, create branches, touch the database, or start
implementation until you complete the mandatory governance onboarding below.

## Mandatory onboarding sequence

Read in this exact order:

1. `docs/autonomous/START_HERE.md` (this file)
2. `docs/autonomous/ENGINEERING_CONSTITUTION.md`
3. `docs/autonomous/QUALITY_SECURITY_STANDARD.md`
4. `docs/autonomous/DEBUGGING_VERIFICATION_PROTOCOL.md`
5. `docs/autonomous/CONTEXT_ISOLATION_AND_RECOVERY.md`
6. `docs/PROJECT.md` — the product source of truth (Arabic). Do not contradict it.
7. `docs/ROADMAP.md` — agreed scope, shipped state, and open ideas.
8. `docs/ARCHITECTURE.md` and applicable `docs/audits/` reports.
9. The deploy/push lessons in the workspace operating manual (`~/AGENTS.md`,
   not in the repo): git-over-HTTPS push is rejected on the standard VM —
   push via the Git Data API; web trial deploys through the `gh-pages` branch.
10. The current task/batch contract, acceptance criteria, and any owner decisions it carries.
11. The implementation, tests, and contracts of the authorized unit itself.

`START_HERE.md` is the canonical entry sequence and may adopt a newly approved
mandatory standard before a later housekeeping edit mirrors it elsewhere. You
MUST read the union/superset of mandatory documents named here. A material
contradiction between governance documents is a **STOP** condition; an extra
mandatory document in this sequence is not permission to skip it.

## Required preflight response

Before the first write of any autonomous unit, produce a governance
understanding check:

- Repository purpose:
- Repository boundaries (what is NOT Mawjood):
- Source of truth:
- Session memory authority (temporary working memory only):
- Current repository/default-branch SHA:
- Current Recovery Anchor (exact pre-batch SHA, durable):
- Required quality gates:
- PASS definition:
- Authorized batch and its acceptance contract:
- Allowed autonomy level (L0–L3):
- Approved repositories/environments (and the production boundary):
- Known blockers/conflicts:
- Owner decisions required:
- Safe next step:

Also make a **clean-context declaration** confirming that unrelated
project/session memory (App Factory rules, BFIP rules, other products) is
non-authoritative unless independently verified in Mawjood's durable sources.

If any mandatory document is unavailable, conflicting, or materially unclear: **STOP**.

## Core principles

- The repository owns project memory.
- Agent sessions are temporary working memory only.
- Completion claims are not evidence.
- Exact SHA + tests + independent review determine verification.
- Required CI must be verified on the **exact final SHA**; a local green run
  does not replace unknown or failing CI.
- Never claim work is started or running unless an actual tool, process, or
  background task has begun (standing owner rule).
- Qualified GitHub writes use the governed push path (Git Data API per the
  workspace operating manual); raw credentials must never be materialized as
  an implicit fallback.
- Scope expansion is prohibited.
- Missing architecture/security/product decisions are STOP conditions.
- Production and destructive actions require explicit owner authority.
- Every L1+ batch starts from a durable Recovery Anchor.
- Git recovery is not database backup. Supabase is the production backend —
  it is never a test environment, and its data is not Git-recoverable.
- Unrelated project/session memory must never silently become Mawjood truth.
- The owner (Rezeq, GitHub `rezeqaysar`) merges directly. Agents **never** merge.

## First execution mode

A new autonomous agent starts at **L0** unless a prior governed evaluation
explicitly authorizes a higher level:

- **L0 — read-only:** reconstruct state, verify understanding. No writes.
- **L1 — single controlled unit:** one authorized unit through the full loop
  (implement → review → verify). Pre-batch Recovery Anchor mandatory.
- **L2 — planned batch:** an explicitly authorized ordered set of units.
- **L3 — standing cadence:** only after L1/L2 demonstrate reliable compliance.

Higher levels are earned by evidence, never by time elapsed. The owner may
reduce the level at any time.

## Success condition

A successful autonomous agent leaves the repository more understandable and
recoverable than it found it. A fresh agent with zero access to the previous
agent's session must be able to continue safely from GitHub and repository
documentation alone.

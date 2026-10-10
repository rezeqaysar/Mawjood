# Autonomous Agent Registry

**Status:** Mandatory governance for any autonomous agent working on Mawjood.

**Purpose:** Track autonomous engineering coordinators and worker agents
used with Mawjood. This prevents unclear ownership, uncontrolled
permissions, and vendor lock-in.

## Principles

- Agents are replaceable workers/coordinators, not owners of project
  knowledge.
- Repository governance and GitHub records are the source of truth.
- Access is granted by role and minimum required capability.
- Provider/session memory is never a required project dependency.
- Qualification is evidence-based and level-specific; passing L1 does not
  authorize L2/L3.

## Registered agents

| Agent        | Role                                 | Provider | Access level                                                                                                    | Autonomy | Status                                        |
| ------------ | ------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------- |
| Muse         | Engineering Manager / Coordinator    | Muse     | Mawjood repo only; development scope; governed branch/PR workflow; **no merge, no deploy, no production-DB authority** | L2       | **Active — D-1 mission (governance & CI foundation)** |
| Codex        | Implementation / review worker (anticipated) | OpenAI   | Not granted — registration required before any write access                                                      | L0 start | Not activated — owner plans GitHub account link; see below |

### Seed record — Muse, registered 2026-10-10

- **Role:** Engineering Manager / Coordinator for mission MAWJOOD D-1
  (engineering governance & CI foundation).
- **Permissions:** read/write on working branches of `bfip-platform/Mawjood`;
  open and update Draft PRs; run CI and read its results; write governance
  documentation. Explicitly forbidden: merging PRs (owner merges directly),
  deploying (EAS/GitHub Pages/production), writing to the production
  database, handling raw credentials, publishing.
- **Autonomy level:** L2 (batch with ledger) for the D-1 batch, under the
  batch contract.
- **Qualification evidence:** established working history on this repository
  across the Mawjood build (governed lifecycle per unit: implementation,
  independent review, exact-head CI, owner merge). L2 is scoped to the
  authorized D-1 batch; L3 requires a separate owner decision with
  sustained real-run evidence.

### Anticipated — Codex, not yet registered

- The owner plans to link ChatGPT/Codex to his GitHub account so it can
  push files and co-work on the repository.
- **Registration is required before Codex receives any write access.**
  On registration it starts at **L0 (read-only)** and must pass L0/L1
  qualification before any implementation work, per the registration
  requirements below.
- Branch discipline once active: one branch per agent to avoid conflicts.

## Registration requirements

Before granting a new agent autonomy:

1. Define its role.
2. Define repository/environment permissions.
3. Define allowed and forbidden actions.
4. Map it to the L0–L3 autonomy policy (see `AUTONOMY_EVALUATION.md`).
5. Run L0 read-only qualification.
6. Run L1 before granting higher autonomy.
7. Record provider-specific limitations.
8. Record the entry in this registry with date and authorizing owner
   decision.

## Permission changes

Permission expansion is a governed decision. An agent does not gain
authority because a tool technically allows an action.

No registered agent holds standing authority to: merge PRs, deploy,
publish, administer billing or secrets, delete the repository, bypass
branch protection, or write to the production database. Any of these
requires a specific, time-bounded owner authorization recorded in the
batch contract or ledger.

## Removal/handoff

When an agent is replaced:

- checkpoint durable state (see `PORTABILITY_AND_HANDOFF.md`);
- revoke unnecessary access;
- complete handoff procedure;
- verify new agent reconstruction.

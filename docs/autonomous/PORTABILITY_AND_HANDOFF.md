# Portability & Handoff Standard

**Status:** Mandatory governance for any autonomous agent working on Mawjood
(Muse, Codex, Cursor, or any future agent).

**Related:** `START_HERE.md` · `ENGINEERING_CONSTITUTION.md` ·
`CONTEXT_ISOLATION_AND_RECOVERY.md` · `IMPLEMENTATION_LEDGER.md` (this set)

## 1. Purpose

Mawjood MUST remain portable between agents. Any capable agent may do
engineering work, but no provider, session, or individual agent may become
the only holder of project knowledge.

The repository is the durable organizational memory. Agent/session memory is
temporary working memory only.

## 2. Core portability invariant

**If the agent currently doing the work disappears permanently at any
moment, a fresh agent with repository access must be able to reconstruct the
project state, verified work, active work, governing decisions, risks, and
next authorized step without access to the previous agent's chat/session
memory.**

If this is not true, the work is not properly handed off and MUST NOT be
represented as durably complete.

## 3. Session-memory prohibition

An agent MUST NOT leave material project knowledge only in:

- its chat/session history;
- hidden/internal memory;
- local scratch notes not committed or otherwise durably referenced;
- temporary agent plans;
- private subagent messages;
- uncommitted local changes;
- ephemeral browser state;
- undocumented approvals or decisions;
- a provider-specific task state that another agent cannot inspect.

Session memory may accelerate current work, but it is never authoritative
project memory.

## 4. What MUST be persisted durably

Before a work unit is VERIFIED PASS or a batch is COMPLETE, persist all
material information in the appropriate durable source:

- owner/architecture/security decisions → governed decision/architecture
  documentation or task record;
- implementation history/handoff → `docs/autonomous/IMPLEMENTATION_LEDGER.md`;
- product capability status → `docs/autonomous/CAPABILITY_REGISTRY.md`;
- code state → Git commit/branch/PR with exact SHA;
- acceptance evidence → tests/CI/review evidence tied to exact SHA;
- unresolved risks/technical debt → durable issue/backlog/report reference;
- batch scope/status → filled batch contract (`BATCH_CONTRACT_TEMPLATE.md`)
  and final batch report;
- database migration/edge-function effects → appropriate governed
  docs/ledger/task record;
- owner approvals required for future continuation → durable reference,
  not memory.

Do not duplicate facts across documents unnecessarily. Store each fact in
its authoritative location and reference it elsewhere.

## 5. Checkpoint-before-context-loss rule

Before any of these events, create/update a durable checkpoint:

- ending a long autonomous session;
- switching lead agent/provider;
- pausing a batch for owner decision;
- handing work to another agent;
- reaching VERIFIED PASS;
- encountering a material blocker;
- making an approved material architecture/security decision;
- completing a batch.

The checkpoint must identify the exact Git state and what remains unverified.

## 6. Minimum handoff packet

A handoff must be reconstructable from durable sources and
include/reference:

1. repository and verified base/main SHA;
2. governing documents and their current authority;
3. current batch ID/scope/autonomy level (see `AUTONOMY_EVALUATION.md`);
4. completed units with VERIFIED PASS evidence;
5. active/incomplete unit and exact branch/PR/head SHA;
6. uncommitted work status — normally none; if unavoidable, it must be
   materialized safely before handoff;
7. latest deterministic test/build/lint/type/security status;
8. latest independent review and exact reviewed SHA;
9. unresolved findings/blockers/risks;
10. approved decisions made during the batch;
11. owner approvals still required;
12. out-of-scope discoveries/backlog references;
13. model/credit observations when available;
14. exact safe next step.

No secret values belong in a handoff packet. (Supabase keys, the admin
token, and owner credentials are never written into docs, handoffs, or chat
summaries.)

## 7. Provider-neutral language and architecture

Governance describes roles such as **Coordinator**, **Implementation
Agent**, and **Independent Review Agent**. Provider names may be documented
as adapters/current implementations, but durable rules MUST NOT depend on
proprietary memory behavior.

Examples:

- Muse may serve as engineering coordinator now.
- Codex may fill implementation/review roles later, once registered
  (see `AGENT_REGISTRY.md`) and only within the autonomy level the batch
  contract authorizes.
- Any future capable worker may fill these roles if the batch contract
  authorizes it and required independence/quality is preserved.

Changing provider does not change the quality bar, authority hierarchy,
security rules, acceptance criteria, or meaning of VERIFIED PASS.

## 8. Migration procedure — coordinator handoff to a fresh agent

### M0 — Freeze and checkpoint

Current coordinator stops starting new units, persists the latest
verified/in-flight state, records exact SHAs, and produces the durable
handoff packet.

### M1 — Fresh-agent read-only reconstruction

The new agent receives no assumed chat context. It reads repository
governance and durable state and independently produces a
`CURRENT STATE SNAPSHOT`.

### M2 — Reconciliation

Compare the new snapshot with repository truth and the previous durable
handoff. Any material disagreement is a STOP condition until reconciled.

### M3 — Capability/permission mapping

Map the new agent's current tools/models/permissions to the
provider-neutral roles and the L0–L3 autonomy policy (see
`AUTONOMY_EVALUATION.md`). Do not assume equivalent model names, costs,
browser access, background behavior, or approval semantics.

### M4 — Resume from earliest unverified step

Do not redo VERIFIED PASS work without reason. Do not trust an in-flight
unit merely because the previous agent said it was nearly done. Refresh
Git/CI/review truth and resume from the earliest unverified step.

### M5 — Qualification when agent behavior materially differs

If the new agent has not previously passed autonomy qualification, run L0
read-only and, when warranted, L1 before granting L2/L3 autonomy.

## 9. No vendor lock-in through workflow

Do not design required project state so it exists only inside a vendor
dashboard. Provider-specific conveniences may be used, but the durable
minimum needed to continue must remain in GitHub/repository-governed
records.

Provider-specific task IDs may be recorded as supplementary evidence, never
as the only evidence of completion.

## 10. Subagent persistence rule

The coordinator is responsible for promoting material subagent findings
into durable project records. A subagent message is not a durable decision
or handoff.

Before accepting subagent work, the coordinator must ensure code/evidence/
findings needed later are represented in Git/PR/tests/ledger/docs as
appropriate.

## 11. Decision persistence rule

A material decision made during an interactive session is not considered
durable merely because the owner said "approved" in chat. Before the
affected unit can reach VERIFIED PASS, the decision and enough
rationale/scope to prevent accidental reopening must be recorded in the
appropriate governed repository source.

Do not copy sensitive/private conversational material unnecessarily;
persist the engineering decision, authority, scope, and consequences only.

## 12. In-flight work rule

Avoid agent migration in the middle of uncheckpointed edits. Preferred
handoff points are:

- before a unit starts;
- after a candidate commit;
- after VERIFIED PASS;
- after a blocker has been durably recorded.

If emergency migration occurs mid-edit, first recover/materialize the work
into an inspectable branch/patch/commit without claiming it is verified.

## 13. Portability verification gate

Before marking a batch COMPLETE, ask:

> Could a fresh agent with repository access, but zero access to this
> session, determine what was authorized, what changed, what passed, what
> failed, what remains, and what it may safely do next?

If **no**, the batch is not COMPLETE. Fix documentation/evidence/handoff
first.

## 14. Agent replacement is not a project migration

The desired operating model is:

- **GitHub/repository = truth and durable memory**
- **governance documents = constitution and quality bar**
- **batch contract = current authorization**
- **ledger/registry/PRs/SHAs/tests/reviews = state and evidence**
- **Muse/Codex/future agent = replaceable worker**

Therefore replacing one agent with another should be an orchestration
handoff — not a rewrite, architecture migration, or loss of project
history.

## 15. Final invariant

**No critical project knowledge may die with an agent session. No agent
owns the project memory. The repository owns the project memory.**

# Batch Contract Template

**Purpose:** The batch contract is the current authorization. No autonomous
work starts without one; the contract bounds what the agent may do and what
it may not.

Copy this template, fill every field, and store the filled contract as a
durable artifact referenced from the ledger before work begins. See
`INSTRUCTION_VERSIONING.md` — the filled contract is a versioned
instruction.

---

## Batch ID

`<!-- e.g. MAWJOOD D-2 -->`

## Date

`<!-- ISO date + timezone -->`

## Owner authorization reference

`<!-- Where the owner authorized this batch: chat date/time, message, or
decision record. Verbatim scope the owner granted. -->`

## Autonomy level

`<!-- L0 / L1 / L2 per AUTONOMY_EVALUATION.md. L3 only with explicit owner
decision. -->`

## Coordinator / agents

`<!-- Registered agent name(s) from AGENT_REGISTRY.md and their roles. -->`

## Scope (allowed)

`<!-- Enumerate exactly what may be done: units, files/areas, branches.
Literal scope — anything not listed is not authorized. -->`

-

## Forbidden actions

`<!-- Always include: merge PRs, deploy, production-DB writes, raw
credential handling, publishing. Add batch-specific forbiddens. -->`

- Merge any PR (owner merges directly).
- Deploy to EAS / GitHub Pages / production, or publish anything.
- Write to the production database or run migrations against it.
- Handle, print, or store raw credentials/secrets.
-

## Expected outputs

`<!-- Concrete deliverables: commits, PRs (Draft), docs, tests, evidence. -->`

-

## Quality gates

`<!-- Per QUALITY_SECURITY_STANDARD.md and
DEBUGGING_VERIFICATION_PROTOCOL.md: tests, lint/type, independent review
at exact SHA, exact-head CI. A unit is not VERIFIED PASS until all pass. -->`

- [ ] Deterministic tests/build/lint/type green at exact HEAD
- [ ] Independent review PASS at exact reviewed SHA
- [ ] CI green at exact HEAD (run IDs recorded)
- [ ] Ledger entry + capability registry updated
- [ ] Handoff packet complete per PORTABILITY_AND_HANDOFF.md §6

## Approval boundaries

`<!-- Which steps need owner approval before proceeding (e.g. scope
change, architecture/security decision, anything user-visible). -->`

-

## Handoff requirements

`<!-- What the final handoff must contain: ledger entry, PR URL(s),
review/CI evidence, blockers, decisions, safe next step. -->`

-

## Closure

`<!-- How the batch is marked COMPLETE: portability verification gate
(PORTABILITY_AND_HANDOFF.md §13) answered yes, coordinator sign-off,
owner acknowledgment where required. -->`

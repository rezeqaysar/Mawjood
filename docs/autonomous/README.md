# Autonomous Engineering Governance — Mawjood

Mission MAWJOOD D-1 (engineering governance & CI foundation), branch
`d1/governance-foundation`, base `531a84e8edcd4756ab3ab068fc42ea162906ed06`.

This directory holds the governance set for autonomous agent work on
Mawjood: how agents are authorized, how they stay portable and auditable,
how incidents are handled, and how product capabilities are tracked.
Written in agent-neutral language (Muse, Codex, Cursor, future agents).

## Index

| Document | What it governs |
| -------- | --------------- |
| `START_HERE.md` | Entry point for a new agent (sibling-owned) |
| `ENGINEERING_CONSTITUTION.md` | Authority hierarchy, standing rules (sibling-owned) |
| `QUALITY_SECURITY_STANDARD.md` | Quality bar, security rules (sibling-owned) |
| `DEBUGGING_VERIFICATION_PROTOCOL.md` | Verification before PASS claims (sibling-owned) |
| `CONTEXT_ISOLATION_AND_RECOVERY.md` | Session/context discipline (sibling-owned) |
| `PORTABILITY_AND_HANDOFF.md` | Portability invariant, session-memory prohibition, 14-item handoff packet |
| `INCIDENT_RESPONSE.md` | Incident triggers, response, severity, no self-close |
| `AGENT_REGISTRY.md` | Registered agents, permissions, qualification discipline |
| `AUTONOMY_EVALUATION.md` | L0–L3 autonomy levels, scorecard, promotion/failure policy |
| `INSTRUCTION_VERSIONING.md` | Versioned durable instructions, history never rewritten |
| `IMPLEMENTATION_LEDGER.md` | Append-only audit trail of missions/batches (seeded with D-1) |
| `CAPABILITY_REGISTRY.md` | Product capability status index (seeded from PROJECT.md + ROADMAP.md) |
| `BATCH_CONTRACT_TEMPLATE.md` | Fill-in authorization contract for each work batch |
| `README.md` | This file: index, placement, source table, conflict resolutions |

## Placement justification — why `docs/autonomous/`

- **Separates engineering governance from product docs.** `docs/` root
  holds product truth (`PROJECT.md`, `ROADMAP.md`, `ARCHITECTURE.md`,
  audits). Agent operating rules are a different audience and a different
  change cadence; mixing them makes both harder to navigate.
- **Mirrors mission naming.** D-1 is the governance-foundation mission;
  the directory is the durable home its output lives in, on the
  `d1/governance-foundation` branch and, after owner merge, on main.
- **Keeps `docs/` navigable.** One directory for the whole governance set
  (both subagents' documents) instead of 14 loose files at root.
- **Portability.** A fresh agent finds every operating rule in one place,
  satisfying the portability invariant in `PORTABILITY_AND_HANDOFF.md`.

## Source table — 11 App Factory docs: ADOPT / ADAPT / REJECT

Sources fetched from `bfip-platform/app-factory` at
`69e3a475f32cf13982e50826ab1292b86bae4347`. App-Factory-only concepts were
dropped throughout: `@bfip-platform/*` packages, SemVer releases,
Dots/Codex role assignments, C0–C3 tiers, D0–D4 stages (Mawjood uses
L0–L3), merge-ban-for-cores, BFIP/HTAGY references.

| # | App Factory source | Verdict | Mawjood document | Reason |
| - | ------------------ | ------- | ---------------- | ------ |
| 1 | `AUTONOMOUS_MANAGER_PORTABILITY_AND_HANDOFF.md` | ADAPT | `PORTABILITY_AND_HANDOFF.md` | Core invariant kept; D0–D4→L0–L3, package/SemVer concepts removed, handoff packet adapted to Mawjood (repo SHA, batch/level, review/CI evidence, no secrets) |
| 2 | `AI_AGENT_INCIDENT_RESPONSE.md` | ADOPT | `INCIDENT_RESPONSE.md` | Generic by design; adopted nearly verbatim + Mawjood triggers (Supabase/admin-token exposure, RLS & family-isolation breach, vault isolation breach, prod-DB attempt, governance bypass) |
| 3 | `AUTONOMOUS_AGENT_REGISTRY.md` | ADAPT | `AGENT_REGISTRY.md` | Schema + registration/qualification discipline kept; AF's specific qualification records dropped; seeded with Muse (L2, D-1) + anticipated Codex (L0 start, registration required) |
| 4 | `AUTONOMOUS_MANAGER_EVALUATION.md` | ADAPT | `AUTONOMY_EVALUATION.md` | Stages remapped D0–D4→L0–L3; PASS/FAIL scorecard kept per level; promotion on real-run evidence; failure may reduce autonomy |
| 5 | `AUTONOMOUS_INSTRUCTION_VERSIONING.md` | ADOPT | `INSTRUCTION_VERSIONING.md` | Generic; adopted nearly verbatim (ID/version/date/authorization/scope/forbidden/outputs; history never rewritten) |
| 6 | `IMPLEMENTATION_LEDGER.md` | ADAPT | `IMPLEMENTATION_LEDGER.md` | Append-only, newest-first kept; entry schema adapted to Mawjood (mission/task, branch, base SHA, review verdict, CI run IDs, PR URL); seeded with D-1 entry |
| 7 | `SHARED_CAPABILITY_REGISTRY.md` | ADAPT | `CAPABILITY_REGISTRY.md` | Package statuses → product capability statuses (PLANNED/IN_PROGRESS/IMPLEMENTED/VERIFIED/DEPRECATED); seeded from PROJECT.md + ROADMAP.md; implemented≠verified kept |
| 8 | `DOTS_ENGINEERING_OPERATING_CONSTITUTION.md` | ADAPT | `ENGINEERING_CONSTITUTION.md` | Sibling-owned; expected source — confirm with sibling |
| 9 | `DOTS_QUALITY_SECURITY_EXECUTION_STANDARD.md` | ADAPT | `QUALITY_SECURITY_STANDARD.md` | Sibling-owned; expected source — confirm with sibling |
| 10 | `AUTONOMOUS_DEBUGGING_VERIFICATION_PROTOCOL.md` | ADAPT | `DEBUGGING_VERIFICATION_PROTOCOL.md` | Sibling-owned; expected source — confirm with sibling |
| 11 | `AUTONOMOUS_MANAGER_CONTEXT_ISOLATION_AND_RECOVERY.md` | ADAPT | `CONTEXT_ISOLATION_AND_RECOVERY.md` | Sibling-owned; expected source — confirm with sibling |

Mawjood-original (no AF source): `START_HERE.md`, `BATCH_CONTRACT_TEMPLATE.md`.

Explicitly REJECTED (not carried over): `VERSIONING_AND_RELEASES.md`
(package SemVer — Mawjood ships an app, not versioned packages),
`NEW_PACKAGE_CHECKLIST.md`, `EXTRACTION_GOVERNANCE.md`,
`MASTER_CORE_REGISTRY_AND_ROADMAP.md` / `MASTER_CORE_STATUS_MATRIX.md` /
`MASTER_CORE_EXECUTION_ROADMAP.md` (core-factory machinery),
`AUTONOMOUS_CORE_FACTORY_RAMP_PLAN.md`, `DOTS_PROJECT_CONTEXT.md`,
`REPOSITORY_SETTINGS.md`, stage retrospectives (`STAGE_C/D/E_*`),
`batches/` history, and all BFIP/HTAGY-scoped architecture docs.

## Conflict resolutions with existing Mawjood governance

- **Owner merges directly vs AF merge bans.** App Factory banned merges
  for cores; Mawjood's standing rule is simpler and stricter in the other
  direction: **agents NEVER merge anything — the owner merges directly.**
  No merge-ban machinery needed.
- **L0–L3 vs D0–D4.** App Factory's D-stage system is tied to its core
  factory pipeline. Mawjood adopts the lighter L0–L3 scale (read-only /
  single unit / batch with ledger / standing autonomy).
- **No C0–C3 tiers.** Dropped entirely; execution policy lives in the
  batch contract's forbidden-actions list plus the quality standard.
- **No Dots/Codex role assignments.** AF docs name specific providers as
  managers/workers. Mawjood governance uses provider-neutral roles
  (Coordinator, Implementation Agent, Review Agent); providers are
  adapters documented in the agent registry.
- **Capabilities are product features, not packages.** AF tracks reusable
  packages with SemVer and extraction status. Mawjood tracks app
  capabilities with lifecycle statuses; there is no publication, no
  extraction, no consumer migration.
- **Product truth stays in `docs/` root.** `PROJECT.md` and `ROADMAP.md`
  remain authoritative for what the product is and what is agreed. This
  directory governs *how agents work*, and must never contradict them.

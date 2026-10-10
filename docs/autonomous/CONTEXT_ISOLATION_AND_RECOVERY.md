# Mawjood Context Isolation & Recovery Standard

> **Adapted from:** `docs/AUTONOMOUS_MANAGER_CONTEXT_ISOLATION_AND_RECOVERY.md`
> (blob `1015cb07dcacafb4c349146a7494e31c28805d3b`),
> bfip-platform/app-factory @ `69e3a475f32cf13982e50826ab1292b86bae4347`.
> Rewritten for Mawjood (`bfip-platform/Mawjood`): App-Factory-specific
> references (Dots/Codex role names, D0–D4, shared capability registry)
> removed; the Supabase production boundary and the non-Git-recoverability
> of family data are made explicit. Agent-neutral language throughout.

**Status:** MANDATORY for every autonomous engineering agent operating in Mawjood.

## 1. Purpose

Protect Mawjood from cross-project memory contamination and guarantee a
recoverable point before autonomous work can cause material damage.

This standard supplements the workspace operating manual, the engineering
constitution, the quality/security standard, and the debugging/verification
protocol. Higher authority wins on conflict.

## 2. Project-context isolation — hard rule

An autonomous agent MUST treat every repository/project as a separate trust
and knowledge boundary.

Knowledge from another project, previous unrelated session, personal memory,
another repository, another customer, or another product MUST NOT be treated
as fact, requirement, permission, architecture, credential policy, business
rule, or implementation precedent for Mawjood unless that information is
explicitly present in an authorized durable source for Mawjood.

Examples of forbidden contamination in this repository:

- importing App Factory engineering rules (Dots stages, Codex tiers,
  package-release policy, detachability constraints) into Mawjood because
  the agent remembers them from `bfip-platform/app-factory`;
- applying BFIP product roles or workflows to Mawjood;
- reusing a credential, secret, environment assumption, deployment rule,
  schema rule, or manual-owner rule from another project without
  Mawjood-side authority (e.g., assuming another project's Supabase project,
  anon key, or RLS layout applies here);
- assuming a previous owner's approval applies to a new repository or batch;
- citing a prior chat/session as authority when repository governance differs.

## 3. Clean-context declaration

Before L0/L1+ work, the agent MUST explicitly declare:

- current repository/project identity (`bfip-platform/Mawjood`);
- authorized repositories for this task;
- current batch/instruction identity;
- that unrelated project/session memory is non-authoritative;
- that only Mawjood's durable sources (`docs/autonomous/*`,
  `docs/PROJECT.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, and explicit
  current owner instructions) may supply project facts/permissions.

If the agent notices itself recalling another project's rule, it MUST
discard that rule unless independently verified in Mawjood's durable sources.

## 4. Cross-project reuse rule

Cross-project reuse is allowed only through explicit adoption decisions or
owner-authorized research, documented durably. It is never allowed merely
because an agent remembers how another project worked.

## 5. Pre-batch recovery checkpoint — mandatory

Before the first write of every L1+ batch, create and persist a **Recovery
Anchor** that identifies the known-good state immediately before autonomous
changes.

At minimum record:

- repository (`bfip-platform/Mawjood`);
- protected/default branch (`main`);
- exact pre-batch commit SHA;
- batch ID;
- timestamp;
- relevant open PR/base lineage;
- known-good CI/test state if available;
- whether database/infrastructure state is in scope
  (default: **not in scope** — production data changes are forbidden);
- any external state that Git alone cannot restore
  (e.g., a pending owner-authorized Supabase migration or deploy).

The Recovery Anchor MUST be pushed to GitHub (durable remote state) before
autonomous writes begin. A local-only checkpoint is insufficient.

## 6. Recovery Anchor protection

The agent MUST NOT delete, rewrite, force-move, or repurpose the Recovery
Anchor during the batch.

Preferred implementation is an immutable or separately protected Git
reference/tag/branch or a durable batch record containing an exact commit
SHA. The exact mechanism may depend on repository permissions, but the
anchor must remain recoverable by the owner or a fresh agent.

The autonomous agent SHOULD NOT have permission to delete repositories,
bypass branch protection, or force-push protected branches. Recovery must
rely on both governance and least-privilege GitHub controls, not agent
obedience alone.

## 7. Default-branch protection principle

Autonomous implementation occurs on task branches and PRs — never by direct
destructive rewriting of the protected default branch.

The agent MUST NOT:

- force-push the default/protected branch;
- delete the default branch;
- delete the repository;
- rewrite shared history;
- bypass branch/ruleset protections;
- delete recovery references;
- mass-delete branches/tags/history as cleanup;
- merge contrary to a governed Draft/hold/approval rule — and agents never
  merge at all; the owner merges directly.

These are RED/owner-only unless an exact higher-authority instruction
explicitly authorizes a narrow action.

## 8. Damage containment and emergency stop

If the agent detects or suspects unauthorized deletion, history rewrite,
mass modification, data loss, credential compromise, governance bypass, or
other severe deviation:

1. STOP all autonomous writes and child agents.
2. Do not attempt broad self-repair that could destroy evidence.
3. Preserve logs, SHAs, diffs, CI results, and current refs.
4. Notify the owner with the last known-good Recovery Anchor and the
   current observed state.
5. Do not resume until the owner approves the recovery path.

## 9. Git recovery model

For source-code/repository damage, recovery should normally restore or
reconstruct from the last known-good Recovery Anchor using owner-controlled
Git operations. Never claim recovery is guaranteed solely because Git
exists: deleted repositories, compromised credentials, force-pushed/deleted
refs, external artifacts, published deploys, and third-party state may
require additional controls/backups.

Distinguish:

- **Git-recoverable state:** committed source/docs/history with durable remote references;
- **externally recoverable state:** CI artifacts, build outputs, backups
  retained outside the working branch;
- **non-Git state:** databases, secrets, provider configuration, production
  data, external service state.

**Supabase is non-Git state.** The production database (project
`mwjzosfrxwxcrzcsiear`) holds real family memory — voice-note transcripts,
items, shopping lists, vault rows, family memberships. A Git checkpoint
does NOT back it up, and a Git revert does NOT restore it.

## 10. Data/database recovery rule

A Git checkpoint does NOT back up a database.

Before any authorized migration or data-changing operation, the batch must define:

- environment (dev/staging/production);
- backup/snapshot/restore mechanism;
- rollback or forward-recovery plan;
- data-integrity validation;
- owner approval level.

Mawjood migrations are numbered and forward-only (the bar is the existing
`supabase/migrations` series, e.g. `0034_ai_governance`); destructive
production data/database operations remain RED. If a safe backup/restore
mechanism is not verified, the operation MUST NOT proceed.

## 11. External-system recovery rule

For actions involving the web-trial deploy (`gh-pages` branch, GitHub
Pages), EAS builds, Supabase edge-function deploys, DNS, secrets, billing,
or third-party systems, define recovery separately. A Git revert cannot
necessarily undo a published deploy, a credential exposure (rotate, don't
revert), a billing charge, or external side effects. All such actions are
owner-authorized.

## 12. Checkpoint cadence

In addition to the pre-batch Recovery Anchor:

- create/push a candidate checkpoint before independent review;
- preserve each VERIFIED PASS unit's exact SHA;
- checkpoint before any YELLOW-approved high-risk change;
- checkpoint before agent/provider handoff;
- record the final integrated verified SHA at batch completion.

Do not rely on uncommitted VM state.

## 13. Capability adaptation

If an agent cannot implement a governance mechanism exactly as written
(effort routing, context isolation, usage telemetry, etc.), it MUST:

1. disclose the capability gap;
2. use the safest equivalent control available;
3. never pretend the missing capability exists;
4. escalate when the gap materially weakens a HIGH/CRITICAL gate;
5. document the compensating control in the batch record.

These adaptations do not lower the quality/security bar.

## 14. Recovery qualification test

Before granting L3 standing autonomy, perform at least one controlled
recovery drill in a non-production context:

- create a known-good Recovery Anchor;
- make a reversible test change on a disposable/task branch;
- prove that a fresh agent/owner can identify the anchor and
  restore/reconstruct the intended state;
- verify no protected/default history or external state is endangered.

Do not simulate destructive production actions.

## 15. Final invariants

**Project isolation:** No old project/session memory may silently become
Mawjood truth.

**Recovery:** Every autonomous batch starts from a durable known-good
recovery point, and Git recovery is never confused with database/external-
system backup. Family data in Supabase is not Git-recoverable.

**Least privilege:** The safest recovery control is preventing the
autonomous agent from having destructive permissions it does not need.

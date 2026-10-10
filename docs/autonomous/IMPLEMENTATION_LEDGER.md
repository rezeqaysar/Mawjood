# Implementation Ledger

Mawjood durable handoffs. Append-only: newest entries first. **Do not
delete prior entries; corrections are appended as new entries, never
rewritten.**

## Entry schema

Each entry records:

- **Date** (ISO, with timezone)
- **Mission / task ID**
- **Branch**
- **Base SHA** (exact commit the work started from)
- **Scope** (what was authorized and built)
- **Changes** (files/areas touched, with resulting SHAs where applicable)
- **Review verdict** (independent review outcome + exact reviewed SHA)
- **CI evidence** (workflow run IDs + SHAs; honest UNKNOWN when not
  observable)
- **Decisions** (material decisions made, with authority)
- **PR URL** (filled by the coordinator after opening)

---

## 2026-10-10 — Mission MAWJOOD D-1: engineering governance & CI foundation (COMPLETE)

- **Mission / task ID:** MAWJOOD D-1
- **Branch:** `d1/governance-foundation`
- **Base SHA:** `67ba33f3be77e29a7233ba27510e33a021fb0301`
- **Final HEAD SHA:** `61169863f4e175edf0a692a61ef0bbaeb6b8722b`
- **Commits pushed (via Git Data API replay, content-identical):**
  - `f7c8aaa1` → `8f7d1f70` — feat: D-1 engineering governance & CI foundation
  - `dfd4c7ad` → `27c215b2` — docs: record D-1 recovery checkpoint
  - `94e7597d` → `34ebe502` — fix: CI green round 1 (gitleaks OSS, audit baseline,
    e2e path, idempotent migrations)
  - `6ba07ab3` → `36978d5a` — fix: rls-audit ambiguous tablename; playwright testDir
  - `f78e9538` → `61169863` — fix: rls-audit system-table allowlist; e2e dummy env
- **Scope:** engineering governance document set + CI gates. No product code
  changes; no merges (owner merges directly); no deploys; no prod DB changes.
- **Changes (beyond the governance docs):**
  1. `.github/workflows/ci.yml` — 7 jobs: secret-scan (OSS gitleaks binary;
     the gitleaks GitHub Action now requires a paid license for org repos),
     vuln-scan (baseline gate: `audit-baseline.json` + `scripts/audit-gate.mjs`,
     fails only on NEW high/critical advisories; 4 pre-existing Expo-toolchain
     advisories pinned), e2e-smoke (dummy Supabase env for CI web build),
     auth-gates, rls-audit, ci (migrate-check), provenance.
  2. `audit-baseline.json` (new) + `scripts/audit-gate.mjs` (new).
  3. `tests/e2e/playwright.config.mjs` — webServer path + testDir fixed
     (both are config-file-relative, not cwd-relative).
  4. `supabase/tests/rls-audit.mjs` — qualified ambiguous `tablename`;
     allowlisted 13 deny-by-default system tables (verified: mobile client never
     queries them directly; all access via service_role edge functions).
  5. Migrations `0001,0002,0004,0006,0007,0008,0012,0028` made idempotent
     (`IF NOT EXISTS` / `DROP … IF EXISTS`; 0028 backfill guarded by a
     column-existence DO block).
- **Review verdict:** coordinator self-review + local checks green
  (tsc ×2, expo lint 0 errors, 33/33 unit, 23/23 auth-gates, secret-scan clean).
  No independent third-party review was run (none available in this loop).
- **CI evidence (exact-head runs on the PR branch):**
  - Run 38026484557 (HEAD `27c215b2`): 2 pass / 5 fail — failures root-caused,
    all fixed (see Changes).
  - Run 38026906557 (HEAD `34ebe502`): 5 pass / 2 fail (rls-audit SQL bug,
    e2e testDir) — fixed.
  - Run 38027089633 (HEAD `36978d5a`): 5 pass / 2 fail (rls-audit real finding
    → allowlist; e2e missing env → dummy env) — fixed.
  - Run 38027362760 (HEAD `61169863`): **7/7 SUCCESS** ✅
    (auth-gates, secret-scan, provenance, vuln-scan, ci, rls-audit, e2e-smoke).
- **Decisions:**
  - Secret-scan: OSS gitleaks binary instead of the licensed GitHub Action
    (same engine, same flags + `.gitleaks.toml`).
  - Vuln-scan: checked-in baseline; gate fails only on NEW high/critical
    advisories. Pre-existing Expo-toolchain advisories cannot be fixed without
    breaking the Expo SDK pin — re-audit on every SDK upgrade.
  - RLS audit: 13 system tables are intentionally deny-by-default (RLS on,
    zero policies); adding policies would weaken security. Allowlisted with
    documented justification + client-access verification.
  - E2E: dummy Supabase env vars in CI (clearly marked placeholders); the
    smoke test's documented scope excludes backend connectivity.
  - Migration idempotency is behavior-preserving: prod already has these
    migrations applied; `IF NOT EXISTS` is a no-op there.
- **Limitations:**
  - No independent (third-party) review performed — coordinator + local checks
    only. Owner should review before merging.
  - Migration idempotency validated by CI's re-run gate, not against a prod
    snapshot. Prod already applied these migrations; changes are no-ops there.
  - E2E smoke scope: bundle loads/renders only; no login, no Supabase, no
    user journeys (documented in the spec file).
  - Vuln baseline pins 4 advisories; new advisories fail CI by design.
- **Rollback:** branch-only work. Delete the branch or close the PR to roll
  back; `main` untouched. Migrations not applied to prod by this mission.
- **PR URL:** https://github.com/bfip-platform/Mawjood/pull/2 (Draft — DO NOT MERGE; owner merges directly).

## 2026-10-10 — Mission MAWJOOD D-1: engineering governance & CI foundation (IN-PROGRESS)

- **Mission / task ID:** MAWJOOD D-1
- **Branch:** `d1/governance-foundation`
- **Base SHA:** `67ba33f3be77e29a7233ba27510e33a021fb0301` (main HEAD after
  2026-10-10 recovery rebase; mission base was `531a84e8edcd4756ab3ab068fc42ea162906ed06`).
  Recovery: clean rebase onto `67ba33f3` ("docs: establish Mawjood autonomous
  governance and D0 planning" — ChatGPT bootstrap, 8 docs, merged to main
  2026-10-09). No filename collisions; merged bootstrap documents untouched.
  Pre-rebase backup ref: `d1/governance-foundation-backup` (@ `da6250f`).
  Auth re-check 2026-10-10: `POST /git/blobs` → 403 on both connectors
  (writes blocked post-transfer); reads fine. Push/PR/CI pending credential
  remediation — see "Remaining blockers".
- **Scope:** engineering governance document set + CI gates. No product
  code changes; no merges (owner merges directly); no deploys.
- **Changes (this batch):** 9 governance/support documents under
  `docs/autonomous/` —
  1. `PORTABILITY_AND_HANDOFF.md`
  2. `INCIDENT_RESPONSE.md`
  3. `AGENT_REGISTRY.md`
  4. `AUTONOMY_EVALUATION.md`
  5. `INSTRUCTION_VERSIONING.md`
  6. `IMPLEMENTATION_LEDGER.md` (this file)
  7. `CAPABILITY_REGISTRY.md`
  8. `BATCH_CONTRACT_TEMPLATE.md`
  9. `README.md`
  
  plus 5 sibling-owned documents in the same set —
  `START_HERE.md`, `ENGINEERING_CONSTITUTION.md`,
  `QUALITY_SECURITY_STANDARD.md`, `DEBUGGING_VERIFICATION_PROTOCOL.md`,
  `CONTEXT_ISOLATION_AND_RECOVERY.md`.
- **Review verdict:** pending (independent review required before PR).
- **CI evidence:** pending (CI gates to be established as part of D-1).
- **Decisions:**
  - Governance lives in `docs/autonomous/`, separate from product docs in
    `docs/` root (see `README.md` placement justification).
  - Agent-neutral language throughout (no provider-specific rules).
  - Autonomy levels L0–L3 (not App Factory's D0–D4); no package-factory
    concepts (no SemVer releases, no core tiers, no merge bans).
  - Owner merges directly; agents NEVER merge.
- **PR URL:** TBD (coordinator fills after opening).

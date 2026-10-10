# Capability Registry

**Status:** Mandatory reference for any agent planning or implementing
Mawjood product work.

**Purpose:** Track PRODUCT capabilities (not packages — Mawjood is an app,
not a package factory). Agents check this registry before building:
no duplicates, no re-implementing what exists, and new capabilities get
recorded here when they land.

## Statuses

- **PLANNED** — agreed in `docs/ROADMAP.md`, not yet built.
- **IN_PROGRESS** — being built now.
- **IMPLEMENTED** — built and merged. This is NOT a quality verdict.
- **VERIFIED** — implemented AND confirmed working against acceptance
  evidence (live test, independent review, or exact-acceptance run).
- **DEPRECATED** — retired by owner decision; kept for history, not to be
  revived without a new decision.

**Implemented ≠ verified.** A capability marked IMPLEMENTED may still carry
open verification gaps; those are noted per entry.

## Maintenance rules (agents)

1. Check this registry before starting any product work.
2. Do not build a capability that already exists under another name —
   extend it or record the rename.
3. When a capability lands, add or update its entry in the same change.
4. Status changes require evidence noted in the entry.
5. Product truth lives in `docs/PROJECT.md` (what exists) and
   `docs/ROADMAP.md` (what is agreed/planned); this registry is the
   status index over both. Do not contradict them.

## Capability index (seeded 2026-10-10 from PROJECT.md + ROADMAP.md)

### Input & extraction

| Capability | Status | Notes |
| ---------- | ------ | ----- |
| Voice → text transcription (Whisper) + immediate audio deletion | VERIFIED | Owner policy: audio deleted after transcription; photos kept |
| Text/voice/photo unified input bar | IMPLEMENTED | |
| Routing engine (`routing.ts`, hybrid classify) | VERIFIED | 10/10 classification test at build |
| Extraction engine (tasks/dates/purchases/places/expenses/borrows/specs/opinions/checklists) | IMPLEMENTED | |
| Note photos (capture, attach, view) | IMPLEMENTED | |
| Vision Q&A on attached photos | VERIFIED | Live E2E test 2026-09-23 |

### Chat & AI

| Capability | Status | Notes |
| ---------- | ------ | ----- |
| Chat-first home + unified agent brain (ReAct ≤5) | IMPLEMENTED | |
| Tab-aware AI (list/read/propose tabs + proposal cards) | IMPLEMENTED | Behavioral test deferred to owner's batched test round |
| Memory engine v2 (implicit learn + nightly consolidate + remember/forget/list tools) | IMPLEMENTED | Secrets/codes never memorized (invariant) |
| User memory facts ("call me…", preferences) | IMPLEMENTED | |
| Scope guard (deterministic out-of-scope interception) | VERIFIED | 62/62 behavior tests |
| Feedback buttons under answers | IMPLEMENTED | Learning signal only |
| Voice replies (on-device TTS, voice→voice / text→text) | IMPLEMENTED | |
| Chat history (sessions, per-chat delete countdown, retention as paid hook) | IMPLEMENTED | |
| AI governance (identity, hard rules, deterministic forbidden topics, governed capabilities w/ multi-approval, regression tests) | VERIFIED | Migration 0034 applied + verified by owner's expected-result query 2026-10-09; admin page functional |

### Things & home

| Capability | Status | Notes |
| ---------- | ------ | ----- |
| 📦 My things (item + place + price) | IMPLEMENTED | |
| 🤝 Borrowing tracking (who took it, due date, two-tap return) | VERIFIED | Owner-confirmed working 2026-09-24 |
| 🔍 Lost-item investigator (ranked search plan + interactive checklist) | IMPLEMENTED | |
| 📊 Habit learning ("usually in the living room — 9/10") | IMPLEMENTED | |
| 🛡️ Watch / prevention reminders (4h) | IMPLEMENTED | Migration 0022 pending owner run |
| 🕰️ Item timeline | IMPLEMENTED | |
| 💰 Home expenses (record + monthly/person summaries) | IMPLEMENTED | Migration 0021 pending owner run |
| ☀️ Morning digest ("what's on today?") | IMPLEMENTED | Auto 8am push is PLANNED (see below) |

### Family

| Capability | Status | Notes |
| ---------- | ------ | ----- |
| Spaces (private / family / work) + space switcher | IMPLEMENTED | Chat private to user (invariant) |
| Custom tabs (＋ name + emoji; 3 free per space) | IMPLEMENTED | |
| 📄 My papers tab (bills/passports) | IMPLEMENTED | |
| Family invites (code, 7d, 10 uses) + member management + kick w/ notice | IMPLEMENTED | |
| Multi-family switcher + slots paywall (first family free; original family never deletable) | IMPLEMENTED | Owner rule: "my family is never deleted" |
| 🛒 Shopping lists (directed per-person + push; bought→archive; not-found) | VERIFIED | Chat fast-path fix verified live 2026-10-08 |
| 🛒 Smart shopping ("what are we missing?" from purchase rhythms) | IMPLEMENTED | |
| ✅ Assignable tasks | IMPLEMENTED | |
| 📅 Shared agenda (week strip, WhatsApp share) | IMPLEMENTED | |
| 📣 Family broadcast ("ask the family…") | IMPLEMENTED | |
| 🗑️ Trash + 5-second undo | IMPLEMENTED | |

### Vaults & secrecy

| Capability | Status | Notes |
| ---------- | ------ | ----- |
| 🔐 Secret vaults (bcrypt fingerprints, 10-min HMAC mgmt capability, per-plan limits) | IMPLEMENTED | Golden rule: no visible trace of the secret feature is itself a bug |
| 👻 Ghost key + decoy vaults (fake world, mirrored decoy admin, decoy filler, voice intercept, hidden decoy trash, background lock, duress two-tap) | VERIFIED | Owner-confirmed "identical copy" 2026-09-26 |
| Vault isolation invariants (ordinary chat blind to vault_id; vault chat server-verified; no learning from vault sessions) | IMPLEMENTED | Security-critical; any breach = CRITICAL incident |

### Accounts, admin, platform

| Capability | Status | Notes |
| ---------- | ------ | ----- |
| Real accounts (email magic link; anonymous upgrades preserving data) | IMPLEMENTED | Supabase Redirect URLs allowlist still empty — owner action pending |
| Account export / account delete (vault hashes never exported) | IMPLEMENTED | |
| Admin console (stats / users / subscriptions / broadcasts; real kill-switches) | IMPLEMENTED | 3 kill-switches wired; 3 seeded not wired (see IN_PROGRESS) |
| Per-user AI quotas + honest 429s + per-call telemetry + crash reporting | IMPLEMENTED | |
| Per-user timezone | IMPLEMENTED | |
| 🌙 Dark mode (light/dark/auto) | IMPLEMENTED | |
| 🌐 Bilingual UI (AR/EN toggle) | IMPLEMENTED | Full RTL layout still IN_PROGRESS |
| 🎓 Interactive onboarding | IMPLEMENTED | |
| Web trial on GitHub Pages (public repo, HTTPS) | IMPLEMENTED | |
| Reusable engines (`routing.ts`, `memory.ts`, `app-brain.ts`, `packages/voice-engine`, `morningDigest.ts`, `expenses.ts`, `lostItem.ts`, `familyBroadcast.ts`, `scopeGuard.ts`, `smartShopping.ts`, `habits.ts`, `itemTimeline.ts`, `watch.ts`) | IMPLEMENTED | Owner rule: everything built as an engine must be extractable later |

### In progress

| Capability | Status | Notes |
| ---------- | ------ | ----- |
| Push reminders (pg_cron every 15 min) | IN_PROGRESS | Code deployed; migration 0020 pending owner run |
| Kill-switch wiring: voice_replies / extended_trash / extended_chat_history | IN_PROGRESS | Seeded, not yet wired |
| Full RTL Arabic layout | IN_PROGRESS | UI bilingual; layout direction-neutral, not full RTL |

### Planned (agreed, not built)

| Capability | Status | Notes |
| ---------- | ------ | ----- |
| "Ask your vault" — AI assistant inside the secret vault | PLANNED | Next vault step per owner strategy |
| Cloud file/document vault in secret tabs | PLANNED | |
| Telegram integration (official TDLib) | PLANNED | Approved; WhatsApp/Instagram/TikTok EXCLUDED — cloud bridging is a legal red line |
| Stripe subscriptions | PLANNED | Deferred by owner ("let's postpone payment") |
| EAS builds (iOS + Android) + Apple Developer + App Store submission | PLANNED | |
| iOS widget + Control Center button | PLANNED | |
| Siri Shortcuts | PLANNED | Needs native iOS code; comes with EAS |
| Alexa Skill | PLANNED | |
| Share sheet (send anything into Mawjood) | PLANNED | |
| Apple Watch quick-record | PLANNED | |
| Auto morning push (8am) | PLANNED | Same `morningDigest.ts` engine |
| Weekly review | PLANNED | |
| Semantic search (AR/EN) | PLANNED | |
| Promise extraction | PLANNED | |
| Dialect-tuned transcription | PLANNED | |
| Invite-by-link (viral loop) | PLANNED | |
| Location-based reminders | PLANNED | |
| Recurring tasks | PLANNED | |
| Auto-add extracted appointments to calendar | PLANNED | |
| Face ID lock for Private space | PLANNED | |
| Work expenses (monthly shop report) | PLANNED | Same `expenses.ts` engine, work space |
| Birthdays & occasions | PLANNED | |
| Old-recording import (WhatsApp voice, family videos) | PLANNED | |
| Long-term vision: "on this day last year", loved-ones' voices, family history across generations | PLANNED | The archive is the vision; daily use is the entry |

### Deprecated

| Capability | Status | Notes |
| ---------- | ------ | ----- |
| Source citations displayed in chat bubbles | DEPRECATED | Removed 2026-09-23 by owner decision (visual clutter); data retained in backend |
| Manual space picker in chat ("Save in:") | DEPRECATED | Removed 2026-09-23 by owner decision — AI routes directly |

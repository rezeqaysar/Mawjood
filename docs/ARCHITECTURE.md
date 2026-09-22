# Mawjood — Architecture (M1)

## Big picture
Voice-first family memory app. Record → transcribe → view, organized in
three spaces (private / family / work). API-first voice engine shared by
all clients.

## Monorepo
- `apps/mobile/` — Expo (SDK 57) + Expo Router, iOS & Android. npm workspaces
  hoist deps to the repo root; `metro.config.js` watches the workspace root.
- `packages/voice-engine/` — `@mawjood/voice-engine`: domain types + `VoiceEngine`
  client (Supabase-backed). Reusable by future apps (admin web, store app…).
- `supabase/` — `migrations/` (Postgres + RLS) and `functions/transcribe` (Deno).
- `docs/` — product & technical docs.

## M1 data flow (record → transcribe → view)
1. App records `.m4a` (expo-audio, HIGH_QUALITY) on device.
2. `VoiceEngine.saveVoiceNote()`:
   - inserts `notes` row (`status: uploading`)
   - uploads audio to Storage bucket `voice-notes` at `<userId>/<noteId>.m4a`
   - sets `audio_url`, `status: transcribing`
   - invokes the `transcribe` edge function
3. Edge function downloads audio → OpenAI `gpt-4o-mini-transcribe`
   ($0.003/min, 99+ languages incl. Arabic) → writes `transcript`,
   `language`, `status: ready` (or `failed` + error).
4. App polls `getNote()` every 3s until `ready` / `failed`.

## Privacy model
- Every note belongs to exactly one space; RLS enforces it (`can_access_space`).
- Owner has full access; `space_members` grant family/work access per space.
- Storage: users write only their own `<userId>/` folder; bucket is public-read
  (audio URLs are unguessable UUIDs — signed URLs come in M3).

## Env vars
| Where | Var | Purpose |
|---|---|---|
| mobile (`EXPO_PUBLIC_*`) | `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL |
| mobile | `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| edge function | `OPENAI_API_KEY` | transcription |
| edge function | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | DB write |

## What's next (M2)
Entity extraction (tasks, dates, purchases, item locations) from transcripts
via a second edge function + LLM; reminders.

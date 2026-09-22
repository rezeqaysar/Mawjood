# Mawjood — موجود

**Lost it? Mawjood.** — *Arabic for "found it."*

A voice-first family memory app: record a voice note, get it transcribed,
and let AI extract tasks, dates, purchases, and item locations — organized
across three spaces (private, family, work), with an assistant that reasons
across them.

- **Market:** US-first (Americans + Arab-Americans), bilingual EN/AR from day one
- **Stack:** Expo (React Native) · Supabase · `gpt-4o-mini-transcribe` · Cloudflare Pages
- **Architecture:** API-first voice-memory engine (reusable across apps)

## Status
M1 — project setup + speech-to-text pipeline (in progress)

## Structure
- `apps/mobile/` — Expo app (iOS + Android)
- `packages/voice-engine/` — API-first voice memory engine
- `supabase/` — migrations, edge functions, RLS policies
- `docs/` — product & technical docs

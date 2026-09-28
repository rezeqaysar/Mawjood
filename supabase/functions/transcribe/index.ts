// Supabase Edge Function: transcribe
// POST { note_id } → downloads the note's audio, transcribes it, writes
// transcript back to the note row.
//
// SECURITY (P0-1): the caller authenticates with their JWT and the note is
// read through the caller-scoped client first — RLS proves the caller may
// access it. Only then does the service_role client do the narrowly
// necessary writes. A user can never transcribe (or delete the audio of)
// another user's note by guessing its UUID.
// AI provider: Groq (free) when GROQ_API_KEY is set, else OpenAI.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//      INTERNAL_FN_SECRET, GROQ_API_KEY or OPENAI_API_KEY

import { aiConfig } from '../_shared/ai.ts';
import { checkRateLimit, rateLimitMessage } from '../_shared/rate-limit.ts';
import { logAi, logOps, newRequestId } from '../_shared/log.ts';
import {
  adminClient,
  authUserId,
  internalHeaders,
  userClient,
} from '../_shared/edge-auth.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const supabase = adminClient();

  // captured before try: the request body can only be read once,
  // so the catch block below can't re-read it to find note_id.
  let note_id: string | null = null;
  const requestId = newRequestId();

  try {
    ({ note_id } = await req.json());
    if (!note_id) throw new Error('note_id is required');

    // ── authorization ──────────────────────────────────────────────
    // Internal pipeline (never user-triggered directly): transcribe is only
    // ever invoked by the app, so every call must carry the caller's JWT.
    const callerId = await authUserId(req);
    if (!callerId) return json401();

    // Phase E P1-10: per-user transcription rate limiting (fail-open).
    const rl = await checkRateLimit(supabase, callerId, 'transcribe');
    if (!rl.allowed) {
      await logOps(supabase, {
        user_id: callerId, request_id: requestId,
        kind: 'rate_limit.hit', ok: false, detail: `transcribe:${rl.window}`,
      });
      return new Response(JSON.stringify({ ok: false, error: rateLimitMessage(true) }), {
        status: 429,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }
    // The note must be visible to the CALLER (RLS). 404 either way — never
    // reveal whether someone else's note exists.
    const caller = userClient(req);
    const { data: note, error: noteErr } = await caller
      .from('notes')
      .select('id, audio_url')
      .eq('id', note_id)
      .single();
    if (noteErr || !note?.audio_url) {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404, headers: cors });
    }
    // ── end authorization; service role below is now acting on the caller's
    // own note only ─────────────────────────────────────────────────

    // Parse the storage path out of the stored URL, then download with the
    // service role (the bucket is private — no public fetch).
    const marker = '/voice-notes/';
    const idx = note.audio_url.indexOf(marker);
    if (idx === -1) throw new Error('unparseable audio_url');
    const audioPath = decodeURIComponent(note.audio_url.slice(idx + marker.length));
    if (!audioPath) throw new Error('unparseable audio_url');
    const { data: audioBlob, error: dlErr } = await supabase.storage
      .from('voice-notes')
      .download(audioPath);
    if (dlErr || !audioBlob) throw new Error(`audio download failed: ${dlErr?.message ?? 'empty'}`);
    const audioBytes = await audioBlob.arrayBuffer();

    const filename = audioPath.endsWith('.m4a') ? 'audio.m4a' : 'audio.wav';
    const form = new FormData();
    form.append('file', new Blob([audioBytes]), filename);
    const ai = aiConfig();
    form.append('model', ai.transcribeModel);
    form.append('response_format', 'json');
    // Whisper hints: the prompt acts as a spelling/style bias for the decoder,
    // which cuts down mis-transcriptions of common dialectal words
    // (e.g. "آلة حاسبة" instead of "آل حاسب"). Language is left to
    // auto-detect so English notes keep working.
    form.append(
      'prompt',
      'Voice notes in Levantine Arabic or English. كلمات شائعة: آلة حاسبة، مفك، مطرقة، حليب، خبز، دواء، موعد، اجتماع، مدرسة، سوبرماركت. Common words: calculator, screwdriver, milk, bread, appointment, meeting.',
    );

    const trT0 = Date.now();
    const trRes = await fetch(`${ai.transcribeBase}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ai.transcribeKey}` },
      body: form,
    });
    if (!trRes.ok) {
      const body = await trRes.text();
      await logAi(supabase, {
        user_id: callerId, request_id: requestId, fn: 'transcribe',
        provider: ai.provider, model: ai.transcribeModel,
        latency_ms: Date.now() - trT0, status: trRes.status,
        error: `http_${trRes.status}`,
      });
      throw new Error(`${ai.provider} ${trRes.status}: ${body.slice(0, 300)}`);
    }
    const tr = await trRes.json();
    await logAi(supabase, {
      user_id: callerId, request_id: requestId, fn: 'transcribe',
      provider: ai.provider, model: ai.transcribeModel,
      latency_ms: Date.now() - trT0, status: trRes.status,
    });

    const { error: updErr } = await supabase
      .from('notes')
      .update({
        transcript: tr.text ?? '',
        language: tr.language ?? null,
        duration_sec: tr.duration ? Math.round(tr.duration) : null,
        status: 'ready',
        error: null,
      })
      .eq('id', note_id);
    if (updErr) throw updErr;

    // Audio retention policy (user decision 2026-09-23): text only.
    // The audio has served its purpose (transcription) — delete it so we
    // don't pay for storage. Photos are kept; audio is not.
    // Best-effort: a leftover file must never fail the transcription response.
    try {
      await supabase.storage.from('voice-notes').remove([audioPath]);
      await supabase.from('notes').update({ audio_url: null }).eq('id', note_id);
    } catch { /* ignore */ }

    // fire-and-forget: pull actionable items out of the transcript.
    // extract is internal-only — prove it with the shared secret.
    try {
      const base = Deno.env.get('SUPABASE_URL')!;
      fetch(`${base}/functions/v1/extract`, {
        method: 'POST',
        headers: internalHeaders(),
        body: JSON.stringify({ note_id }),
      }).catch(() => {});
    } catch { /* ignore */ }

    return new Response(JSON.stringify({ ok: true, text: tr.text }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    // best-effort: mark the note failed so the app stops polling.
    // Only when we got past authorization (note_id was the caller's own).
    if (note_id) {
      try {
        await supabase.from('notes').update({ status: 'failed', error: message }).eq('id', note_id);
      } catch { /* ignore */ }
    }
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});

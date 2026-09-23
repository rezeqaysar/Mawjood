// Supabase Edge Function: transcribe
// POST { note_id } → downloads the note's audio, transcribes it, writes
// transcript back to the note row.
// AI provider: Groq (free) when GROQ_API_KEY is set, else OpenAI.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY or OPENAI_API_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { aiConfig } from '../_shared/ai.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // captured before try: the request body can only be read once,
  // so the catch block below can't re-read it to find note_id.
  let note_id: string | null = null;

  try {
    ({ note_id } = await req.json());
    if (!note_id) throw new Error('note_id is required');

    const { data: note, error: noteErr } = await supabase
      .from('notes')
      .select('id, audio_url')
      .eq('id', note_id)
      .single();
    if (noteErr || !note?.audio_url) throw new Error('note or audio not found');

    // download audio (bucket is public, but service role works regardless)
    const audioRes = await fetch(note.audio_url);
    if (!audioRes.ok) throw new Error(`audio download failed: ${audioRes.status}`);
    const audioBytes = await audioRes.arrayBuffer();

    const filename = note.audio_url.includes('.m4a') ? 'audio.m4a' : 'audio.wav';
    const form = new FormData();
    form.append('file', new Blob([audioBytes]), filename);
    const ai = aiConfig();
    form.append('model', ai.transcribeModel);
    form.append('response_format', 'json');

    const trRes = await fetch(`${ai.base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ai.key}` },
      body: form,
    });
    if (!trRes.ok) {
      const body = await trRes.text();
      throw new Error(`${ai.provider} ${trRes.status}: ${body.slice(0, 300)}`);
    }
    const tr = await trRes.json();

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

    // fire-and-forget: pull actionable items out of the transcript.
    // extract runs with the service role; failures must not fail this response.
    try {
      const base = Deno.env.get('SUPABASE_URL')!;
      const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
      fetch(`${base}/functions/v1/extract`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          apikey: key,
        },
        body: JSON.stringify({ note_id }),
      }).catch(() => {});
    } catch { /* ignore */ }

    return new Response(JSON.stringify({ ok: true, text: tr.text }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    // best-effort: mark the note failed so the app stops polling
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

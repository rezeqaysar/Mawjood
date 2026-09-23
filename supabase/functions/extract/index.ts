// Supabase Edge Function: extract
// POST { note_id } → reads the note's transcript, asks the AI to pull out
// actionable items (tasks, appointments, shopping, place notes), stores them
// in public.items.
// AI provider: Groq (free) when GROQ_API_KEY is set, else OpenAI.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY or OPENAI_API_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { aiConfig } from '../_shared/ai.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const today = new Date().toISOString().slice(0, 10);

const SYSTEM = `You extract actionable items from a voice-note transcript.

LANGUAGE RULE (strict): every title and details string MUST be in the SAME language as the transcript. Arabic transcript → ALL titles in Arabic, never English. English transcript → ALL titles in English, never Arabic. Never mix languages in one response.

Return ONLY valid JSON: {"items":[{"kind":"task|appointment|shopping|place|spec|opinion|checklist","title":"...","details":"...","due_at":"ISO8601 datetime or null"}]}

Kinds:
- task: something to do (no specific date/time)
- appointment: a meeting or event with a date/time → set due_at. Today is ${today}; resolve relative days like "tomorrow" against it. Assume timezone America/New_York unless stated.
- shopping: things to buy → title is ONLY the item name, no verb: "حليب" not "شراء حليب", "milk" not "Buy milk". Split compounds into separate items: "almonds and bananas" → two items.
- place: where something was put or left ("I put the keys in the kitchen drawer")
- spec: a specification or measurement worth remembering (filter size, model number, phone number) → put the value in details
- opinion: something tried with a verdict ("tried that restaurant, didn't like it") → put the verdict in details
- checklist: things to remember/bring/do before an event ("before traveling: passport, charger") → one item per thing

Rules:
- Keep titles short (under 12 words); extra context goes in details.
- If nothing actionable was said, return {"items":[]}.
- Never invent dates or times that were not mentioned.`;

const KINDS = new Set(['task', 'appointment', 'shopping', 'place', 'spec', 'opinion', 'checklist']);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const { note_id } = await req.json();
    if (!note_id) throw new Error('note_id is required');

    const { data: note, error: noteErr } = await supabase
      .from('notes')
      .select('id, space_id, transcript')
      .eq('id', note_id)
      .single();
    if (noteErr || !note) throw new Error('note not found');

    const empty = { ok: true, items: [] };
    if (!note.transcript?.trim()) {
      return new Response(JSON.stringify(empty), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const aiCfg = aiConfig();
    const aiRes = await fetch(`${aiCfg.base}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aiCfg.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: aiCfg.chatModel,
        response_format: { type: 'json_object' },
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: note.transcript },
        ],
      }),
    });
    if (!aiRes.ok) {
      const body = await aiRes.text();
      throw new Error(`${aiCfg.provider} ${aiRes.status}: ${body.slice(0, 300)}`);
    }
    const ai = await aiRes.json();

    let parsed: {
      items?: Array<{ kind: string; title: string; details?: string; due_at?: string | null }>;
    } = {};
    try {
      parsed = JSON.parse(ai.choices?.[0]?.message?.content ?? '{}');
    } catch {
      parsed = {};
    }
    const raw = Array.isArray(parsed.items) ? parsed.items : [];

    const rows = raw
      .filter(
        (it) =>
          it &&
          typeof it.title === 'string' &&
          it.title.trim().length > 0 &&
          KINDS.has(it.kind),
      )
      .slice(0, 20)
      .map((it) => {
        let due: string | null = null;
        if (it.due_at) {
          const d = new Date(it.due_at);
          if (!Number.isNaN(d.getTime())) due = d.toISOString();
        }
        return {
          space_id: note.space_id,
          note_id: note.id,
          kind: it.kind,
          title: it.title.trim().slice(0, 200),
          details: typeof it.details === 'string' ? it.details.slice(0, 1000) : null,
          due_at: due,
          status: 'open',
        };
      });

    if (rows.length > 0) {
      // Re-read the note's CURRENT space: the client may have moved the note
      // (AI space classification) while extraction was running — items must
      // follow the note, not the stale space_id read at the start.
      const { data: freshNote } = await supabase
        .from('notes')
        .select('space_id')
        .eq('id', note.id)
        .single();
      const liveSpaceId = freshNote?.space_id ?? note.space_id;
      for (const r of rows) r.space_id = liveSpaceId;
      // de-dupe: skip items that already exist as open in this space
      // (same kind + same normalized title) — repeated notes shouldn't
      // pile up identical shopping items.
      const norm = (t: string) =>
        t
          .toLowerCase()
          .replace(/[ً-ٰٟ]/g, '')
          .replace(/ـ/g, '')
          .replace(/[أإآٱ]/g, 'ا')
          .replace(/ة/g, 'ه')
          .replace(/ى/g, 'ي')
          .replace(/^(شراء|شرا|buy|buying)\s+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      const { data: existing } = await supabase
        .from('items')
        .select('kind, title')
        .eq('space_id', note.space_id)
        .neq('status', 'done');
      const seen = new Set(
        (existing ?? []).map((e) => `${e.kind}:${norm(e.title)}`),
      );
      const fresh = rows.filter((r) => {
        const k = `${r.kind}:${norm(r.title)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (fresh.length > 0) {
        const { error: insErr } = await supabase.from('items').insert(fresh);
        if (insErr) throw insErr;
      }
    }

    return new Response(JSON.stringify({ ok: true, items: rows }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});

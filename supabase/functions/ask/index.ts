// Supabase Edge Function: ask
// POST { question, space_id? } → gathers the user's notes + extracted items
// as context, asks the AI, returns { answer, sources: [{note_id, snippet}] }.
// Uses the caller's JWT with the anon key so RLS applies (never service role).
// AI provider: Groq (free) when GROQ_API_KEY is set, else OpenAI.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, GROQ_API_KEY or OPENAI_API_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { aiConfig } from '../_shared/ai.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SYSTEM = `You answer questions about the user's own notes. The notes may be in Arabic or English — answer in the SAME language as the question (Levantine-friendly Arabic when the question is Arabic), briefly and directly.

You get context: transcribed notes (with dates) and extracted items (tasks, appointments, shopping, places, specs, opinions, checklists).

Rules:
- SYNTHESIZE an answer from the context — never just echo a transcript back.
- Answer ONLY from the context. Never invent facts, dates, or places.
- If the context doesn't contain the answer, say so honestly (e.g. "ما لقيت هالمعلومة بملاحظاتك").
- Keep the answer short (1-3 sentences) unless the question asks for a list.
- Output MUST be a single JSON object, nothing else: {"answer":"...","source_note_ids":["uuid", ...]}
- source_note_ids: ids of the notes that support your answer (empty array if none).`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { question, space_id } = await req.json();
    if (!question?.trim()) throw new Error('question is required');

    const auth = req.headers.get('Authorization') ?? '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: auth } } },
    );

    let notesQ = supabase
      .from('notes')
      .select('id, transcript, created_at, space_id')
      .not('transcript', 'is', null)
      .order('created_at', { ascending: false })
      .limit(25);
    let itemsQ = supabase
      .from('items')
      .select('id, note_id, kind, title, details, due_at, status, space_id')
      .order('created_at', { ascending: false })
      .limit(60);
    if (space_id) {
      notesQ = notesQ.eq('space_id', space_id);
      itemsQ = itemsQ.eq('space_id', space_id);
    }
    const [{ data: notes, error: nErr }, { data: items, error: iErr }] =
      await Promise.all([notesQ, itemsQ]);
    if (nErr) throw nErr;
    if (iErr) throw iErr;

    const clip = (t: string, len = 200) =>
      t.length > len ? t.slice(0, len) + '…' : t;
    const noteLines = (notes ?? [])
      .filter((n) => n.transcript?.trim())
      .map(
        (n) =>
          `[note ${n.id} @ ${n.created_at.slice(0, 10)}] ${clip(n.transcript!.trim())}`,
      );
    const itemLines = (items ?? []).map(
      (it) =>
        `[${it.kind}${it.status === 'done' ? '/done' : ''}] ${it.title}${
          it.details ? ` — ${it.details}` : ''
        }${it.due_at ? ` (due ${it.due_at.slice(0, 10)})` : ''} (note ${it.note_id})`,
    );
    const context = [...noteLines, ...itemLines].join('\n');

    const ai = aiConfig();
    const payload = JSON.stringify({
      model: ai.chatModel,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: `Context:\n${context || '(no notes yet)'}\n\nQuestion: ${question}\n\nReturn ONLY JSON.`,
        },
      ],
    });
    // Groq's free tier rate-limits aggressively (429/503 under bursts) —
    // wait a few seconds and retry once before giving up.
    let aiRes: Response | null = null;
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      aiRes = await fetch(`${ai.base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ai.key}`,
          'Content-Type': 'application/json',
        },
        body: payload,
      });
      if (aiRes.ok) break;
      lastErr = `${ai.provider} ${aiRes.status}: ${(await aiRes.text()).slice(0, 200)}`;
      if ((aiRes.status === 429 || aiRes.status === 503) && attempt === 0) {
        await new Promise((r) => setTimeout(r, 3500));
        continue;
      }
      break;
    }
    if (!aiRes!.ok) throw new Error(lastErr);
    const aiJson = await aiRes.json();
    const raw = (aiJson.choices?.[0]?.message?.content?.trim() ?? '{}')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    let parsed: { answer?: string; source_note_ids?: string[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      // try to salvage a JSON object embedded in surrounding text
      const m = raw.match(/\{[\s\S]*\}/);
      try {
        parsed = m ? JSON.parse(m[0]) : { answer: '', source_note_ids: [] };
      } catch {
        parsed = { answer: '', source_note_ids: [] };
      }
    }
    if (!parsed.answer?.trim()) {
      parsed.answer = 'ما قدرت أفهم الجواب — جرّب تصيغ السؤال بطريقة ثانية.';
      parsed.source_note_ids = [];
    }

    const noteById = new Map((notes ?? []).map((n) => [n.id, n]));
    const sources = (parsed.source_note_ids ?? [])
      .filter((id) => noteById.has(id))
      .slice(0, 3)
      .map((id) => {
        const n = noteById.get(id)!;
        const t = (n.transcript ?? '').trim();
        return { note_id: id, snippet: t.length > 90 ? t.slice(0, 90) + '…' : t };
      });

    return new Response(
      JSON.stringify({ answer: parsed.answer ?? '', sources }),
      { headers: { ...cors, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});

// ── 🧠 memory-learn: implicit learning ("التطبيق بيتعلم زي Muse") ──────────
// Called fire-and-forget after EVERY chat turn with:
//   { user_text, assistant_text, ui_lang }
// One cheap model call extracts DURABLE facts → upserts them into the user's
// private memory store (same items kind='memory' + mkey dedupe as the
// client's explicit "ناديني X" parser). Never blocks the reply; never throws
// to the caller (best-effort by design).
//
// Privacy: owner-only (user JWT, private space). The extraction prompt has a
// hard rule — secrets/codes/passwords are NEVER memorized.

import { aiConfig } from '../_shared/ai.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  learnSystem,
  parseLearned,
  upsertFacts,
  pruneFacts,
  loadFacts,
  privateSpaceId,
} from '../_shared/memory.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

async function callModel(ai: any, system: string, user: string): Promise<string> {
  const r = await fetch(`${ai.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ai.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ai.chatModel,
      temperature: 0.2,
      max_tokens: 500,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`model ${r.status}`);
  const j = await r.json();
  return (j.choices?.[0]?.message?.content ?? '').trim();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { user_text, assistant_text, ui_lang } = await req.json();
    const t = String(user_text ?? '').slice(0, 800).trim();
    const a = String(assistant_text ?? '').slice(0, 800).trim();
    if (!t || !a) return new Response(JSON.stringify({ learned: 0 }), { headers: cors });

    const auth = req.headers.get('Authorization') ?? '';
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData } = await supa.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) throw new Error('not authenticated');

    const pid = await privateSpaceId(supa);
    if (!pid) throw new Error('no private space');

    const existing = await loadFacts(supa, pid);
    const ai = aiConfig();
    const raw = await callModel(
      ai,
      learnSystem(existing, ui_lang !== 'en'),
      `user: ${t}\nassistant: ${a}`,
    );
    const facts = parseLearned(raw);
    if (facts.length === 0) {
      return new Response(JSON.stringify({ learned: 0 }), { headers: cors });
    }
    const { saved, updated } = await upsertFacts(supa, pid, userId, facts, 'learned');
    const pruned = await pruneFacts(supa, pid);
    return new Response(JSON.stringify({ learned: saved + updated, saved, updated, pruned }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    // best-effort: the chat reply already went out; learning must never fail it
    return new Response(JSON.stringify({ learned: 0, error: e instanceof Error ? e.message : 'unknown' }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});

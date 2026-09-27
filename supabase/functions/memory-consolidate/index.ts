// ── 🧠 memory-consolidate: nightly memory maintenance ───────────────────────
// Runs once a day (cron, service_role). For every user active in the last
// 24h it:
//   1. writes a daily EPISODE ("ملخص ٢٧ سبتمبر: ...") from today's notes —
//      the "what happened today" layer, like Muse's daily logs
//   2. merges near-duplicate facts (same normalized content → keep newest,
//      reinforce importance)
//   3. decays: importance-1 facts untouched for 90 days are forgotten
//   4. caps the store at 200 facts/user (weakest go first)
//
// Auth: service_role key in the Authorization header (cron only, never the
// client). Trigger: POST with an empty body.

import { aiConfig } from '../_shared/ai.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  loadFacts,
  upsertFacts,
  pruneFacts,
  normAr,
  factLine,
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
      max_tokens: 400,
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

const EPISODE_SYSTEM = `You write a ONE-paragraph daily diary summary (2-4 sentences) of what the user did today, in Levantine Arabic. Only durable, meaningful events: appointments kept, things bought, people met, decisions made. Skip trivia. Reply with ONLY the paragraph, no title, no bullets. If there is nothing meaningful, reply with exactly: NOTHING`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const auth = req.headers.get('Authorization') ?? '';
    if (auth !== `Bearer ${key}` || !key) throw new Error('forbidden');

    const supa = createClient(Deno.env.get('SUPABASE_URL')!, key);
    const ai = aiConfig();
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const todayStr = new Date().toISOString().slice(0, 10);

    // users active in the last 24h (note authors)
    const { data: recent } = await supa
      .from('notes')
      .select('created_by')
      .gte('created_at', since)
      .is('deleted_at', null)
      .limit(2000);
    const userIds = [...new Set((recent ?? []).map((r: any) => r.created_by).filter(Boolean))];

    const report: Record<string, any> = { users: userIds.length, episodes: 0, merged: 0, decayed: 0, pruned: 0 };

    for (const uid of userIds) {
      // private space of this user
      const { data: sp } = await supa.from('spaces').select('id').eq('type', 'private').eq('owner_id', uid).limit(1).maybeSingle();
      const pid = (sp as any)?.id;
      if (!pid) continue;

      // 1) daily episode from today's notes
      const { data: notes } = await supa
        .from('notes')
        .select('transcript, created_at')
        .eq('created_by', uid)
        .gte('created_at', since)
        .is('deleted_at', null)
        .order('created_at')
        .limit(40);
      const texts = (notes ?? []).map((n: any) => String(n.transcript ?? '').slice(0, 200)).filter((s: string) => s.trim());
      if (texts.length > 0) {
        try {
          const summary = await callModel(ai, EPISODE_SYSTEM, texts.join('\n'));
          if (summary && summary !== 'NOTHING' && summary.length > 20) {
            const { saved } = await upsertFacts(supa, pid, uid, [{
              content: summary.slice(0, 500),
              mkey: `episode:${todayStr}`,
              mcat: 'episode',
              importance: 3,
            }], 'episode');
            report.episodes += saved;
          }
        } catch { /* best effort per user */ }
      }

      // 2) merge near-duplicates (same normalized content → keep newest)
      const facts = await loadFacts(supa, pid);
      const seen = new Map<string, any>();
      for (const f of facts) {
        if (f.meta?.mcat === 'episode') continue;
        const k = normAr(factLine(f));
        const prev = seen.get(k);
        if (prev) {
          const keepNewer = new Date(f.updated_at) >= new Date(prev.updated_at);
          const keep = keepNewer ? f : prev;
          const drop = keepNewer ? prev : f;
          await supa.from('items').update({
            details: factLine(keep),
            meta: { ...(keep.meta ?? {}), importance: Math.min(5, Number(keep.meta?.importance ?? 3) + 1) },
          }).eq('id', keep.id);
          await supa.from('items').delete().eq('id', drop.id);
          report.merged++;
          seen.set(k, keep);
        } else {
          seen.set(k, f);
        }
      }

      // 3) decay: importance-1 facts untouched for 90 days are forgotten
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      const { data: stale } = await supa
        .from('items')
        .select('id')
        .eq('space_id', pid)
        .eq('kind', 'memory')
        .eq('status', 'open')
        .lt('updated_at', cutoff)
        .limit(50);
      for (const s of stale ?? []) {
        const { data: row } = await supa.from('items').select('meta').eq('id', (s as any).id).single();
        if (Number((row as any)?.meta?.importance ?? 3) <= 1) {
          await supa.from('items').delete().eq('id', (s as any).id);
          report.decayed++;
        }
      }

      // 4) cap
      report.pruned += await pruneFacts(supa, pid);
    }

    return new Response(JSON.stringify(report), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return new Response(JSON.stringify({ error: msg }), {
      status: msg === 'forbidden' ? 403 : 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});

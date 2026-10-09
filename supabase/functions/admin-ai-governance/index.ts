// admin-ai-governance: the admin's control panel over the agent.
// Auth: `x-admin-token` header must equal the ADMIN_TOKEN secret (service_role).
//
// POST { "action": "get" } → { governance, audit, evals }
// POST { "action": "update", ...fields, "changed_by"? } → new version + audit row
// POST { "action": "eval.add", "question", "category"?, "expect"? }
// POST { "action": "eval.update", "id", ...fields }
// POST { "action": "eval.toggle", "id", "enabled" }
// POST { "action": "eval.delete", "id" }
// POST { "action": "eval.run", "as_user_id", "ids"? } → runs enabled eval
//   questions through the chat fn (internal call, eval_mode) and returns
//   the raw answers so the admin can verify behavior after governance edits.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { internalHeaders } from '../_shared/edge-auth.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UPDATE_FIELDS = [
  'persona_ar', 'persona_en', 'hard_rules', 'forbidden_topics',
  'refusal_ar', 'refusal_en', 'capabilities',
];

const CAP_KEYS = [
  'can_add_tabs', 'can_delete_tabs', 'can_add_spaces', 'can_delete_spaces',
  'approvals_required', 'require_paid_for_extra',
];

function pick(src: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

// deno-lint-ignore no-explicit-any
function sanitizeCaps(raw: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of CAP_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (k === 'approvals_required') {
      const n = Math.floor(Number(v));
      if (!Number.isFinite(n) || n < 1 || n > 5) throw new Error('approvals_required بين 1 و 5');
      out[k] = n;
    } else {
      out[k] = v === true || v === 'true';
    }
  }
  return out;
}

// deno-lint-ignore no-explicit-any
function sanitizeRules(raw: any): unknown[] {
  if (!Array.isArray(raw)) throw new Error('hard_rules لازم تكون قائمة');
  return raw.slice(0, 50).map((r: any, i: number) => ({
    id: String(r?.id ?? `rule-${i}`).slice(0, 40),
    text_ar: String(r?.text_ar ?? '').slice(0, 500),
    text_en: String(r?.text_en ?? '').slice(0, 500),
    enabled: r?.enabled !== false,
  })).filter((r) => r.text_ar || r.text_en);
}

// deno-lint-ignore no-explicit-any
function sanitizeTopics(raw: any): unknown[] {
  if (!Array.isArray(raw)) throw new Error('forbidden_topics لازم تكون قائمة');
  return raw.slice(0, 100).map((t: any, i: number) => ({
    id: String(t?.id ?? `topic-${i}`).slice(0, 40),
    label_ar: String(t?.label_ar ?? '').slice(0, 120),
    label_en: String(t?.label_en ?? '').slice(0, 120),
    patterns: Array.isArray(t?.patterns) ? t.patterns.map((p: unknown) => String(p).slice(0, 120)).filter((p: string) => p).slice(0, 30) : [],
    enabled: t?.enabled !== false,
  })).filter((t) => t.label_ar && t.patterns.length > 0);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const ok = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  const expected = Deno.env.get('ADMIN_TOKEN') ?? '';
  const got = req.headers.get('x-admin-token') ?? '';
  if (!expected || got !== expected) return err('غير مصرح', 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err('JSON غلط');
  }

  const action = String(body.action ?? '');
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey);

    if (action === 'get') {
      const [gov, audit, evals] = await Promise.all([
        admin.from('ai_governance').select('*').eq('is_active', true).limit(1).maybeSingle(),
        admin.from('ai_governance_audit').select('version, changed_by, summary, created_at').order('created_at', { ascending: false }).limit(50),
        admin.from('ai_evals').select('*').order('created_at'),
      ]);
      if (gov.error) throw gov.error;
      return ok({ governance: gov.data ?? null, audit: audit.data ?? [], evals: evals.data ?? [] });
    }

    if (action === 'update') {
      const { data: cur, error: curErr } = await admin
        .from('ai_governance').select('*').eq('is_active', true).limit(1).maybeSingle();
      if (curErr) throw curErr;
      if (!cur) return err('لا يوجد صف حوكمة نشط — شغّل migration 0034');

      const patch = pick(body, UPDATE_FIELDS);
      // deno-lint-ignore no-explicit-any
      if ('hard_rules' in patch) patch.hard_rules = sanitizeRules(patch.hard_rules as any);
      // deno-lint-ignore no-explicit-any
      if ('forbidden_topics' in patch) patch.forbidden_topics = sanitizeTopics(patch.forbidden_topics as any);
      if ('capabilities' in patch) {
        // deno-lint-ignore no-explicit-any
        patch.capabilities = { ...(cur.capabilities ?? {}), ...sanitizeCaps(patch.capabilities as any) };
      }
      for (const k of ['persona_ar', 'persona_en', 'refusal_ar', 'refusal_en']) {
        if (k in patch) patch[k] = String(patch[k] ?? '').slice(0, 4000);
      }
      if (Object.keys(patch).length === 0) return err('ما فيه حقول للتعديل');

      // versioned update: retire the old row, insert the new one (history kept)
      const next = {
        ...cur,
        ...patch,
        id: undefined,
        is_active: true,
        version: (cur.version ?? 1) + 1,
        updated_by: String(body.changed_by ?? 'admin').slice(0, 120),
        updated_at: new Date().toISOString(),
      };
      delete (next as Record<string, unknown>).id;
      const { data: inserted, error: insErr } = await admin
        .from('ai_governance').insert(next).select().single();
      if (insErr) throw insErr;
      await admin.from('ai_governance').update({ is_active: false }).eq('id', cur.id);
      const changedKeys = Object.keys(patch).join('، ');
      await admin.from('ai_governance_audit').insert({
        governance_id: inserted.id,
        version: inserted.version,
        changed_by: String(body.changed_by ?? 'admin').slice(0, 120),
        summary: `تعديل: ${changedKeys}`,
      });
      return ok({ ok: true, governance: inserted });
    }

    // ── evals ──
    if (action === 'eval.add') {
      const question = String(body.question ?? '').trim().slice(0, 500);
      if (!question) return err('ناقص السؤال');
      const { data, error } = await admin.from('ai_evals').insert({
        question,
        category: String(body.category ?? 'general').slice(0, 40),
        expect: String(body.expect ?? '').slice(0, 300),
      }).select().single();
      if (error) throw error;
      return ok({ ok: true, eval: data });
    }

    if (action === 'eval.update') {
      const id = String(body.id ?? '');
      if (!id) return err('ناقص id');
      const patch = pick(body, ['question', 'category', 'expect']);
      if ('question' in patch) patch.question = String(patch.question).slice(0, 500);
      if (Object.keys(patch).length === 0) return err('ما فيه حقول للتعديل');
      const { data, error } = await admin.from('ai_evals').update(patch).eq('id', id).select().single();
      if (error) throw error;
      return ok({ ok: true, eval: data });
    }

    if (action === 'eval.toggle') {
      const id = String(body.id ?? '');
      if (!id) return err('ناقص id');
      const { data, error } = await admin.from('ai_evals')
        .update({ enabled: body.enabled !== false }).eq('id', id).select().single();
      if (error) throw error;
      return ok({ ok: true, eval: data });
    }

    if (action === 'eval.delete') {
      const id = String(body.id ?? '');
      if (!id) return err('ناقص id');
      const { error } = await admin.from('ai_evals').delete().eq('id', id);
      if (error) throw error;
      return ok({ ok: true });
    }

    if (action === 'eval.run') {
      const asUserId = String(body.as_user_id ?? '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(asUserId)) return err('as_user_id لازم يكون UUID مستخدم حقيقي (انسخه من تبويب المستخدمين)');
      let q = admin.from('ai_evals').select('id, question, category, expect').eq('enabled', true).order('created_at');
      if (Array.isArray(body.ids) && body.ids.length > 0) {
        q = q.in('id', (body.ids as unknown[]).map(String).slice(0, 20));
      }
      const { data: evals, error: evalErr } = await q;
      if (evalErr) throw evalErr;
      const results: unknown[] = [];
      for (const ev of (evals ?? []).slice(0, 20)) {
        try {
          const r = await fetch(`${url}/functions/v1/chat`, {
            method: 'POST',
            headers: internalHeaders(),
            body: JSON.stringify({
              text: ev.question,
              history: [],
              today: new Date().toISOString().slice(0, 10),
              ui_lang: 'ar',
              eval_mode: true,
              as_user_id: asUserId,
            }),
          });
          const j = await r.json().catch(() => ({}));
          // deno-lint-ignore no-explicit-any
          results.push({ id: ev.id, question: ev.question, category: ev.category, expect: ev.expect, answer: (j as any)?.answer ?? String((j as any)?.error ?? 'no answer'), actions: (j as any)?.actions ?? [] });
        } catch (e) {
          results.push({ id: ev.id, question: ev.question, error: e instanceof Error ? e.message : 'failed' });
        }
      }
      return ok({ ok: true, results });
    }

    return err('action غلط');
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    console.error('admin-ai-governance failed:', msg);
    return err(msg, 500);
  }
});

// admin-catalog: manage the billing catalog — plans, feature flags, promotions.
// Auth: `x-admin-token` header must equal the ADMIN_TOKEN secret (service_role).
//
// POST { "action": "get" } → { plans, features, promos }
// POST { "action": "plan.update", "id", ...fields }
// POST { "action": "plan.create", "id", "name_ar", "name_en", ... }
// POST { "action": "feature.toggle", "key", "enabled" }
// POST { "action": "feature.update", "key", ...fields }
// POST { "action": "promo.create", ... } | { "action": "promo.update", "id", ... }
//      | { "action": "promo.toggle", "id", "enabled" }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PLAN_FIELDS = ['name_ar', 'name_en', 'price_cents', 'currency', 'duration_days', 'features', 'active', 'sort'];
const FEATURE_FIELDS = ['name_ar', 'description_ar', 'enabled', 'plan_id'];
const PROMO_FIELDS = ['code', 'name_ar', 'discount_percent', 'free_days', 'applies_to', 'max_uses', 'starts_at', 'ends_at', 'active'];

function pick(src: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (src[f] !== undefined) out[f] = src[f];
  return out;
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
      const [plans, features, promos] = await Promise.all([
        admin.from('subscription_plans').select('*').order('sort').order('id'),
        admin.from('feature_flags').select('*').order('key'),
        admin.from('promotions').select('*').order('created_at', { ascending: false }).limit(200),
      ]);
      if (plans.error) throw plans.error;
      if (features.error) throw features.error;
      if (promos.error) throw promos.error;
      return ok({ plans: plans.data, features: features.data, promos: promos.data });
    }

    // ── plans ──
    if (action === 'plan.update') {
      const id = String(body.id ?? '').trim();
      if (!id) return err('ناقص id الخطة');
      const patch = pick(body, PLAN_FIELDS);
      if ('price_cents' in patch && patch.price_cents !== null) {
        const p = Number(patch.price_cents);
        if (!Number.isInteger(p) || p < 0) return err('السعر لازم يكون رقم صحيح موجب أو فاضي');
        patch.price_cents = p;
      }
      if ('duration_days' in patch) {
        const d = Number(patch.duration_days);
        if (!Number.isInteger(d) || d <= 0) return err('المدة لازم تكون أيام موجبة');
        patch.duration_days = d;
      }
      if ('features' in patch && !Array.isArray(patch.features)) return err('features لازم تكون قائمة');
      if (Object.keys(patch).length === 0) return err('ما فيه حقول للتعديل');
      const { data, error } = await admin.from('subscription_plans').update(patch).eq('id', id).select().single();
      if (error) throw error;
      return ok({ ok: true, plan: data });
    }

    if (action === 'plan.create') {
      const id = String(body.id ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!id) return err('ناقص id الخطة (حروف إنجليزية وأرقام و_)');
      const row = { id, ...pick(body, PLAN_FIELDS) };
      if (!row.name_ar || !row.name_en) return err('ناقص اسم الخطة');
      if (row.price_cents !== undefined && row.price_cents !== null) {
        const p = Number(row.price_cents);
        if (!Number.isInteger(p) || p < 0) return err('السعر لازم يكون رقم صحيح موجب أو فاضي');
        row.price_cents = p;
      }
      const { data, error } = await admin.from('subscription_plans').insert(row).select().single();
      if (error) throw error;
      return ok({ ok: true, plan: data });
    }

    // ── feature flags ──
    if (action === 'feature.toggle') {
      const key = String(body.key ?? '').trim();
      if (!key) return err('ناقص key');
      const { data, error } = await admin
        .from('feature_flags')
        .update({ enabled: body.enabled !== false })
        .eq('key', key)
        .select()
        .single();
      if (error) throw error;
      return ok({ ok: true, feature: data });
    }

    if (action === 'feature.update') {
      const key = String(body.key ?? '').trim();
      if (!key) return err('ناقص key');
      const patch = pick(body, FEATURE_FIELDS);
      if (Object.keys(patch).length === 0) return err('ما فيه حقول للتعديل');
      const { data, error } = await admin.from('feature_flags').update(patch).eq('key', key).select().single();
      if (error) throw error;
      return ok({ ok: true, feature: data });
    }

    // ── promotions ──
    if (action === 'promo.create') {
      const code = String(body.code ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (!code) return err('ناقص كود العرض');
      const row = { code, name_ar: String(body.name_ar ?? '').trim(), ...pick(body, PROMO_FIELDS) };
      delete row.code;
      if (!row.name_ar) return err('ناقص اسم العرض');
      const d = Number(row.discount_percent ?? 0);
      if (!Number.isInteger(d) || d < 0 || d > 100) return err('الخصم لازم يكون بين 0 و 100');
      row.discount_percent = d;
      const fd = Number(row.free_days ?? 0);
      if (!Number.isInteger(fd) || fd < 0) return err('الأيام المجانية لازم تكون رقم موجب');
      row.free_days = fd;
      const ts = (v: unknown): string | null => {
        if (v === null || v === undefined || v === '') return null;
        const dt = new Date(String(v));
        return isNaN(dt.getTime()) ? null : dt.toISOString();
      };
      row.starts_at = ts(row.starts_at);
      row.ends_at = ts(row.ends_at);
      if (row.max_uses !== undefined && row.max_uses !== null && row.max_uses !== '') {
        const mu = Number(row.max_uses);
        if (!Number.isInteger(mu) || mu <= 0) return err('الحد الأقصى للاستخدام لازم يكون رقم موجب');
        row.max_uses = mu;
      } else {
        row.max_uses = null;
      }
      const { data, error } = await admin.from('promotions').insert({ code, ...row }).select().single();
      if (error) throw error;
      return ok({ ok: true, promo: data });
    }

    if (action === 'promo.update') {
      const id = String(body.id ?? '').trim();
      if (!id) return err('ناقص id العرض');
      const patch = pick(body, PROMO_FIELDS);
      if ('discount_percent' in patch) {
        const d = Number(patch.discount_percent);
        if (!Number.isInteger(d) || d < 0 || d > 100) return err('الخصم لازم يكون بين 0 و 100');
        patch.discount_percent = d;
      }
      if ('code' in patch) patch.code = String(patch.code).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
      if (Object.keys(patch).length === 0) return err('ما فيه حقول للتعديل');
      const { data, error } = await admin.from('promotions').update(patch).eq('id', id).select().single();
      if (error) throw error;
      return ok({ ok: true, promo: data });
    }

    if (action === 'promo.toggle') {
      const id = String(body.id ?? '').trim();
      if (!id) return err('ناقص id العرض');
      const { data, error } = await admin
        .from('promotions')
        .update({ active: body.enabled !== false })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return ok({ ok: true, promo: data });
    }

    return err('action غلط');
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    console.error('admin-catalog failed:', msg);
    return err(msg, 500);
  }
});

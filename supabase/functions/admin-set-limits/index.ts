// admin-set-limits: manually grant/adjust a user's paid limits
// (family slots, secret vaults, chat/trash retention, custom tabs).
// This is the manual side of subscriptions until Stripe is wired.
// Auth: `x-admin-token` header must equal the ADMIN_TOKEN secret.
// Uses service_role (bypasses RLS) — never expose without the token check.
//
// POST body: { "email": "u@x.com" } OR { "user_id": "uuid" },
//            plus { "limits": { "family_slots": 3, ... } }
//            plus optional { "expires_at": "2026-12-31", "note": "..." }
//              (logged per-limit in subscription_grants; null expiry = permanent)
// Only known limit keys are accepted; values are clamped to sane ranges.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// key -> [min, max]. Free-tier values live in the app; admin can raise/lower.
const LIMITS: Record<string, [number, number]> = {
  family_slots: [1, 100],
  chat_retention_days: [0, 3650],
  trash_retention_days: [0, 3650],
  secret_vaults_limit: [1, 100],
  custom_tabs_limit: [0, 100],
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const ok = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  const expected = Deno.env.get('ADMIN_TOKEN') ?? '';
  const got = req.headers.get('x-admin-token') ?? '';
  if (!expected || got !== expected) return err('غير مصرح', 401);

  let body: { email?: string; user_id?: string; limits?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return err('JSON غلط');
  }

  const limits = body?.limits ?? {};
  const keys = Object.keys(limits).filter((k) => k in LIMITS);
  if (keys.length === 0) return err('ما فيه حدود صالحة للتعديل');

  const patch: Record<string, number> = {};
  for (const k of keys) {
    const v = limits[k];
    if (typeof v !== 'number' || !Number.isInteger(v)) return err(`القيمة لـ ${k} لازم تكون رقم صحيح`);
    const [lo, hi] = LIMITS[k];
    if (v < lo || v > hi) return err(`القيمة لـ ${k} لازم تكون بين ${lo} و ${hi}`);
    patch[k] = v;
  }

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey);

    // resolve the user id
    let userId = (body.user_id ?? '').trim();
    let email: string | null = null;
    if (!userId) {
      email = (body.email ?? '').trim().toLowerCase();
      if (!email) return err('ابعث email أو user_id');
      let page = 1;
      for (;;) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === email);
        if (hit) {
          userId = hit.id;
          email = hit.email ?? email;
          break;
        }
        if (data.users.length < 1000 || page >= 20) break;
        page++;
      }
      if (!userId) return err('ما لقيت مستخدم بهالإيميل');
    } else {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      if (error || !data.user) return err('ما لقيت مستخدم بهالـ id');
      email = data.user.email ?? null;
    }

    // optional expiry + note for the grant ledger
    let expiresAt: string | null = null;
    if (body.expires_at) {
      const d = new Date(body.expires_at);
      if (isNaN(d.getTime())) return err('تاريخ الانتهاء غلط');
      expiresAt = d.toISOString();
    }
    const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;

    // upsert the profile row (created on signup, but be safe) with new limits
    const { data: row, error: upErr } = await admin
      .from('profiles')
      .upsert({ id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'id' })
      .select('family_slots, chat_retention_days, trash_retention_days, secret_vaults_limit, custom_tabs_limit')
      .single();
    if (upErr) throw upErr;

    // log each granted limit (best-effort: table may not exist until migration 0025 runs)
    try {
      await admin.from('subscription_grants').insert(
        keys.map((k) => ({ user_id: userId, kind: k, value: patch[k], expires_at: expiresAt, note })),
      );
    } catch (e) {
      console.warn('grant log skipped:', e instanceof Error ? e.message : e);
    }

    return ok({ ok: true, user: { id: userId, email }, limits: row });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    console.error('admin-set-limits failed:', msg);
    return err(msg, 500);
  }
});

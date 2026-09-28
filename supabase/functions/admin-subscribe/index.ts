// admin-subscribe: grant a user a subscription plan for a set period,
// with optional discount / free / promo code + note.
// Auth: `x-admin-token` header must equal the ADMIN_TOKEN secret (service_role).
//
// POST {
//   "email" | "user_id", "plan_id",
//   "days_override"?: number,        // custom duration; default = plan.duration_days
//   "discount_percent"?: number,     // 0-100; default 0
//   "free"?: boolean,               // price_paid = 0
//   "promo_code"?: string,          // validated (active, in dates, uses left); bumps used_count
//   "note"?: string
// }
// Inserts user_subscriptions AND upserts the plan's feature limits
// (entries like "secret_vaults_limit:5") into subscription_grants +
// profiles, so existing enforcement keeps working with zero billing engine.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// limit keys the app enforces (mirrors admin-set-limits)
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err('JSON غلط');
  }

  const planId = String(body.plan_id ?? '').trim();
  if (!planId) return err('ناقص plan_id');

  const discount = body.discount_percent === undefined ? 0 : Number(body.discount_percent);
  if (!Number.isInteger(discount) || discount < 0 || discount > 100) return err('الخصم لازم يكون بين 0 و 100');
  const free = body.free === true || discount === 100;
  const daysOverride = body.days_override === undefined || body.days_override === null || body.days_override === ''
    ? null
    : Number(body.days_override);
  if (daysOverride !== null && (!Number.isInteger(daysOverride) || daysOverride <= 0)) {
    return err('المدة المخصصة لازم تكون أيام موجبة');
  }
  const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;
  const promoCode = String(body.promo_code ?? '').trim().toUpperCase() || null;

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey);

    // ── resolve user ──
    let userId = String(body.user_id ?? '').trim();
    let email: string | null = null;
    if (!userId) {
      email = String(body.email ?? '').trim().toLowerCase();
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

    // ── load plan ──
    const { data: plan, error: planErr } = await admin
      .from('subscription_plans')
      .select('*')
      .eq('id', planId)
      .single();
    if (planErr || !plan) return err('الخطة مش موجودة');
    if (!plan.active) return err('الخطة موقوفة حالياً');

    // ── validate promo (if any) ──
    let promo: Record<string, unknown> | null = null;
    if (promoCode) {
      const { data, error } = await admin.from('promotions').select('*').eq('code', promoCode).maybeSingle();
      if (error) throw error;
      if (!data) return err('كود العرض مش موجود');
      promo = data as Record<string, unknown>;
      if (!promo.active) return err('كود العرض موقوف');
      const now = new Date();
      if (promo.starts_at && new Date(promo.starts_at as string) > now) return err('العرض لسا ما بلّش');
      if (promo.ends_at && new Date(promo.ends_at as string) < now) return err('العرض انتهت مدته');
      if (promo.max_uses !== null && Number(promo.used_count) >= Number(promo.max_uses)) {
        return err('العرض استُنفد (وصل للحد الأقصى)');
      }
      if (promo.applies_to !== 'all' && promo.applies_to !== planId) {
        return err('هالعرض ما بينطبق على هالخطة');
      }
      // promo discount stacks with the manual discount: take the better one
      const pd = Number(promo.discount_percent ?? 0);
      const bump = await admin
        .from('promotions')
        .update({ used_count: Number(promo.used_count) + 1 })
        .eq('id', promo.id);
      if (bump.error) throw bump.error;
    }
    const promoDiscount = promo ? Number(promo.discount_percent ?? 0) : 0;
    const promoFreeDays = promo ? Number(promo.free_days ?? 0) : 0;
    const effDiscount = Math.max(discount, promoDiscount);

    // ── duration: explicit override > promo free days > plan duration ──
    const totalDays = daysOverride ?? (promoFreeDays > 0 ? promoFreeDays : Number(plan.duration_days));
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + totalDays * 86400_000);

    // ── price ──
    const basePrice = plan.price_cents === null ? 0 : Number(plan.price_cents);
    const pricePaid = free ? 0 : Math.round(basePrice * (1 - effDiscount / 100));

    // ── insert subscription ──
    const { data: sub, error: subErr } = await admin
      .from('user_subscriptions')
      .insert({
        user_id: userId,
        plan_id: planId,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        status: 'active',
        granted_by: 'admin',
        promo_code: promoCode,
        price_paid_cents: pricePaid,
        note,
      })
      .select()
      .single();
    if (subErr) throw subErr;

    // ── map plan.features "limit_key:value" → grants + profile patch ──
    const applied: Record<string, number> = {};
    const feats: unknown = plan.features;
    if (Array.isArray(feats)) {
      for (const f of feats) {
        const m = String(f).match(/^([a-z_]+):(\d+)$/);
        if (!m) continue;
        const [, key, val] = m;
        if (!(key in LIMITS)) continue;
        const v = Number(val);
        const [lo, hi] = LIMITS[key];
        if (v < lo || v > hi) continue;
        applied[key] = v;
      }
    }
    if (Object.keys(applied).length > 0) {
      const { error: upErr } = await admin
        .from('profiles')
        .upsert({ id: userId, ...applied, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (upErr) throw upErr;
      const rows = Object.entries(applied).map(([kind, value]) => ({
        user_id: userId,
        kind,
        value,
        granted_at: startsAt.toISOString(),
        expires_at: endsAt.toISOString(),
        granted_by: 'admin',
        note: note ?? `plan:${planId}`,
      }));
      const { error: gErr } = await admin.from('subscription_grants').insert(rows);
      if (gErr) console.warn('grant log skipped:', gErr.message);
    }

    return ok({
      ok: true,
      subscription: {
        id: sub.id,
        plan: plan.name_ar,
        user: email,
        starts_at: sub.starts_at,
        ends_at: sub.ends_at,
        price_paid_cents: pricePaid,
        promo_code: promoCode,
      },
      limits_applied: applied,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    console.error('admin-subscribe failed:', msg);
    return err(msg, 500);
  }
});

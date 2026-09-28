// public-config: anon-safe public app config for the mobile client.
// NO admin token. Returns ONLY whitelisted fields:
//
// {
//   plans:   [{ id, name_ar, name_en, price_cents, currency, duration_days, features }] (active only),
//   flags:   { key: enabled },
//   broadcasts: [{ id, title_ar, body_ar, title_en, body_en, target }] (active && in window),
//   is_premium: bool  (true when the caller's JWT belongs to a user with an
//                     active user_subscriptions row; false otherwise / anonymous)
// }
//
// Nothing user-specific besides that single boolean about the caller.
// Accepts GET or POST (supabase-js functions.invoke sends POST).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const ok = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, service);

    const nowIso = new Date().toISOString();

    const [plansRes, flagsRes, bcRes] = await Promise.all([
      admin
        .from('subscription_plans')
        .select('id, name_ar, name_en, price_cents, currency, duration_days, features')
        .eq('active', true)
        .order('sort')
        .order('id'),
      admin.from('feature_flags').select('key, enabled'),
      admin
        .from('broadcasts')
        .select('id, title_ar, body_ar, title_en, body_en, target')
        .eq('active', true)
        .lte('starts_at', nowIso)
        .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
        .order('created_at', { ascending: false })
        .limit(20),
    ]);
    if (plansRes.error) throw plansRes.error;
    if (flagsRes.error) throw flagsRes.error;
    if (bcRes.error) throw bcRes.error;

    const flags: Record<string, boolean> = {};
    for (const f of (flagsRes.data ?? []) as { key: string; enabled: boolean }[]) {
      flags[f.key] = !!f.enabled;
    }

    // is_premium: resolve the caller from their JWT (anon client), then check
    // their subscriptions with service_role. Only a boolean about the caller
    // ever leaves this function.
    let isPremium = false;
    const auth = req.headers.get('Authorization') ?? '';
    if (auth.toLowerCase().startsWith('bearer ')) {
      try {
        const caller = createClient(url, anon, { global: { headers: { Authorization: auth } } });
        const { data } = await caller.auth.getUser();
        const uid = data?.user?.id;
        if (uid) {
          const { count } = await admin
            .from('user_subscriptions')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', uid)
            .eq('status', 'active')
            .or(`ends_at.is.null,ends_at.gt.${nowIso}`);
          isPremium = (count ?? 0) > 0;
        }
      } catch {
        isPremium = false; // fail closed on auth errors
      }
    }

    return ok({
      plans: plansRes.data ?? [],
      flags,
      broadcasts: bcRes.data ?? [],
      is_premium: isPremium,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    console.error('public-config failed:', msg);
    return err(msg, 500);
  }
});

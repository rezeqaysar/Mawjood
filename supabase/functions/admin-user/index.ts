// admin-user: per-user admin page backend.
// Auth: `x-admin-token` header must equal the ADMIN_TOKEN secret (service_role).
//
// POST { "action": "get", "user_id": "…" } or { "action": "get", "email": "…" }
//   → profile, ban status, spaces (+per-space counts), stats, subscription grants.
// POST { "action": "ban", "user_id": "…", "ban_duration": "72h" | "none" }
//   → suspend the user for a duration ("none" lifts the ban). A banned user
//     cannot sign in until banned_until passes.
// POST { "action": "block", "user_id": "…" }
//   → permanent block (≈100-year ban; reversible with ban/none).
// POST { "action": "create", "email": "…" } → create the auth user (email
//   auto-confirmed) and ensure a profile row exists.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

  let body: { action?: string; email?: string; user_id?: string; ban_duration?: string };
  try {
    body = await req.json();
  } catch {
    return err('JSON غلط');
  }

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey);

    // create a new auth user by email (email auto-confirmed); ensures a profile row.
    // (runs BEFORE user resolution: the email must NOT exist yet)
    if (body.action === 'create') {
      const newEmail = (body.email ?? '').trim().toLowerCase();
      if (!newEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(newEmail)) return err('إيميل غلط');
      const { data: created, error: cErr } = await admin.auth.admin.createUser({ email: newEmail, email_confirm: true });
      if (cErr) throw cErr;
      const newId = created.user.id;
      const { error: pErr } = await admin
        .from('profiles')
        .upsert({ id: newId, updated_at: new Date().toISOString() }, { onConflict: 'id' });
      if (pErr) console.warn('profile upsert skipped:', pErr.message);
      return ok({ ok: true, user: { id: newId, email: created.user.email } });
    }

    // ---- resolve user id ----
    let userId = (body.user_id ?? '').trim();
    if (!userId) {
      const email = (body.email ?? '').trim().toLowerCase();
      if (!email) return err('ابعث email أو user_id');
      let page = 1;
      for (;;) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === email);
        if (hit) {
          userId = hit.id;
          break;
        }
        if (data.users.length < 1000 || page >= 20) break;
        page++;
      }
      if (!userId) return err('ما لقيت مستخدم بهالإيميل');
    }

    if (body.action === 'ban') {
      const dur = (body.ban_duration ?? '').trim();
      if (!/^\d+h$/.test(dur) && dur !== 'none') return err('المدة لازم تكون مثل 24h أو 72h، أو none للإلغاء');
      const { data, error } = await admin.auth.admin.updateUserById(userId, { ban_duration: dur });
      if (error) throw error;
      return ok({ ok: true, banned_until: data.user.banned_until ?? null });
    }

    // permanent block: a ~100-year ban. Reversible via the 'ban' action with
    // ban_duration "none". (Safer than deleteUser: data stays recoverable.)
    if (body.action === 'block') {
      const { data, error } = await admin.auth.admin.updateUserById(userId, { ban_duration: '876000h' });
      if (error) throw error;
      return ok({ ok: true, blocked: true, banned_until: data.user.banned_until ?? null });
    }

    if (body.action !== 'get') return err('action غلط');

    const { data: uData, error: uErr } = await admin.auth.admin.getUserById(userId);
    if (uErr || !uData.user) return err('ما لقيت المستخدم');
    const au = uData.user;

    const { data: profile } = await admin
      .from('profiles')
      .select('display_name, family_slots, chat_retention_days, trash_retention_days, secret_vaults_limit, custom_tabs_limit')
      .eq('id', userId)
      .maybeSingle();

    const { data: spaces } = await admin
      .from('spaces')
      .select('id, name, type, created_at')
      .eq('owner_id', userId)
      .order('created_at', { ascending: true })
      .limit(100);

    // per-space note/item counts
    const spaceRows: Array<Record<string, unknown>> = [];
    let notesTotal = 0;
    let itemsTotal = 0;
    for (const s of spaces ?? []) {
      const { count: nNotes } = await admin.from('notes').select('id', { count: 'exact', head: true }).eq('space_id', s.id);
      const { count: nItems } = await admin.from('items').select('id', { count: 'exact', head: true }).eq('space_id', s.id);
      notesTotal += nNotes ?? 0;
      itemsTotal += nItems ?? 0;
      spaceRows.push({ ...s, notes: nNotes ?? 0, items: nItems ?? 0 });
    }

    const { data: memberships } = await admin
      .from('space_members')
      .select('space_id, spaces!inner (name, type)')
      .eq('user_id', userId)
      .limit(100);

    const { count: openBorrows } = await admin
      .from('borrows')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', userId)
      .is('returned_at', null);

    const { count: chats } = await admin
      .from('chat_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId);

    // subscription grant history (best-effort: table may not exist until migration 0025 runs)
    let grants: unknown[] = [];
    try {
      const { data } = await admin
        .from('subscription_grants')
        .select('kind, value, granted_at, expires_at, granted_by, note')
        .eq('user_id', userId)
        .order('granted_at', { ascending: false })
        .limit(100);
      grants = data ?? [];
    } catch (e) {
      console.warn('grants skipped:', e instanceof Error ? e.message : e);
    }

    // plan subscriptions (best-effort: table may not exist until migration 0032 runs)
    let subscriptions: unknown[] = [];
    try {
      const { data } = await admin
        .from('user_subscriptions')
        .select('id, plan_id, starts_at, ends_at, status, promo_code, price_paid_cents, note, subscription_plans(name_ar)')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);
      subscriptions = data ?? [];
    } catch (e) {
      console.warn('subscriptions skipped:', e instanceof Error ? e.message : e);
    }

    return ok({
      user: {
        id: au.id,
        email: au.email ?? null,
        created_at: au.created_at,
        last_sign_in_at: au.last_sign_in_at ?? null,
        banned_until: au.banned_until ?? null,
      },
      limits: profile ?? null,
      stats: {
        notes: notesTotal,
        items: itemsTotal,
        open_borrows: openBorrows ?? 0,
        chats: chats ?? 0,
        owned_spaces: (spaces ?? []).length,
        member_spaces: (memberships ?? []).length,
      },
      spaces: spaceRows,
      member_of: (memberships ?? []).map((m: { space_id: string; spaces: { name: string; type: string } }) => ({
        space_id: m.space_id,
        name: m.spaces?.name,
        type: m.spaces?.type,
      })),
      grants,
      subscriptions,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    console.error('admin-user failed:', msg);
    return err(msg, 500);
  }
});

// join-family: redeem a family-space invite code.
// POST { code } with the user's Authorization header.
// Validates the invite (service_role), adds the caller to space_members,
// bumps used_count, and returns the joined space. Anonymous users are
// rejected — they must link an email first (otherwise they'd lose the space).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const auth = req.headers.get('Authorization') ?? '';
  const err = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  const fail = (e: unknown, status = 500) => {
    // PostgrestError is a plain object, not instanceof Error — surface its message
    const msg = e instanceof Error ? e.message : (e as { message?: string } | null)?.message;
    console.error('join-family failed:', msg ?? e);
    return err(msg || 'failed', status);
  };

  try {
    // who is calling?
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } } });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData?.user;
    if (!user) return err('not authenticated', 401);
    if (user.is_anonymous) return err('سجّل الدخول ببريدك أولاً عشان تنضم لعائلة', 403);

    const { code } = await req.json();
    const clean = String(code ?? '').trim().toUpperCase();
    if (!clean) return err('رمز الدعوة مطلوب');

    const admin = createClient(url, serviceKey);

    const { data: invite } = await admin
      .from('space_invites')
      .select('id, space_id, expires_at, max_uses, used_count')
      .eq('code', clean)
      .maybeSingle();
    if (!invite) return err('رمز الدعوة غير صحيح', 404);
    if (new Date(invite.expires_at) < new Date()) return err('انتهت صلاحية رمز الدعوة', 410);
    if (invite.used_count >= invite.max_uses) return err('تم استخدام رمز الدعوة بالكامل', 410);

    // family spaces only — no B2B
    const { data: space } = await admin
      .from('spaces')
      .select('id, name, type, owner_id')
      .eq('id', invite.space_id)
      .single();
    if (!space || space.type !== 'family') return err('رمز الدعوة غير صالح', 403);

    // already in? (space_members has no id column; PK is (space_id, user_id))
    const { data: existing } = await admin
      .from('space_members')
      .select('space_id')
      .eq('space_id', space.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (existing || space.owner_id === user.id) {
      return new Response(JSON.stringify({ space, already: true }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const { error: insErr } = await admin.from('space_members').insert({
      space_id: space.id,
      user_id: user.id,
      role: 'member',
    });
    if (insErr) {
      // true race: two simultaneous joins — treat as already a member
      if (insErr.code === '23505') {
        return new Response(JSON.stringify({ space, already: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      throw insErr;
    }

    await admin
      .from('space_invites')
      .update({ used_count: invite.used_count + 1 })
      .eq('id', invite.id);

    return new Response(JSON.stringify({ space }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return fail(e, 500);
  }
});

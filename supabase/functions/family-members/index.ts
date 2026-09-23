// family-members: detailed roster of a family space (manager + members with emails).
// POST { space_id } with the user's Authorization header.
// The caller must be the space owner or a member. Uses service_role to read
// auth.users emails (never exposed to PostgREST directly).

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

  try {
    // who is calling?
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: auth } } });
    const { data: userData } = await userClient.auth.getUser();
    const user = userData?.user;
    if (!user) return err('not authenticated', 401);

    const { space_id } = await req.json();
    if (!space_id) return err('space_id مطلوب');

    const admin = createClient(url, serviceKey);

    const { data: space } = await admin
      .from('spaces')
      .select('id, name, type, owner_id, created_at')
      .eq('id', space_id)
      .single();
    if (!space || space.type !== 'family') return err('مساحة غير صالحة', 403);

    const isOwner = space.owner_id === user.id;
    const { data: membership } = await admin
      .from('space_members')
      .select('space_id')
      .eq('space_id', space.id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!isOwner && !membership) return err('غير مصرح', 403);

    const emailOf = async (uid: string): Promise<string | null> => {
      try {
        const { data } = await admin.auth.admin.getUserById(uid);
        return data?.user?.email ?? null;
      } catch {
        return null;
      }
    };

    const members: Array<{
      user_id: string;
      email: string | null;
      role: 'owner' | 'member';
      is_manager: boolean;
      joined_at: string | null;
    }> = [];

    // manager first
    members.push({
      user_id: space.owner_id,
      email: await emailOf(space.owner_id),
      role: 'owner',
      is_manager: true,
      joined_at: space.created_at ?? null,
    });

    const { data: rows } = await admin
      .from('space_members')
      .select('user_id, created_at')
      .eq('space_id', space.id)
      .order('created_at', { ascending: true });
    for (const row of rows ?? []) {
      if (row.user_id === space.owner_id) continue; // owner already listed
      members.push({
        user_id: row.user_id,
        email: await emailOf(row.user_id),
        role: 'member',
        is_manager: false,
        joined_at: row.created_at ?? null,
      });
    }

    return new Response(JSON.stringify({ members }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    console.error('family-members failed:', msg);
    return err(msg, 500);
  }
});

// Supabase Edge Function: notify
// POST { space_id, title, body, exclude_user_id? } → sends an Expo push
// notification to every registered device of the space's members
// (except exclude_user_id, usually the person who triggered the action).
// Uses service role to read space_members + device_tokens.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { space_id, title, body, exclude_user_id } = await req.json();
    if (!space_id || !title?.trim()) throw new Error('space_id and title are required');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // members of the space
    const { data: members, error: mErr } = await supabase
      .from('space_members')
      .select('user_id')
      .eq('space_id', space_id);
    if (mErr) throw mErr;
    const userIds = (members ?? [])
      .map((m: { user_id: string }) => m.user_id)
      .filter((id: string) => id !== exclude_user_id);
    if (userIds.length === 0) {
      return Response.json({ sent: 0, reason: 'no members' }, { headers: cors });
    }

    // their registered Expo push tokens
    const { data: tokens, error: tErr } = await supabase
      .from('device_tokens')
      .select('expo_push_token')
      .in('user_id', userIds);
    if (tErr) throw tErr;
    const pushTokens = [...new Set((tokens ?? []).map((t: { expo_push_token: string }) => t.expo_push_token))];
    if (pushTokens.length === 0) {
      return Response.json({ sent: 0, reason: 'no devices' }, { headers: cors });
    }

    const messages = pushTokens.map((to: string) => ({
      to,
      sound: 'default',
      title,
      body: body ?? '',
    }));

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    const receipts = await res.json();

    return Response.json({ sent: pushTokens.length, receipts }, { headers: cors });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400, headers: cors });
  }
});

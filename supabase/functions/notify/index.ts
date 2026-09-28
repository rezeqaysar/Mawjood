// Supabase Edge Function: notify
// POST { space_id, title, body, exclude_user_id? } → sends an Expo push
// notification to every registered device of the space's members
// (except exclude_user_id, usually the person who triggered the action).
// POST { to_user_id, title, body } → sends ONLY to that user (targeted,
// e.g. a directed shopping list assignee — the rest of the family sees
// the list in the space but gets no push).
//
// SECURITY (P0-3): two trust boundaries.
//   - Internal callers (other edge fns) prove themselves with x-internal-secret.
//   - App callers authenticate with their JWT:
//       * space_id → the caller must be the space owner or a member.
//       * to_user_id → the target must be the caller themselves, or share a
//         family space with the caller (the shopping-assignee flow). A user
//         can never push-spam a stranger by guessing their user id.
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, INTERNAL_FN_SECRET

import {
  adminClient,
  authUserId,
  isInternal,
  json401,
  json403,
} from '../_shared/edge-auth.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
};

type Admin = ReturnType<typeof adminClient>;

/** Space ids the user owns or belongs to. */
async function userSpaceIds(admin: Admin, userId: string): Promise<Set<string>> {
  const [owned, member] = await Promise.all([
    admin.from('spaces').select('id').eq('owner_id', userId),
    admin.from('space_members').select('space_id').eq('user_id', userId),
  ]);
  const ids = new Set<string>();
  for (const r of ((owned.data ?? []) as { id: string }[])) ids.add(r.id);
  for (const r of ((member.data ?? []) as { space_id: string }[])) ids.add(r.space_id);
  return ids;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { space_id, title, body, exclude_user_id, to_user_id } = await req.json();
    const cleanTitle = String(title ?? '').trim().slice(0, 200);
    const cleanBody = String(body ?? '').slice(0, 1000);
    if (!cleanTitle) throw new Error('title is required');
    if (!space_id && !to_user_id) throw new Error('space_id or to_user_id is required');

    const supabase = adminClient();

    // ── authorization ─────────────────────────────────────────────
    if (!isInternal(req)) {
      const callerId = await authUserId(req);
      if (!callerId) return json401();
      if (to_user_id) {
        const target = String(to_user_id);
        if (target !== callerId) {
          // caller and target must share at least one space
          const [mine, theirs] = await Promise.all([
            userSpaceIds(supabase, callerId),
            userSpaceIds(supabase, target),
          ]);
          let shared = false;
          for (const id of mine) if (theirs.has(id)) { shared = true; break; }
          if (!shared) return json403('no_shared_space');
        }
      } else {
        const mine = await userSpaceIds(supabase, callerId);
        if (!mine.has(String(space_id))) return json403('not_a_member');
      }
    }
    // ── end authorization ─────────────────────────────────────────

    let userIds: string[];
    if (to_user_id) {
      // targeted: only the assignee
      userIds = [to_user_id as string];
    } else {
      // everyone in the family: the space owner + invited members
      const { data: space, error: sErr } = await supabase
        .from('spaces')
        .select('owner_id')
        .eq('id', space_id)
        .single();
      if (sErr) throw sErr;

      // members of the space
      const { data: members, error: mErr } = await supabase
        .from('space_members')
        .select('user_id')
        .eq('space_id', space_id);
      if (mErr) throw mErr;
      userIds = [
        ...new Set(
          [space.owner_id, ...(members ?? []).map((m: { user_id: string }) => m.user_id)],
        ),
      ].filter((id: string) => id !== exclude_user_id);
    }
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
      title: cleanTitle,
      body: cleanBody,
    }));

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    const receipts = await res.json();

    // Phase E P2-1: notification delivery is observable (counts only — never
    // message content). Failures here are fire-and-forget by design.
    try {
      const errs = Array.isArray(receipts)
        ? receipts.filter((r: { status?: string }) => r?.status === 'error').length
        : 0;
      await supabase.from('ops_events').insert({
        kind: 'notify.delivery',
        ok: res.ok && errs === 0,
        detail: `sent=${pushTokens.length} errors=${errs}`,
        meta: { space_id: space_id ?? null, to_user: to_user_id ?? null },
      });
    } catch { /* telemetry never breaks delivery */ }

    return Response.json({ sent: pushTokens.length, receipts }, { headers: cors });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400, headers: cors });
  }
});

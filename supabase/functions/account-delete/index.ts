// account-delete — Phase E P2-4: the right to be forgotten.
//
// Body: { "confirm": true } — the double-confirm lives in the app UI;
// the server refuses without the explicit flag.
//
// Deletion policy (also returned in the response):
// - Private + work spaces: deleted with everything in them.
// - Family spaces you own WITH other members: ownership moves to the
//   longest-standing other member; what you wrote there stays as shared
//   family history (it's theirs too).
// - Family spaces you own with NO other members: deleted.
// - Family spaces you only belong to: your membership is removed,
//   the shared content stays.
// - Chat sessions, trash, device tokens, vault data, grants, telemetry:
//   deleted. Storage files under your user folder: deleted.
// - Finally the auth user itself is removed.

import { adminClient, authUserId, json401 } from '../_shared/edge-auth.ts';
import { checkRateLimit, rateLimitMessage } from '../_shared/rate-limit.ts';
import { logOps, newRequestId } from '../_shared/log.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const POLICY = [
  'Private and work spaces are deleted with everything in them.',
  'Family spaces you owned move to the longest-standing remaining member; what you wrote there stays as shared family history.',
  'Your memberships in other family spaces are removed.',
  'Chats, trash, devices, vault data, grants and telemetry are deleted.',
  'Your stored voice/photo files are deleted.',
];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const supabase = adminClient();
  const requestId = newRequestId();

  try {
    const userId = await authUserId(req);
    if (!userId) return json401();

    let confirm = false;
    try {
      confirm = (await req.json())?.confirm === true;
    } catch { /* no body */ }
    if (!confirm) {
      return new Response(JSON.stringify({ ok: false, error: 'confirmation required: { "confirm": true }', policy: POLICY }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const rl = await checkRateLimit(supabase, userId, 'account-delete');
    if (!rl.allowed) {
      return new Response(JSON.stringify({ ok: false, error: rateLimitMessage(true) }), {
        status: 429,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    await logOps(supabase, {
      user_id: userId, request_id: requestId,
      kind: 'account.delete_requested', ok: true,
    });

    const wipeSpace = async (spaceId: string) => {
      await supabase.from('items').delete().eq('space_id', spaceId);
      await supabase.from('notes').delete().eq('space_id', spaceId);
      await supabase.from('borrows').delete().eq('space_id', spaceId);
      await supabase.from('shopping_lists').delete().eq('space_id', spaceId);
      await supabase.from('space_tabs').delete().eq('space_id', spaceId);
      await supabase.from('space_invites').delete().eq('space_id', spaceId);
      await supabase.from('space_members').delete().eq('space_id', spaceId);
      await supabase.from('spaces').delete().eq('id', spaceId);
    };

    // 1) Owned spaces: transfer family ownership or wipe.
    const { data: owned } = await supabase
      .from('spaces')
      .select('id, type')
      .eq('owner_id', userId);
    let transferred = 0;
    let wiped = 0;
    for (const s of owned ?? []) {
      if (s.type === 'family') {
        const { data: members } = await supabase
          .from('space_members')
          .select('user_id, created_at')
          .eq('space_id', s.id)
          .order('created_at', { ascending: true });
        const heir = (members ?? []).find((m) => m.user_id !== userId);
        if (heir) {
          await supabase.from('spaces').update({ owner_id: heir.user_id }).eq('id', s.id);
          await supabase.from('space_members').update({ role: 'owner' }).eq('space_id', s.id).eq('user_id', heir.user_id);
          await supabase.from('space_members').delete().eq('space_id', s.id).eq('user_id', userId);
          transferred++;
          continue;
        }
      }
      await wipeSpace(s.id);
      wiped++;
    }

    // 2) Memberships in spaces owned by others: just leave.
    await supabase.from('space_members').delete().eq('user_id', userId);

    // 3) User-scoped rows.
    await supabase.from('chat_sessions').delete().eq('user_id', userId);
    await supabase.from('trash_bin').delete().eq('user_id', userId);
    await supabase.from('device_tokens').delete().eq('user_id', userId);
    await supabase.from('vault_master').delete().eq('user_id', userId);
    await supabase.from('secret_vault').delete().eq('user_id', userId);
    await supabase.from('subscription_grants').delete().eq('user_id', userId);
    await supabase.from('ai_events').delete().eq('user_id', userId);
    await supabase.from('ops_events').delete().eq('user_id', userId);
    await supabase.from('rate_limits').delete().eq('user_id', userId);
    await supabase.from('profiles').delete().eq('id', userId);

    // 4) Storage files under the user's folder (best-effort).
    for (const bucket of ['voice-notes', 'item-photos']) {
      try {
        const { data: files } = await supabase.storage.from(bucket).list(userId, { limit: 1000 });
        const paths = (files ?? [])
          .filter((f) => f.name)
          .map((f) => `${userId}/${f.name}`);
        for (let i = 0; i < paths.length; i += 100) {
          await supabase.storage.from(bucket).remove(paths.slice(i, i + 100));
        }
      } catch { /* best effort */ }
    }

    // 5) The auth user itself — last, so a failure here is honest.
    const { error: delErr } = await supabase.auth.admin.deleteUser(userId);
    if (delErr) throw new Error(`auth user removal failed: ${delErr.message}`);

    await logOps(supabase, {
      user_id: userId, request_id: requestId,
      kind: 'account.deleted', ok: true,
      detail: `transferred=${transferred} wiped=${wiped}`,
    });

    return new Response(JSON.stringify({ ok: true, policy: POLICY, transferred, wiped }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});

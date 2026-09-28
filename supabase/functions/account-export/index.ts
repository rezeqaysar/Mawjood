// account-export — Phase E P2-4: data portability.
//
// Returns everything the user can see as one JSON document:
// profile, spaces (owned + member), tabs, notes, items, borrows,
// shopping lists, chat sessions, trash, grants.
//
// Auth: the caller's own JWT. Vault master hashes are NEVER exported
// (password hashes never leave the server). Tight rate limits — a full
// export is a heavy read.

import { adminClient, authUserId, json401 } from '../_shared/edge-auth.ts';
import { checkRateLimit, rateLimitMessage } from '../_shared/rate-limit.ts';
import { logOps, newRequestId } from '../_shared/log.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const CAP = 10000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET' && req.method !== 'POST') {
    return new Response(JSON.stringify({ ok: false, error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const supabase = adminClient();
  const requestId = newRequestId();

  try {
    const userId = await authUserId(req);
    if (!userId) return json401();

    const rl = await checkRateLimit(supabase, userId, 'account-export');
    if (!rl.allowed) {
      return new Response(JSON.stringify({ ok: false, error: rateLimitMessage(true) }), {
        status: 429,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // Spaces the user owns or belongs to — everything below is scoped to these.
    const { data: memberships } = await supabase
      .from('space_members')
      .select('space_id, role')
      .eq('user_id', userId);
    const { data: owned } = await supabase
      .from('spaces')
      .select('id, type, name, created_at')
      .eq('owner_id', userId);
    const memberIds = (memberships ?? []).map((m) => m.space_id);
    const ownedIds = (owned ?? []).map((s) => s.id);
    const spaceIds = [...new Set([...memberIds, ...ownedIds])];

    const q = async (table: string, col: string, ids: string[]) => {
      if (!ids.length) return { rows: [], truncated: false };
      const { data } = await supabase
        .from(table)
        .select('*')
        .in(col, ids)
        .order('created_at', { ascending: true })
        .limit(CAP + 1);
      const rows = data ?? [];
      return { rows: rows.slice(0, CAP), truncated: rows.length > CAP };
    };

    const [spaces, tabs, notes, items, borrows, lists, invites] = await Promise.all([
      supabase.from('spaces').select('*').in('id', spaceIds.length ? spaceIds : ['00000000-0000-0000-0000-000000000000']),
      q('space_tabs', 'space_id', spaceIds),
      q('notes', 'space_id', spaceIds),
      q('items', 'space_id', spaceIds),
      q('borrows', 'space_id', spaceIds),
      q('shopping_lists', 'space_id', spaceIds),
      q('space_invites', 'space_id', spaceIds),
    ]);
    const [profile, sessions, trash, grants] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      supabase.from('chat_sessions').select('*').eq('user_id', userId).order('created_at', { ascending: true }).limit(CAP),
      supabase.from('trash_bin').select('*').eq('user_id', userId).order('created_at', { ascending: true }).limit(CAP),
      supabase.from('subscription_grants').select('family_slots, secret_vaults_limit, chat_retention_days, trash_retention_days, custom_tabs_limit, expires_at, note, created_at').eq('user_id', userId).order('created_at', { ascending: false }),
    ]);

    const doc = {
      exported_at: new Date().toISOString(),
      user_id: userId,
      profile: profile.data ?? null,
      spaces: spaces.data ?? [],
      memberships: memberships ?? [],
      space_tabs: tabs,
      notes: notes,
      items: items,
      borrows: borrows,
      shopping_lists: lists,
      space_invites: invites,
      chat_sessions: sessions.data ?? [],
      trash_bin: trash.data ?? [],
      subscription_grants: grants.data ?? [],
      excluded: ['vault_master hashes are never exported'],
    };

    await logOps(supabase, {
      user_id: userId, request_id: requestId,
      kind: 'account.export', ok: true,
      detail: `spaces=${spaceIds.length}`,
    });

    return new Response(JSON.stringify({ ok: true, export: doc }), {
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="mawjood-export-${userId.slice(0, 8)}.json"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});

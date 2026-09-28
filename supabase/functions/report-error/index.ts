// report-error — Phase E P2-1: client crash/error telemetry.
//
// The app's global error handler POSTs here (fire-and-forget).
// Stored in ops_events as kind='client.error' — error CLASS only, never
// user content. Tight-ish rate limits: a crash loop must not spam the table.

import { adminClient, authUserId, json401 } from '../_shared/edge-auth.ts';
import { checkRateLimit, rateLimitMessage } from '../_shared/rate-limit.ts';
import { logOps, newRequestId } from '../_shared/log.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const supabase = adminClient();

  try {
    const userId = await authUserId(req);
    if (!userId) return json401();

    const rl = await checkRateLimit(supabase, userId, 'report-error');
    if (!rl.allowed) {
      return new Response(JSON.stringify({ ok: false, error: rateLimitMessage(true) }), {
        status: 429,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    let message = '';
    let stack: string | null = null;
    let context: string | null = null;
    try {
      const b = await req.json();
      message = String(b?.message ?? '').slice(0, 300);
      stack = b?.stack ? String(b.stack).slice(0, 1000) : null;
      context = b?.context ? String(b.context).slice(0, 200) : null;
    } catch { /* empty body */ }
    if (!message) {
      return new Response(JSON.stringify({ ok: false, error: 'message required' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    await logOps(supabase, {
      user_id: userId, request_id: newRequestId(),
      kind: 'client.error', ok: false, detail: message,
      meta: { stack, context },
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});

// edge-auth — zero-dependency auth helpers for Supabase Edge Functions.
//
// Two trust boundaries:
//   1. END-USER calls (mobile app via functions.invoke): the request carries
//      the caller's JWT in the Authorization header. authUserId() resolves it
//      to a user id; userClient() gives a Supabase client scoped to that user
//      so PostgREST/RLS enforces ownership. NEVER trust a caller-supplied id.
//   2. SERVICE-TO-SERVICE calls (one edge fn calling another): the caller
//      proves itself with the x-internal-secret header, which must equal the
//      INTERNAL_FN_SECRET edge secret. isInternal() checks it.
//
// Rule: a service_role client must never act on a caller-supplied resource
// id unless (a) the caller proved user identity AND the resource was read
// through the user-scoped client (RLS), or (b) the call is internal.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const URL = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

/** Resolve the caller's user id from their JWT. Null when missing/invalid. */
export async function authUserId(req: Request): Promise<string | null> {
  const auth = req.headers.get('Authorization');
  if (!auth) return null;
  try {
    const supa = createClient(URL, ANON, {
      global: { headers: { Authorization: auth } },
    });
    const { data } = await supa.auth.getUser();
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** Supabase client scoped to the caller — RLS applies. */
export function userClient(req: Request) {
  return createClient(URL, ANON, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
}

/** Full-power client. Use ONLY after the caller/resource was authorized. */
export function adminClient() {
  return createClient(URL, SERVICE);
}

/**
 * True when the call comes from another edge function (or cron) bearing the
 * shared internal secret. Compares in constant time to avoid leaking the
 * secret's prefix through timing.
 */
export function isInternal(req: Request): boolean {
  const secret = Deno.env.get('INTERNAL_FN_SECRET') ?? '';
  const got = req.headers.get('x-internal-secret') ?? '';
  if (!secret || !got || got.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

/** Headers every service-to-service edge call must send. */
export function internalHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: SERVICE,
    Authorization: `Bearer ${SERVICE}`,
    'x-internal-secret': Deno.env.get('INTERNAL_FN_SECRET') ?? '',
  };
}

export const json401 = (msg = 'not_authenticated') =>
  Response.json({ ok: false, error: msg }, { status: 401 });

export const json403 = (msg = 'forbidden') =>
  Response.json({ ok: false, error: msg }, { status: 403 });

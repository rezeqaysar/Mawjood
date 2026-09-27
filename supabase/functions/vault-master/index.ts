// Supabase Edge Function: vault-master
// The ghost key: ONE master word opens secret-vault MANAGEMENT (list vaults,
// change codes, delete vaults). The key itself lives only in the owner's head —
// the DB keeps a bcrypt hash, never the key. All hashing/verification happens
// here (service_role); the app only holds the hash in memory for the private-
// chat intercept, never on disk.
// POST { action, ... } with the user's JWT (Authorization header).
//   set              { code }            → first-time master set (409 if exists)
//   change           { oldCode, newCode } → rotate (attempt-counted, 5 wrong = 1h lock)
//                    { new_hash, mgmt_token } → rotate from a master-verified
//                       mgmt session: REQUIRES the server-issued mgmt capability
//                       (returned by a successful `verify`), NOT just the JWT.
//   verify           { code }            → attempt-counted check for destructive ops;
//                                         on success returns { ok, mgmt_token }
//   set_decoy_master { new_hash, mgmt_token } → set/rotate the DECOY master (fake mgmt
//                                         layer); requires a decoy vault + mgmt_token
//   remove_decoy_master { mgmt_token }   → delete the decoy master (real mgmt only)
//   rotate_decoy_master { code, new_hash } → rotate the decoy master from FAKE
//                       management: `code` is the CURRENT decoy word (proof,
//                       like change+oldCode); the new word arrives pre-hashed
//   update_vault_code { vault_id, new_hash, mgmt_token } → change a vault's code
//                                         (code arrives pre-hashed, bcryptjs)
//   delete_vault   { vault_id, mgmt_token } → delete a vault (notes cascade)
//   open_log         { lang }            → management opened: instant push to all devices
//   request_recovery { lang }            → start the 7-day recovery wait (+ push)
//   cancel_recovery  {}                  → cancel the recovery request
//   complete_recovery{ newCode }         → set a new master after the 7-day wait
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
//      INTERNAL_FN_SECRET, VAULT_MGMT_SECRET

// NOTE: use the SYNC bcrypt variants only. The async hash()/compare() spawn a
// `new Worker()`, which the Supabase Edge Runtime forbids — every master-key
// op (set/change/verify) failed because of it (Sep 26, 2026). Sync output is
// byte-identical standard bcrypt, so the app's bcryptjs compare still matches.
import * as bcrypt from 'https://deno.land/x/bcrypt@v0.4.1/mod.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { internalHeaders } from '../_shared/edge-auth.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_TRIES = 5;
const LOCK_MS = 60 * 60 * 1000; // 5 wrong tries → 1h lockout
const RECOVERY_MS = 7 * 24 * 60 * 60 * 1000; // forgotten master → 7-day wait

const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: cors, status });

// ── Management capability (P0-5) ─────────────────────────────────────
// A valid account JWT proves WHO the caller is, not that they know the
// master word. After a successful master `verify`, the server issues a
// short-lived HMAC-signed capability bound to the user id. Management
// actions require it — the server never trusts the client's claim of a
// "verified session".
const MGMT_TTL_MS = 10 * 60 * 1000; // one management session window

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const b64urlEncode = (s: string) =>
  btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s: string) =>
  atob(s.replace(/-/g, '+').replace(/_/g, '/'));

async function issueMgmtToken(userId: string): Promise<string> {
  const payload = b64urlEncode(JSON.stringify({ uid: userId, exp: Date.now() + MGMT_TTL_MS }));
  const sig = await hmacHex(Deno.env.get('VAULT_MGMT_SECRET')!, payload);
  return `${payload}.${sig}`;
}

async function verifyMgmtToken(token: string | undefined, userId: string): Promise<boolean> {
  try {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    const [payload, sig] = parts;
    const secret = Deno.env.get('VAULT_MGMT_SECRET') ?? '';
    if (!secret) return false;
    const expect = await hmacHex(secret, payload);
    if (expect.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff !== 0) return false;
    const body = JSON.parse(b64urlDecode(payload)) as { uid?: string; exp?: number };
    return body.uid === userId && typeof body.exp === 'number' && body.exp > Date.now();
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { action, code, oldCode, newCode, lang, new_hash, mgmt_token, vault_id } =
      (await req.json()) as Record<string, string | undefined>;

    const auth = req.headers.get('Authorization') ?? '';
    const supa = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: auth } } },
    );
    const { data: userData } = await supa.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return json({ ok: false, error: 'not_authenticated' }, 401);

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const nowIso = () => new Date().toISOString();
    const getRow = async () =>
      (
        await admin
          .from('vault_master')
          .select('*')
          .eq('user_id', userId)
          .maybeSingle()
      ).data as {
        master_hash: string;
        decoy_master_hash: string | null;
        failed_count: number;
        locked_until: string | null;
        recovery_requested_at: string | null;
      } | null;

    const isLocked = (row: { locked_until: string | null } | null) =>
      !!row?.locked_until && new Date(row.locked_until).getTime() > Date.now();

    const recordFail = async (row: { failed_count: number }) => {
      const n = (row.failed_count ?? 0) + 1;
      if (n >= MAX_TRIES) {
        await admin
          .from('vault_master')
          .update({
            failed_count: 0,
            locked_until: new Date(Date.now() + LOCK_MS).toISOString(),
            updated_at: nowIso(),
          })
          .eq('user_id', userId);
        return { locked: true as const, triesLeft: 0 };
      }
      await admin
        .from('vault_master')
        .update({ failed_count: n, updated_at: nowIso() })
        .eq('user_id', userId);
      return { locked: false as const, triesLeft: MAX_TRIES - n };
    };

    const push = async (title: string, body: string) => {
      try {
        await fetch(`${Deno.env.get('SUPABASE_URL')!}/functions/v1/notify`, {
          method: 'POST',
          headers: internalHeaders(),
          body: JSON.stringify({ to_user_id: userId, title, body }),
        });
      } catch (e) {
        console.warn('vault-master push failed', e);
      }
    };

    // Vault codes are stored as bcrypt hashes (migration 0028) — "is this
    // code taken" means comparing against every hash, never a plaintext lookup.
    const codeTakenByVault = async (c: string) => {
      const { data } = await admin
        .from('secret_vault')
        .select('secret_code_hash')
        .eq('user_id', userId);
      for (const r of (data ?? []) as { secret_code_hash: string | null }[]) {
        if (!r.secret_code_hash) continue;
        try {
          if (bcrypt.compareSync(c, r.secret_code_hash)) return true;
        } catch { /* malformed hash: ignore */ }
      }
      return false;
    };

    // Management actions require the server-issued capability from a recent
    // successful master `verify` — never just the account JWT.
    const requireMgmt = async () =>
      (await verifyMgmtToken(mgmt_token, userId))
        ? null
        : json({ ok: false, error: 'mgmt_required' }, 401);

    switch (action) {
      case 'set': {
        const clean = (code ?? '').trim().slice(0, 60);
        if (!clean) throw new Error('empty code');
        if (await getRow()) return json({ ok: false, error: 'exists' });
        if (await codeTakenByVault(clean))
          return json({ ok: false, error: 'code_taken' });
        const hash = bcrypt.hashSync(clean);
        const { error } = await admin
          .from('vault_master')
          .insert({ user_id: userId, master_hash: hash });
        if (error) throw error;
        return json({ ok: true, hash });
      }
      case 'change': {
        const row = await getRow();
        if (!row) return json({ ok: false, error: 'no_master' });
        if (isLocked(row))
          return json({ ok: false, error: 'locked', lockedUntil: row.locked_until });
        // mgmt-session rotate: the caller proved the master word via `verify`
        // (which issued the mgmt_token) — the app pre-hashes the new key with
        // bcryptjs so the raw key never travels.
        const newHash = String(new_hash ?? '');
        if (newHash) {
          const denied = await requireMgmt();
          if (denied) return denied;
          if (!newHash.startsWith('$2')) return json({ ok: false, error: 'bad_hash' });
          const { error } = await admin
            .from('vault_master')
            .update({
              master_hash: newHash,
              failed_count: 0,
              locked_until: null,
              updated_at: nowIso(),
            })
            .eq('user_id', userId);
          if (error) throw error;
          return json({ ok: true, hash: newHash });
        }
        if (!(bcrypt.compareSync(oldCode ?? '', row.master_hash))) {
          const r = await recordFail(row);
          return json(
            r.locked
              ? { ok: false, error: 'locked' }
              : { ok: false, error: 'wrong', triesLeft: r.triesLeft },
          );
        }
        const clean = (newCode ?? '').trim().slice(0, 60);
        if (!clean) throw new Error('empty code');
        if (await codeTakenByVault(clean))
          return json({ ok: false, error: 'code_taken' });
        const hash = bcrypt.hashSync(clean);
        const { error } = await admin
          .from('vault_master')
          .update({
            master_hash: hash,
            failed_count: 0,
            locked_until: null,
            updated_at: nowIso(),
          })
          .eq('user_id', userId);
        if (error) throw error;
        return json({ ok: true, hash });
      }
      case 'verify': {
        const row = await getRow();
        if (!row) return json({ ok: false, error: 'no_master' });
        if (isLocked(row))
          return json({ ok: false, error: 'locked', lockedUntil: row.locked_until });
        if (!(bcrypt.compareSync(code ?? '', row.master_hash))) {
          const r = await recordFail(row);
          return json(
            r.locked
              ? { ok: false, error: 'locked' }
              : { ok: false, error: 'wrong', triesLeft: r.triesLeft },
          );
        }
        await admin
          .from('vault_master')
          .update({ failed_count: 0, updated_at: nowIso() })
          .eq('user_id', userId);
        return json({ ok: true, mgmt_token: await issueMgmtToken(userId) });
      }
      case 'set_decoy_master': {
        // The decoy master opens a FAKE management screen (decoy vault only).
        // Requires the mgmt capability: proving the REAL master via `verify`.
        const denied = await requireMgmt();
        if (denied) return denied;
        const row = await getRow();
        if (!row) return json({ ok: false, error: 'no_master' });
        if (isLocked(row))
          return json({ ok: false, error: 'locked', lockedUntil: row.locked_until });
        // a decoy master with no decoy vault behind it is a broken state
        const { data: decoy } = await admin
          .from('secret_vault')
          .select('id')
          .eq('user_id', userId)
          .eq('is_decoy', true)
          .maybeSingle();
        if (!decoy) return json({ ok: false, error: 'no_decoy' });
        const newHash = String(new_hash ?? '');
        if (!newHash.startsWith('$2')) return json({ ok: false, error: 'bad_hash' });
        const { error } = await admin
          .from('vault_master')
          .update({ decoy_master_hash: newHash, updated_at: nowIso() })
          .eq('user_id', userId);
        if (error) throw error;
        return json({ ok: true, hash: newHash });
      }
      case 'remove_decoy_master': {
        const denied = await requireMgmt();
        if (denied) return denied;
        const row = await getRow();
        if (!row) return json({ ok: false, error: 'no_master' });
        await admin
          .from('vault_master')
          .update({ decoy_master_hash: null, updated_at: nowIso() })
          .eq('user_id', userId);
        return json({ ok: true });
      }
      case 'rotate_decoy_master': {
        // FAKE-management rotate: the session proved the CURRENT decoy word
        // locally, so the app sends it back as proof (like change+oldCode) —
        // the raw NEW word never travels (pre-hashed). No lockout here: the
        // decoy word is duress-sacrificed by design, it is not the boundary.
        const row = await getRow();
        if (!row) return json({ ok: false, error: 'no_master' });
        if (!row.decoy_master_hash)
          return json({ ok: false, error: 'no_decoy_master' });
        if (!(bcrypt.compareSync(code ?? '', row.decoy_master_hash))) {
          return json({ ok: false, error: 'wrong' });
        }
        const newHash = String(new_hash ?? '');
        if (!newHash.startsWith('$2')) return json({ ok: false, error: 'bad_hash' });
        const { error } = await admin
          .from('vault_master')
          .update({ decoy_master_hash: newHash, updated_at: nowIso() })
          .eq('user_id', userId);
        if (error) throw error;
        return json({ ok: true, hash: newHash });
      }
      case 'update_vault_code': {
        // Change a vault's code from the (real) management screen. The code
        // arrives pre-hashed (bcryptjs, like the master rotate path).
        const denied = await requireMgmt();
        if (denied) return denied;
        const newHash = String(new_hash ?? '');
        if (!newHash.startsWith('$2')) return json({ ok: false, error: 'bad_hash' });
        if (!vault_id) return json({ ok: false, error: 'vault_id required' }, 400);
        const { error } = await admin
          .from('secret_vault')
          .update({ secret_code_hash: newHash, updated_at: nowIso() })
          .eq('id', vault_id)
          .eq('user_id', userId);
        if (error) throw error;
        return json({ ok: true });
      }
      case 'delete_vault': {
        // Delete a vault and everything in it (notes cascade via vault_id FK).
        const denied = await requireMgmt();
        if (denied) return denied;
        if (!vault_id) return json({ ok: false, error: 'vault_id required' }, 400);
        const { error } = await admin
          .from('secret_vault')
          .delete()
          .eq('id', vault_id)
          .eq('user_id', userId);
        if (error) throw error;
        return json({ ok: true });
      }
      case 'open_log': {
        // Management opened via private chat → instant push to ALL owner devices.
        const ar = lang !== 'en';
        await push(
          ar ? '👻 انفتحت إدارة المخازن السرية' : '👻 Secret vault management opened',
          ar
            ? 'إذا مش انت اللي فتحتها، غيّر كلمة الماستر فوراً.'
            : "If this wasn't you, change the master key now.",
        );
        return json({ ok: true });
      }
      case 'request_recovery': {
        const row = await getRow();
        if (!row) return json({ ok: false, error: 'no_master' });
        if (!row.recovery_requested_at) {
          await admin
            .from('vault_master')
            .update({ recovery_requested_at: nowIso(), updated_at: nowIso() })
            .eq('user_id', userId);
          const ar = lang !== 'en';
          await push(
            ar ? '⏳ طلب استرجاع كلمة الماستر' : '⏳ Master key recovery requested',
            ar
              ? 'راح تقدر تحط كلمة جديدة بعد ٧ أيام. إذا مش انت، الغِ الطلب من التطبيق فوراً.'
              : "You'll be able to set a new key in 7 days. If this wasn't you, cancel it in the app now.",
          );
        }
        return json({ ok: true });
      }
      case 'cancel_recovery': {
        await admin
          .from('vault_master')
          .update({ recovery_requested_at: null, updated_at: nowIso() })
          .eq('user_id', userId);
        return json({ ok: true });
      }
      case 'complete_recovery': {
        const row = await getRow();
        if (!row?.recovery_requested_at)
          return json({ ok: false, error: 'no_request' });
        const elapsed = Date.now() - new Date(row.recovery_requested_at).getTime();
        if (elapsed < RECOVERY_MS)
          return json({
            ok: false,
            error: 'too_early',
            daysLeft: Math.ceil((RECOVERY_MS - elapsed) / 86400000),
          });
        const clean = (newCode ?? '').trim().slice(0, 60);
        if (!clean) throw new Error('empty code');
        if (await codeTakenByVault(clean))
          return json({ ok: false, error: 'code_taken' });
        const hash = bcrypt.hashSync(clean);
        const { error } = await admin
          .from('vault_master')
          .update({
            master_hash: hash,
            failed_count: 0,
            locked_until: null,
            recovery_requested_at: null,
            updated_at: nowIso(),
          })
          .eq('user_id', userId);
        if (error) throw error;
        return json({ ok: true, hash });
      }
      default:
        throw new Error('unknown action');
    }
  } catch (e) {
    console.warn('vault-master failed', e);
    return json(
      { ok: false, error: e instanceof Error ? e.message : 'unknown' },
      400,
    );
  }
});

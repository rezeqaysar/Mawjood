// Supabase Edge Function: vault-master
// The ghost key: ONE master word opens secret-vault MANAGEMENT (list vaults,
// change codes, delete vaults). The key itself lives only in the owner's head —
// the DB keeps a bcrypt hash, never the key. All hashing/verification happens
// here (service_role); the app only holds the hash in memory for the private-
// chat intercept, never on disk.
// POST { action, ... } with the user's JWT (Authorization header).
//   set              { code }            → first-time master set (409 if exists)
//   change           { oldCode, newCode } → rotate (attempt-counted, 5 wrong = 1h lock)
//                    { new_hash } → rotate from a master-verified mgmt session (app pre-hashes)
//   verify           { code }            → attempt-counted check for destructive ops
//   open_log         { lang }            → management opened: instant push to all devices
//   request_recovery { lang }            → start the 7-day recovery wait (+ push)
//   cancel_recovery  {}                  → cancel the recovery request
//   complete_recovery{ newCode }         → set a new master after the 7-day wait
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import * as bcrypt from 'https://deno.land/x/bcrypt@v0.4.1/mod.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MAX_TRIES = 5;
const LOCK_MS = 60 * 60 * 1000; // 5 wrong tries → 1h lockout
const RECOVERY_MS = 7 * 24 * 60 * 60 * 1000; // forgotten master → 7-day wait

const json = (body: unknown, status = 200) =>
  Response.json(body, { headers: cors, status });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { action, code, oldCode, newCode, lang, new_hash } =
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
          headers: {
            apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
            Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ to_user_id: userId, title, body }),
        });
      } catch (e) {
        console.warn('vault-master push failed', e);
      }
    };

    const codeTakenByVault = async (c: string) => {
      const { data } = await admin
        .from('secret_vault')
        .select('id')
        .eq('user_id', userId)
        .eq('secret_code', c)
        .maybeSingle();
      return !!data;
    };

    switch (action) {
      case 'set': {
        const clean = (code ?? '').trim().slice(0, 60);
        if (!clean) throw new Error('empty code');
        if (await getRow()) return json({ ok: false, error: 'exists' });
        if (await codeTakenByVault(clean))
          return json({ ok: false, error: 'code_taken' });
        const hash = await bcrypt.hash(clean);
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
        // mgmt-session rotate: the master word was already verified in-chat this
        // session, so the app sends a pre-hashed key (bcryptjs) — the raw key
        // never travels. The caller is JWT-authed as the row owner.
        const newHash = String(new_hash ?? '');
        if (newHash) {
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
        if (!(await bcrypt.compare(oldCode ?? '', row.master_hash))) {
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
        const hash = await bcrypt.hash(clean);
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
        if (!(await bcrypt.compare(code ?? '', row.master_hash))) {
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
        const hash = await bcrypt.hash(clean);
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

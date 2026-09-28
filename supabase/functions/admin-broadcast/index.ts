// admin-broadcast: CRUD for app announcements (dismissible cards in the app).
// Auth: `x-admin-token` header must equal the ADMIN_TOKEN secret (service_role).
//
// POST { "action": "list" } → { broadcasts }
// POST { "action": "create", "title_ar", "body_ar", "title_en"?, "body_en"?,
//        "target"?: "all"|"premium"|"free", "starts_at"?, "ends_at"? }
// POST { "action": "update", "id", ...fields }
// POST { "action": "toggle", "id", "enabled" }
// POST { "action": "delete", "id" }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FIELDS = ['title_ar', 'body_ar', 'title_en', 'body_en', 'target', 'starts_at', 'ends_at', 'active'];

function pick(src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of FIELDS) if (src[f] !== undefined) out[f] = src[f];
  return out;
}

const ts = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const ok = (data: unknown) =>
    new Response(JSON.stringify(data), { headers: { ...cors, 'Content-Type': 'application/json' } });
  const err = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

  const expected = Deno.env.get('ADMIN_TOKEN') ?? '';
  const got = req.headers.get('x-admin-token') ?? '';
  if (!expected || got !== expected) return err('غير مصرح', 401);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return err('JSON غلط');
  }

  const action = String(body.action ?? '');
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(url, serviceKey);

    if (action === 'list') {
      const { data, error } = await admin
        .from('broadcasts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return ok({ broadcasts: data });
    }

    if (action === 'create') {
      const titleAr = String(body.title_ar ?? '').trim();
      const bodyAr = String(body.body_ar ?? '').trim();
      if (!titleAr || !bodyAr) return err('ناقص العنوان أو النص بالعربي');
      const target = String(body.target ?? 'all');
      if (!['all', 'premium', 'free'].includes(target)) return err('الفئة غلط');
      const row = {
        ...pick(body),
        title_ar: titleAr,
        body_ar: bodyAr,
        title_en: String(body.title_en ?? '').trim(),
        body_en: String(body.body_en ?? '').trim(),
        target,
        starts_at: ts(body.starts_at) ?? new Date().toISOString(),
        ends_at: ts(body.ends_at),
      };
      const { data, error } = await admin.from('broadcasts').insert(row).select().single();
      if (error) throw error;
      return ok({ ok: true, broadcast: data });
    }

    if (action === 'update') {
      const id = String(body.id ?? '').trim();
      if (!id) return err('ناقص id');
      const patch = pick(body);
      if ('target' in patch && !['all', 'premium', 'free'].includes(String(patch.target))) {
        return err('الفئة غلط');
      }
      if ('starts_at' in patch) patch.starts_at = ts(patch.starts_at);
      if ('ends_at' in patch) patch.ends_at = ts(patch.ends_at);
      if (Object.keys(patch).length === 0) return err('ما فيه حقول للتعديل');
      const { data, error } = await admin.from('broadcasts').update(patch).eq('id', id).select().single();
      if (error) throw error;
      return ok({ ok: true, broadcast: data });
    }

    if (action === 'toggle') {
      const id = String(body.id ?? '').trim();
      if (!id) return err('ناقص id');
      const { data, error } = await admin
        .from('broadcasts')
        .update({ active: body.enabled !== false })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return ok({ ok: true, broadcast: data });
    }

    if (action === 'delete') {
      const id = String(body.id ?? '').trim();
      if (!id) return err('ناقص id');
      const { error } = await admin.from('broadcasts').delete().eq('id', id);
      if (error) throw error;
      return ok({ ok: true });
    }

    return err('action غلط');
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'failed';
    console.error('admin-broadcast failed:', msg);
    return err(msg, 500);
  }
});

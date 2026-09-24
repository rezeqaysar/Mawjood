// Supabase Edge Function: extract
// POST { note_id } → reads the note's transcript, asks the AI to pull out
// actionable items (tasks, appointments, shopping, place notes), stores them
// in public.items.
// AI provider: Groq (free) when GROQ_API_KEY is set, else OpenAI.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GROQ_API_KEY or OPENAI_API_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { aiConfig } from '../_shared/ai.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const today = new Date().toISOString().slice(0, 10);

const SYSTEM = `You extract actionable items from a voice-note transcript.

LANGUAGE RULE (strict): every title and details string MUST be in the SAME language as the transcript. Arabic transcript → ALL titles in Arabic, never English. English transcript → ALL titles in English, never Arabic. Never mix languages in one response.

Return ONLY valid JSON: {"items":[{"kind":"task|appointment|shopping|place|spec|opinion|checklist|thing","title":"...","details":"...","due_at":"ISO8601 datetime or null","price":"... or null"}],"borrows":[{"action":"lend|return","item":"...","borrower":"... or null","due_at":"ISO8601 datetime or null"}]}

Kinds:
- task: something to do (no specific date/time)
- appointment: a meeting or event with a date/time → set due_at. Today is ${today}; resolve relative days like "tomorrow" against it. Assume timezone America/New_York unless stated.
- shopping: things to buy → title is ONLY the item name, no verb: "حليب" not "شراء حليب", "milk" not "Buy milk". Split compounds into separate items: "almonds and bananas" → two items.
- place: where something was put or left ("I put the keys in the kitchen drawer")
- thing: something BOUGHT or OWNED ("I bought a screwdriver", "اشتريت مفك للبيت") → title is ONLY the item name ("مفك" not "اشتريت مفك"); put where it is in details ("في درج المطبخ", "at home"); put the price in "price" ("50 دولار", "$50") or null if not mentioned.
- spec: a specification or measurement worth remembering (filter size, model number, phone number) → put the value in details
- opinion: something tried with a verdict ("tried that restaurant, didn't like it") → put the verdict in details
- checklist: things to remember/bring/do before an event ("before traveling: passport, charger") → one item per thing
- Borrowing ("مين أخذها؟") → the "borrows" array, NEVER as an item:
  - lend: someone took or borrowed something ("أحمد أخذ المفك", "عيرت سارة المكنسة", "خالد استعار الشاحن", "أخذت المثقاب من أبو محمد") → {"action":"lend","item":"<ONLY the thing's name: مفك>","borrower":"<the person's name as said: أحمد>","due_at":"<ISO8601 if a return time was mentioned: ترجعها بكرا / لآخر الأسبوع> or null"}. Today is ${today} for relative days.
  - return: something was given back ("أحمد رجع المفك", "رجعت المكنسة", "استرجعت الشاحن من خالد") → {"action":"return","item":"<the thing's name>","borrower":"<name if mentioned> or null","due_at":null}.
  - A lend is NOT a purchase: never also emit it as a thing/shopping item.

Rules:
- Keep titles short (under 12 words); extra context goes in details.
- If nothing actionable was said, return {"items":[]}.
- Never invent dates or times that were not mentioned.
- TRANSCRIPT NOISE: the transcript comes from speech recognition and may contain mis-transcribed words ("آل حاسب" instead of "آلة حاسبة"). First decide the SINGLE most likely intended wording, then extract from that corrected reading as if it were the transcript. Emit each distinct item ONCE — never emit both a raw and a corrected variant of the same thing, and never split one purchase into several items.`;

const KINDS = new Set(['task', 'appointment', 'shopping', 'place', 'spec', 'opinion', 'checklist', 'thing']);

// Arabic-tolerant normalization for de-dupe / borrow matching:
// أإآٱ→ا, ة→ه, ى→ي, strip diacritics + tatweel, drop leading ال per word.
function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .split(/\s+/)
    .map((w) => w.replace(/^ال/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    const { note_id } = await req.json();
    if (!note_id) throw new Error('note_id is required');

    const { data: note, error: noteErr } = await supabase
      .from('notes')
      .select('id, space_id, transcript, created_by')
      .eq('id', note_id)
      .single();
    if (noteErr || !note) throw new Error('note not found');

    const empty = { ok: true, items: [] };
    if (!note.transcript?.trim()) {
      return new Response(JSON.stringify(empty), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    const aiCfg = aiConfig();
    // Retry on rate limits / overloaded backends: this fn is usually
    // fire-and-forget, so a single 429 must not silently lose the extraction.
    let aiRes: Response | null = null;
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000 * attempt));
      aiRes = await fetch(`${aiCfg.base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${aiCfg.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: aiCfg.chatModel,
          response_format: { type: 'json_object' },
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: note.transcript },
          ],
        }),
      });
      if (aiRes.ok) break;
      lastErr = `${aiCfg.provider} ${aiRes.status}: ${(await aiRes.text()).slice(0, 200)}`;
      if (aiRes.status !== 429 && aiRes.status !== 503) break;
      aiRes = null;
    }
    if (!aiRes?.ok) throw new Error(lastErr || 'extraction failed');
    const ai = await aiRes.json();

    let parsed: {
      items?: Array<{ kind: string; title: string; details?: string; due_at?: string | null; price?: string | null }>;
      borrows?: Array<{ action: string; item?: string; borrower?: string | null; due_at?: string | null }>;
    } = {};
    try {
      parsed = JSON.parse(ai.choices?.[0]?.message?.content ?? '{}');
    } catch {
      parsed = {};
    }
    const raw = Array.isArray(parsed.items) ? parsed.items : [];

    const rows = raw
      .filter(
        (it) =>
          it &&
          typeof it.title === 'string' &&
          it.title.trim().length > 0 &&
          KINDS.has(it.kind),
      )
      .slice(0, 20)
      .map((it) => {
        let due: string | null = null;
        if (it.due_at) {
          const d = new Date(it.due_at);
          if (!Number.isNaN(d.getTime())) due = d.toISOString();
        }
        return {
          space_id: note.space_id,
          note_id: note.id,
          kind: it.kind,
          title: it.title.trim().slice(0, 200),
          details: typeof it.details === 'string' ? it.details.slice(0, 1000) : null,
          due_at: due,
          status: 'open',
          // thing extras (price) — null until migration 0005 adds the column
          meta: typeof it.price === 'string' && it.price.trim() ? { price: it.price.trim().slice(0, 100) } : null,
        };
      });

    if (rows.length > 0) {
      // Re-read the note's CURRENT space: the client may have moved the note
      // (AI space classification) while extraction was running — items must
      // follow the note, not the stale space_id read at the start.
      const { data: freshNote } = await supabase
        .from('notes')
        .select('space_id')
        .eq('id', note.id)
        .single();
      const liveSpaceId = freshNote?.space_id ?? note.space_id;
      for (const r of rows) r.space_id = liveSpaceId;
      // de-dupe: skip items that already exist as open in this space
      // (same kind + same normalized title) — repeated notes shouldn't
      // pile up identical shopping items.
      const norm = (t: string) =>
        t
          .toLowerCase()
          .replace(/[ً-ٰٟ]/g, '')
          .replace(/ـ/g, '')
          .replace(/[أإآٱ]/g, 'ا')
          .replace(/ة/g, 'ه')
          .replace(/ى/g, 'ي')
          .replace(/^(شراء|شرا|buy|buying)\s+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      const { data: existing } = await supabase
        .from('items')
        .select('kind, title')
        .eq('space_id', note.space_id)
        .neq('status', 'done');
      const seen = new Set(
        (existing ?? []).map((e) => `${e.kind}:${norm(e.title)}`),
      );
      const fresh = rows.filter((r) => {
        const k = `${r.kind}:${norm(r.title)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (fresh.length > 0) {
        // Shopping is list-only: group shopping items from this note into ONE
        // list (unassigned — no push), insert everything else as loose items.
        const shopRows = fresh.filter((r) => r.kind === 'shopping');
        const otherRows = fresh.filter((r) => r.kind !== 'shopping');
        const insertRows = async (rows: typeof fresh) => {
          const { error: insErr } = await supabase.from('items').insert(rows);
          if (insErr) {
            // migration 0005 (meta column) not applied yet → retry without meta
            if (/meta/i.test(insErr.message)) {
              const stripped = rows.map(({ meta: _m, ...rest }) => rest);
              const { error: retryErr } = await supabase.from('items').insert(stripped);
              if (retryErr) throw retryErr;
            } else throw insErr;
          }
        };
        if (otherRows.length > 0) await insertRows(otherRows);
        if (shopRows.length > 0) {
          const listTitle =
            shopRows.length === 1 ? `🛒 ${shopRows[0].title}` : '🛒 قائمة تسوق';
          const { data: list, error: listErr } = await supabase
            .from('shopping_lists')
            .insert({
              space_id: liveSpaceId,
              title: listTitle,
              assigned_to: null,
              assigned_name: null,
              status: 'open',
            })
            .select('id')
            .single();
          if (listErr) throw listErr;
          await insertRows(shopRows.map((r) => ({ ...r, list_id: list.id })));
        }
      }
    }

    // ── Borrowing ("مين أخذها؟") ──
    // lend → open row in borrows (de-duped); return → stamp returned_at.
    // Best-effort: never fail extraction over a borrow event.
    try {
      const rawBorrows = Array.isArray(parsed.borrows) ? parsed.borrows : [];
      const events = rawBorrows
        .filter(
          (b) =>
            b &&
            (b.action === 'lend' || b.action === 'return') &&
            typeof b.item === 'string' &&
            b.item.trim().length > 0,
        )
        .slice(0, 10);
      if (events.length > 0) {
        const { data: freshNote2 } = await supabase
          .from('notes')
          .select('space_id')
          .eq('id', note.id)
          .single();
        const liveSpaceId = freshNote2?.space_id ?? note.space_id;
        const { data: openBorrows } = await supabase
          .from('borrows')
          .select('id, item_title, borrower')
          .eq('space_id', liveSpaceId)
          .is('returned_at', null);
        const open = (openBorrows ?? []) as { id: string; item_title: string; borrower: string }[];
        const parseDue = (v: string | null | undefined): string | null => {
          if (!v) return null;
          const d = new Date(v);
          return Number.isNaN(d.getTime()) ? null : d.toISOString();
        };
        for (const ev of events) {
          const itemNorm = normTitle(ev.item!.trim());
          const borrowerRaw = typeof ev.borrower === 'string' ? ev.borrower.trim().slice(0, 120) : '';
          if (ev.action === 'lend') {
            if (!borrowerRaw) continue;
            const borrowerNorm = normTitle(borrowerRaw);
            const dup = open.some(
              (o) => normTitle(o.item_title) === itemNorm && normTitle(o.borrower) === borrowerNorm,
            );
            if (dup) continue;
            const { data: ins } = await supabase
              .from('borrows')
              .insert({
                space_id: liveSpaceId,
                item_title: ev.item!.trim().slice(0, 200),
                borrower: borrowerRaw,
                due_at: parseDue(ev.due_at),
                note_id: note.id,
                created_by: (note as { created_by?: string | null }).created_by ?? null,
              })
              .select('id, item_title, borrower')
              .single();
            if (ins) open.push(ins as { id: string; item_title: string; borrower: string });
          } else {
            // return: match open borrows by item (and borrower when given)
            const borrowerNorm = borrowerRaw ? normTitle(borrowerRaw) : null;
            const hits = open.filter(
              (o) =>
                normTitle(o.item_title) === itemNorm &&
                (borrowerNorm === null || normTitle(o.borrower) === borrowerNorm),
            );
            if (hits.length > 0) {
              const now = new Date().toISOString();
              await supabase
                .from('borrows')
                .update({ returned_at: now })
                .in('id', hits.map((h) => h.id));
              const hitIds = new Set(hits.map((h) => h.id));
              for (let i = open.length - 1; i >= 0; i--) {
                if (hitIds.has(open[i].id)) open.splice(i, 1);
              }
            }
          }
        }
      }
    } catch { /* ignore — borrow tracking must not break extraction */ }

    // Photo propagation: if the note has an attached photo ("photograph, then
    // talk about it"), copy it onto the 📦 thing items extracted from this
    // note, so the photo shows in "أشيائي" too — not just in the chat bubble.
    // Best-effort and defensive: never fail extraction over a photo.
    try {
      const { data: notePhoto } = await supabase
        .from('notes')
        .select('photo_url')
        .eq('id', note.id)
        .single();
      const photoUrl = (notePhoto as { photo_url?: string | null } | null)?.photo_url ?? null;
      if (photoUrl) {
        const { data: things } = await supabase
          .from('items')
          .select('id, meta')
          .eq('note_id', note.id)
          .eq('kind', 'thing');
        for (const th of (things ?? []) as { id: string; meta: Record<string, unknown> | null }[]) {
          if (th.meta?.photo_url) continue;
          await supabase
            .from('items')
            .update({ meta: { ...(th.meta ?? {}), photo_url: photoUrl } })
            .eq('id', th.id);
        }
      }
    } catch { /* ignore — photo linking must not break extraction */ }

    return new Response(JSON.stringify({ ok: true, items: rows }), {
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

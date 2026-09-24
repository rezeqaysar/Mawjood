import { aiConfig } from '../_shared/ai.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const SPACE_LABEL: Record<string, string> = {
  private: '🔒 الخاصة',
  family: '👨‍👩‍👧 العائلة',
  work: '💼 الشغل',
};

// deterministic space fallback when the agent's pick is invalid
const WORK_RE =
  /(شغل|الشغل|عمل|اجتماع|الاجتماع|مدير|المدير|عميل|العميل|شركة|الشركة|مكتب|المكتب|مشروع|المشروع|راتب|work|meeting|boss|manager|client|office|company|project|salary|invoice)/i;
const FAMILY_RE =
  /(أولاد|اولاد|عيلة|عائلة|العيلة|بيت|البيت|دار|مدرسة|المدرسة|زوجة|زوج|أم|ام|أب|اب|بنت|ولد|جد|ست|خال|عم|بدنا|نشتري|منشتري|اشتري|إشتري|شراء|شرا|سوبرماركت|مشتريات|تسوق|family|kids|kid|home|house|wife|husband|school|mama|baba|mother|father|son|daughter|buy|buying|groceries|grocery|supermarket|shopping)/i;
function ruleSpace(text: string): 'private' | 'family' | 'work' {
  if (WORK_RE.test(text)) return 'work';
  if (FAMILY_RE.test(text)) return 'family';
  return 'private';
}

// ── fast path: a confident space pick needs no model call at all ──
// (mirrors the route fn's instant layers; desk-vs-office disambiguation included)
// When BOTH spaces match, an explicit destination ("للعمل" vs "للبيت") wins;
// a genuinely mixed note (different things for different spaces) returns null
// so the agent splits it instead of cramming it into one space.
const DESK_RE = /(درج|جارور|طاولة)\s+(المكتب|مكتب)/;
const WORK_DEST_RE = /(للعمل|للشغل|للمكتب|للشركة|for work|for the office)/i;
const FAM_DEST_RE = /(للبيت|للدار|للعيلة|للعائلة|لأهلي|لاهلي|for home|for the house)/i;
function ruleSpaceConfident(text: string): 'family' | 'work' | null {
  const tt = DESK_RE.test(text) ? text.replace(/المكتب|مكتب/g, '') : text;
  const w = WORK_RE.test(tt);
  const f = FAMILY_RE.test(tt);
  if (w && !f) return 'work';
  if (f && !w) return 'family';
  if (w && f) {
    const wd = WORK_DEST_RE.test(tt);
    const fd = FAM_DEST_RE.test(tt);
    if (wd && !fd) return 'work';
    if (fd && !wd) return 'family';
  }
  return null;
}
const CORRECTION_START = /^(لا|بس|بل)([\s،,؛;:.!?؟]|$)/;
const EN_CORRECTION_START = /^(no|nope)[\s,.]/i;
const QUESTION_MARK = /[؟?]/;
const REASK_RE =
  /(سالتك|سألتك|سئلتك)|ما (حكيت|قلت)(لك|لي) (تضيف|تحفظ|تسجل)|ما (جاوبت|رديت)/;
const QUESTION_RE =
  /^(وين|وينتا|وينت|فين|اين|متى|متي|امتى|امتي|ايمتى|ايمت|وقتاش|شو|ايش|اشنو|شنو|ماذا|مذا|كم|قديش|كيف|ليش|لماذا|هل|مين|من)(\s|$)|(^|\s)(وين|فين|اين)(و|ها|هم|هن|ك|ي|نا|كم)?([\s؟?]|$)|^(اعرض|اعرضي|اعرضلي|فرجيني|فرجيلي|ورجيني|ارجيني|طلعلي)(\s|$)|(^|\s)(ذكرني|ذكري|فكرني|قلي|قولي|احكيلي|احكي)(\s+)(شو|وين|وينتا|وينت|فين|اين|متى|متي|امتى|امتي|ايمتى|ايش|اشنو|شنو|ماذا|مذا|كم|قديش|كيف|ليش|لماذا|هل|مين|من)(\s|$)/;
const EN_QUESTION_RE =
  /^(what|where|when|who|whom|whose|why|how|is|are|was|were|do|does|did|can|could|will|would|show|list|remind)\b/i;
// visual question: the user asks about a photo they just attached
// ("شو شايف؟", "what is this?", "اوصف الصورة"...)
const VISUAL_Q_RE =
  /(شايف|شايفه|شايفة|شوف|صورة|صور|هاي|هاد|هاظ|this|that|image|picture|photo|pic|see|saw|look|describe|صف|اوصف|مبين)/i;

// raw space matches (before disambiguation) — used to detect mixed-space notes
function spaceMatches(text: string): { work: boolean; family: boolean } {
  const tt = DESK_RE.test(text) ? text.replace(/المكتب|مكتب/g, '') : text;
  return { work: WORK_RE.test(tt), family: FAMILY_RE.test(tt) };
}

// Dedicated splitter: one focused model call that divides a mixed-space
// message into per-space parts. More reliable than hoping the ReAct agent
// remembers to split while juggling tools.
const SPLIT_SYSTEM = `You split one message into separate notes by living space. Spaces: work = job/office, family = home/household/kids, private = personal.
Reply with ONLY JSON: {"parts":[{"text":"<the exact relevant words>","space_type":"work|family|private"}]}
Rules:
- Keep the original wording of each part, including verbs like "اشتريت" (so a purchase stays a purchase).
- A trailing detail that applies to everything (like a price) goes on the LAST part only.
- If the message is really a single note for one space, return exactly one part.`;

// deno-lint-ignore no-explicit-any
function parseSplit(raw: string): { text: string; space_type: string }[] | null {
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const p = JSON.parse(clean);
    const parts = p.parts ?? p;
    if (!Array.isArray(parts)) return null;
    const out = parts
      .filter((x) => typeof x?.text === 'string' && x.text.trim())
      .map((x) => ({
        text: String(x.text).slice(0, 500),
        space_type: ['private', 'family', 'work'].includes(x.space_type) ? x.space_type : 'private',
      }));
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

const SYSTEM = `You are Mawjood, the user's personal memory assistant. You remember their notes, appointments, shopping lists, tasks, and where they put things. You don't just answer — you ACT on their data.

Reply with ONLY one JSON object per step, nothing else:
- To use a tool: {"thought":"<why>","tool":"<name>","args":{...}}
- To finish: {"thought":"<why>","answer":"<final message to the user>"}

Rules:
- Answer in the SAME language as the user (Levantine-friendly Arabic for Arabic). Keep answers short (1-3 sentences) unless a list was asked.
- NEVER invent data. If search/get_agenda returns nothing relevant, say you don't have that info and ask a clarifying question.
- Questions about their data → search or get_agenda FIRST, then answer from what the tools returned.
- "شو عندي اليوم/بكرا" (what do I have today/tomorrow) → get_agenda with the right date.
- Something to remember ("عندي موعد...", "بدنا نشتري...", "حطيت X بـ...") → save_note with the right space_type:
  family = home life, groceries, household, spouse, kids, "we"
  work = job, meeting, boss, client, office
  private = personal (health, medication, personal belongings) — default when unsure
  After saving, confirm briefly, e.g. "انحفظت بمساحة 👨‍👩‍👧 العائلة".
- Corrections ("لا، ...", "مش هاي") → find the item from the conversation or via search FIRST, then update_item. Never guess an id.
- When calling update_item / delete_note / move_note, use the FULL id exactly as shown (id=...). Never invent, shorten, or truncate an id.
- Something BOUGHT or OWNED ("اشتريت مفك للبيت", "شريت حاسبة للعمل", "I bought a screwdriver") → save_note with the right space_type; extraction turns it into a 📦 thing item with place + price. Confirm briefly, e.g. "انحفظ المفك بأشيائي بمساحة 👨‍👩‍👧 العائلة". If the user mentions where it is or the price, keep those exact words in the note text so they get stored.
- ONE MESSAGE, SEVERAL SPACES: if the message contains things for DIFFERENT spaces ("اشتريت آلة حاسبة للعمل ومفك أحمر للبيت"), call save_note once PER space with only the relevant part, KEEPING the original wording including verbs like "اشتريت" (so "اشتريت آلة حاسبة للعمل" stays a purchase — never strip it down to "آلة حاسبة للعمل", or extraction will misread it as something to buy). Keep a shared trailing detail like the price on the last item, then confirm all parts, e.g. "انحفظت الآلة الحاسبة بمساحة 💼 الشغل والمفك بمساحة 👨‍👩‍👧 العائلة". Never cram mixed-space content into a single note.
- Voice transcripts may contain speech-recognition errors ("آل حاسب" for "آلة حاسبة"). Interpret what the user MEANT, don't echo obvious errors back, and save the corrected wording in the note.
- "Where is X" questions (وين حطيت..., فين..., وين المفك؟): the place ITEM (kind=place) AND the thing ITEM (kind=thing) are the source of truth — they reflect the latest corrections. Note transcripts are just history. If an item and a note disagree, trust the item. Prefer search with kind="place" or kind="thing" for these questions.
- Borrowing ("مين أخذها؟"): open borrows show up in search results as {type:"borrow", id, item_title, borrower} and in your context lines. "مين أخذ X؟" → search, then answer who has it and since when. "وين X؟" → if an open borrow exists for X, lead with who has it ("المفك مع أحمد — أخذه بتاريخ …"), then mention its usual place if known. Lend statements ("أحمد أخذ المفك", "عيرت سارة المكنسة") → save_note with the right space_type (extraction records the borrow); confirm briefly, e.g. "انحفظ: المفك مع أحمد 🤝". Return statements ("رجع المفك", "أحمد رجع الشاحن") → search borrows FIRST; if an open borrow matches, call return_borrow and confirm ("✅ رجع المفك — كان مع أحمد"); if nothing matches, say you have no record of it being lent out — do NOT save it as a note.
- If search shows duplicate open items for the same thing, update ALL of them (one update_item call per id), not just one.
- Delete a note ONLY when the user explicitly asks (امسح / delete). Never delete otherwise.
- If this message arrived as an already-saved voice note (a session note id is given below): when you answer it as a question or apply it as a correction, delete that note afterwards with delete_note so it doesn't linger as a junk note. When it's a real note to keep, move it to the right space with move_note if needed. If one voice note contains things for DIFFERENT spaces, delete the session note and save one note per space instead — never leave the full mixed text duplicated across spaces.

Tools:
- search(query, kind?) — search notes and items. kind: appointment|shopping|task|place|thing (omit for all)
- get_agenda(date) — open appointments on a date (YYYY-MM-DD)
- save_note(text, space_type) — save something to remember
- delete_note(note_id)
- move_note(note_id, space_type)
- update_item(item_id, details?, due_at?, status?, title?) — status: open|done
- return_borrow(borrow_id) — mark a borrowed item as returned

Examples:
user "وينتا موعدي عند المحامي" → {"thought":"question about an appointment, search first","tool":"search","args":{"query":"المحامي","kind":"appointment"}}
user "مين أخذ المفك؟" → {"thought":"who-borrowed question, search first","tool":"search","args":{"query":"مفك"}}
user "رجع المفك" → {"thought":"return statement, check open borrows first","tool":"search","args":{"query":"مفك"}}
user "بدنا نشتري حليب" → {"thought":"family shopping note","tool":"save_note","args":{"text":"بدنا نشتري حليب","space_type":"family"}}
user "شو عندي بكرا" → {"thought":"agenda question","tool":"get_agenda","args":{"date":"2026-09-24"}}
user "اشتريت مفك للبيت" → {"thought":"bought a thing for home → family thing item","tool":"save_note","args":{"text":"اشتريت مفك للبيت","space_type":"family"}}
user "وين المفك؟" → {"thought":"where-is question about a thing, search things","tool":"search","args":{"query":"مفك","kind":"thing"}}`;

type HistMsg = { role: string; text: string };

// deno-lint-ignore no-explicit-any
type Supa = any;

async function toolSearch(supa: Supa, args: { query?: string; kind?: string }) {
  const q = (args.query ?? '').trim().slice(0, 80).replace(/[%(),]/g, '');
  if (!q) return { results: [] };
  const like = `%${q}%`;
  const kind = ['appointment', 'shopping', 'task', 'place', 'thing'].includes(args.kind ?? '') ? args.kind : null;
  const [notesRes, itemsRes, borrowsRes] = await Promise.all([
    supa.from('notes').select('id, transcript, created_at, space_id').ilike('transcript', like).order('created_at', { ascending: false }).limit(6),
    (() => {
      let iq = supa.from('items').select('id, kind, title, details, due_at, status, space_id, meta').or(`title.ilike.${like},details.ilike.${like}`).order('created_at', { ascending: false }).limit(8);
      if (kind) iq = iq.eq('kind', kind);
      return iq;
    })(),
    // open borrows ("مين أخذها؟") — searched alongside notes/items
    supa.from('borrows').select('id, item_title, borrower, lent_at, due_at, space_id').or(`item_title.ilike.${like},borrower.ilike.${like}`).is('returned_at', null).order('lent_at', { ascending: false }).limit(5),
  ]);
  const out: unknown[] = [];
  for (const n of notesRes.data ?? []) {
    out.push({ type: 'note', id: n.id, text: (n.transcript ?? '').slice(0, 160), when: n.created_at?.slice(0, 10), space_id: n.space_id });
  }
  for (const it of itemsRes.data ?? []) {
    out.push({ type: 'item', id: it.id, kind: it.kind, title: it.title, details: (it.details ?? '').slice(0, 120), due_at: it.due_at, status: it.status, space_id: it.space_id, price: it.meta?.price ?? null });
  }
  for (const b of borrowsRes.data ?? []) {
    out.push({ type: 'borrow', id: b.id, item_title: b.item_title, borrower: b.borrower, since: (b.lent_at ?? '').slice(0, 10), due_at: b.due_at, space_id: b.space_id });
  }
  return { results: out };
}

async function toolAgenda(supa: Supa, args: { date?: string }) {
  const d = (args.date ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'bad date, use YYYY-MM-DD' };
  const { data } = await supa.from('items')
    .select('id, kind, title, details, due_at, status')
    .eq('kind', 'appointment').eq('status', 'open')
    .gte('due_at', `${d}T00:00:00`).lt('due_at', `${d}T23:59:59`)
    .order('due_at');
  return { appointments: data ?? [] };
}

async function toolSaveNote(supa: Supa, userId: string, spaceByType: Record<string, string>, args: { text?: string; space_type?: string }, photoUrl?: string | null) {
  const text = (args.text ?? '').trim().slice(0, 1000);
  if (!text) return { error: 'empty text' };
  let st = args.space_type;
  if (st !== 'private' && st !== 'family' && st !== 'work') st = ruleSpace(text);
  const space_id = spaceByType[st];
  if (!space_id) return { error: 'no space' };
  const { data, error } = await supa.from('notes').insert({
    space_id, transcript: text, language: 'ar', status: 'ready', created_by: userId,
    photo_url: photoUrl ?? null,
  }).select('id').single();
  if (error) return { error: error.message };
  // fire-and-forget extraction (same as the transcribe pipeline)
  try {
    const base = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    fetch(`${base}/functions/v1/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ note_id: data.id }),
    }).catch(() => {});
  } catch { /* ignore */ }
  return { note_id: data.id, space_type: st, space_label: SPACE_LABEL[st] };
}

async function toolDeleteNote(supa: Supa, args: { note_id?: string }) {
  if (!args.note_id) return { error: 'note_id required' };
  const { error } = await supa.from('notes').delete().eq('id', args.note_id);
  return error ? { error: error.message } : { deleted: true };
}

async function toolMoveNote(supa: Supa, spaceByType: Record<string, string>, args: { note_id?: string; space_type?: string }) {
  const st = args.space_type;
  if (!args.note_id || (st !== 'private' && st !== 'family' && st !== 'work')) return { error: 'bad args' };
  const { error } = await supa.from('notes').update({ space_id: spaceByType[st] }).eq('id', args.note_id);
  return error ? { error: error.message } : { moved_to: st, space_label: SPACE_LABEL[st] };
}

async function toolUpdateItem(supa: Supa, args: { item_id?: string; details?: string; due_at?: string; status?: string; title?: string }) {
  if (!args.item_id) return { error: 'item_id required' };
  // deno-lint-ignore no-explicit-any
  const patch: Record<string, any> = {};
  if (args.details !== undefined) patch.details = String(args.details).slice(0, 500);
  if (args.title !== undefined) patch.title = String(args.title).slice(0, 200);
  if (args.due_at !== undefined) patch.due_at = args.due_at;
  if (args.status === 'open' || args.status === 'done') patch.status = args.status;
  if (Object.keys(patch).length === 0) return { error: 'nothing to update' };
  const { error } = await supa.from('items').update(patch).eq('id', args.item_id);
  return error ? { error: error.message } : { updated: true };
}

async function toolReturnBorrow(supa: Supa, args: { borrow_id?: string }) {
  if (!args.borrow_id) return { error: 'borrow_id required' };
  const { data, error } = await supa
    .from('borrows')
    .update({ returned_at: new Date().toISOString() })
    .eq('id', args.borrow_id)
    .is('returned_at', null)
    .select('id, item_title, borrower')
    .single();
  if (error) return { error: error.message };
  return data ?? { updated: true };
}

// deno-lint-ignore no-explicit-any
async function runTool(supa: Supa, userId: string, spaceByType: Record<string, string>, name: string, args: any, photoUrl?: string | null) {
  switch (name) {
    case 'search': return await toolSearch(supa, args ?? {});
    case 'get_agenda': return await toolAgenda(supa, args ?? {});
    case 'save_note': return await toolSaveNote(supa, userId, spaceByType, args ?? {}, photoUrl);
    case 'delete_note': return await toolDeleteNote(supa, args ?? {});
    case 'move_note': return await toolMoveNote(supa, spaceByType, args ?? {});
    case 'update_item': return await toolUpdateItem(supa, args ?? {});
    case 'return_borrow': return await toolReturnBorrow(supa, args ?? {});
    default: return { error: `unknown tool: ${name}` };
  }
}

// deno-lint-ignore no-explicit-any
async function callModel(ai: any, messages: any[], retries = 1): Promise<string> {
  const aiRes = await fetch(`${ai.base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ai.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: ai.chatModel, temperature: 0.2, max_tokens: 450, messages }),
  });
  if (!aiRes.ok) {
    // retry once on rate limits / overloaded backends, then surface a clean error
    if (retries > 0 && (aiRes.status === 429 || aiRes.status === 503)) {
      await new Promise((r) => setTimeout(r, 1500));
      return callModel(ai, messages, retries - 1);
    }
    throw new Error('الخدمة مضغوطة هلق (الطبقة المجانية)، جرّب بعد دقيقة.');
  }
  const j = await aiRes.json();
  return (j.choices?.[0]?.message?.content ?? '').trim();
}

// Vision: the user attached a photo and asks about it — the model actually
// looks at the image. Returns the answer text, or null when the vision call
// fails (caller then answers gracefully instead of guessing blind).
// deno-lint-ignore no-explicit-any
async function callVision(ai: any, imageUrl: string, question: string, retries = 1): Promise<string | null> {
  const sys = `You are Mawjood, a warm assistant inside a family memory app. The user attached a photo and asks about it. Look at the image carefully and answer their question directly in the SAME language they used (Levantine Arabic if they write Arabic). Be concise: 1-3 sentences. Describe only what you actually see — never invent details, people, or text that is not in the image. Reply with ONLY the answer, no preamble.`;
  try {
    const aiRes = await fetch(`${ai.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ai.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ai.visionModel,
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: 'system', content: sys },
          {
            role: 'user',
            content: [
              { type: 'text', text: question.slice(0, 500) },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
    });
    if (!aiRes.ok) {
      if (retries > 0 && (aiRes.status === 429 || aiRes.status === 503)) {
        await new Promise((r) => setTimeout(r, 1500));
        return callVision(ai, imageUrl, question, retries - 1);
      }
      return null;
    }
    const j = await aiRes.json();
    const raw = (j.choices?.[0]?.message?.content ?? '').trim();
    // strip a thinking preamble if the model leaks one
    const clean = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return clean || null;
  } catch {
    return null;
  }
}

function salvageStep(raw: string): { tool?: string; args?: unknown; answer?: string } | null {
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const p = JSON.parse(clean);
    if (typeof p.answer === 'string') return { answer: p.answer };
    if (typeof p.tool === 'string') return { tool: p.tool, args: p.args ?? {} };
  } catch { /* fall through */ }
  const a = clean.match(/"answer"\s*:\s*"([\s\S]*?)"\s*[,}]/);
  if (a) return { answer: a[1] };
  const t = clean.match(/"tool"\s*:\s*"(\w+)"/);
  if (t) return { tool: t[1], args: {} };
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { text, history, note_id, photo_url, today } = await req.json();
    if (!text?.trim()) throw new Error('text is required');
    const t = text.slice(0, 1000);
    // photo attached in chat ("photograph, then talk about it") — the client
    // uploads it first and passes the public URL; the vision branch above
    // lets the model actually look at it when the user asks about the photo.
    const photoUrl =
      typeof photo_url === 'string' && photo_url.startsWith('https://')
        ? photo_url.slice(0, 500)
        : null;
    const hist: HistMsg[] = Array.isArray(history) ? history.slice(-6) : [];
    const todayStr = /^\d{4}-\d{2}-\d{2}$/.test(today ?? '') ? today : new Date().toISOString().slice(0, 10);

    const auth = req.headers.get('Authorization') ?? '';
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: auth } },
    });
    const { data: userData } = await supa.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) throw new Error('not authenticated');

    // spaces map
    const { data: spaces } = await supa.from('spaces').select('id, type');
    const spaceByType: Record<string, string> = {};
    for (const s of spaces ?? []) spaceByType[s.type] = s.id;

    const ai = aiConfig();

    // ── vision: a photo is attached and the user asks about what they see
    // ("شو شايف في هاي الصورة؟"). The note (with its photo) is saved first so
    // the memory persists, then the vision model actually looks at the image.
    const tTrim = t.trim();
    const looksQuestion =
      QUESTION_MARK.test(t) || QUESTION_RE.test(tTrim) || EN_QUESTION_RE.test(tTrim);
    const looksCorrection =
      CORRECTION_START.test(tTrim) || EN_CORRECTION_START.test(tTrim) || REASK_RE.test(t);
    if (photoUrl && (looksQuestion || /^(اوصف|صف)\b/.test(tTrim)) && VISUAL_Q_RE.test(t)) {
      if (!note_id) {
        // text path: persist the photo+question as a note (voice path already did)
        await toolSaveNote(supa, userId, spaceByType, { text: t }, photoUrl);
      }
      const seen = await callVision(ai, photoUrl, t);
      const answer = seen ?? 'ما قدرت أشوف الصورة هلأ (الخدمة مضغوطة)، جرّب بعد شوي.';
      return new Response(JSON.stringify({ answer, actions: ['save_note', 'vision'] }), {
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ── fast path: return statements ("رجع المفك") — deterministic, no model.
    // Only fires when exactly one open borrow matches; otherwise the agent
    // handles it (and won't save junk notes for unknown returns).
    const RETURN_RE = /(^|[\s،,؛:.!?؟])(رجع|رجعت|رجعوا|رجعو|استرجع|استرجعت)([\s،,؛:.!?؟]|$)/;
    if (!looksQuestion && !looksCorrection && RETURN_RE.test(t)) {
      try {
        const normW = (s: string) =>
          s.toLowerCase().replace(/[ً-ٰٟ]/g, '').replace(/ـ/g, '').replace(/[أإآٱ]/g, 'ا')
            .replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, ' ').trim();
        const stop = new Set(['رجع', 'رجعت', 'رجعوا', 'رجعو', 'استرجع', 'استرجعت', 'من', 'ل', 'الى', 'إلى', 'إلي', 'عند', 'مع', 'و', 'اللي', 'اللى', 'هاد', 'هاي', 'هاظ', 'الي', 'التي', 'الذي']);
        const words = normW(t).split(' ')
          .filter((w) => w && !stop.has(w) && w.length > 1)
          .map((w) => w.replace(/^(ال|لل|ل|ب|ف)/, ''));
        const { data: openB } = await supa.from('borrows')
          .select('id, item_title, borrower')
          .is('returned_at', null)
          .in('space_id', Object.values(spaceByType));
        const hits = (openB ?? []).filter((b: { item_title: string }) => {
          const bn = normW(b.item_title).split(' ').map((w) => w.replace(/^ال/, '')).join(' ');
          return words.some((w) => bn.includes(w) || w.includes(bn));
        });
        if (hits.length === 1) {
          const hb = hits[0] as { id: string; item_title: string; borrower: string };
          await supa.from('borrows').update({ returned_at: new Date().toISOString() }).eq('id', hb.id).is('returned_at', null);
          const ar = /[؀-ۿ]/.test(t);
          const answer = ar
            ? `✅ رجع ${hb.item_title} — كان مع ${hb.borrower}`
            : `✅ ${hb.item_title} marked as returned (was with ${hb.borrower})`;
          return new Response(JSON.stringify({ answer, actions: ['return_borrow (fast-path)'] }), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        // 0 or ambiguous hits → fall through to the agent
      } catch { /* fall through to the agent */ }
    }

    // ── fast path: a plain statement with a confident space skips the model
    // entirely (no ReAct round-trips). Questions, corrections and ambiguous
    // notes still go through the agent below.
    if (!looksQuestion && !looksCorrection) {
      const fastSpace = ruleSpaceConfident(t);
      if (fastSpace) {
        const ar = /[؀-ۿ]/.test(t);
        if (note_id) {
          // voice note already saved: just move it to the right space
          const moved = await toolMoveNote(supa, spaceByType, { note_id, space_type: fastSpace });
          if (!moved.error) {
            const answer = ar
              ? `انحفظت بمساحة ${SPACE_LABEL[fastSpace]}`
              : `Saved to ${moved.space_label}`;
            return new Response(JSON.stringify({ answer, actions: ['move_note (fast-path)'] }), {
              headers: { ...cors, 'Content-Type': 'application/json' },
            });
          }
        } else {
          const saved = await toolSaveNote(supa, userId, spaceByType, { text: t, space_type: fastSpace }, photoUrl);
          if (!saved.error) {
            const answer = ar
              ? `انحفظت بمساحة ${saved.space_label}`
              : `Saved to ${saved.space_label}`;
            return new Response(JSON.stringify({ answer, actions: ['save_note (fast-path)'] }), {
              headers: { ...cors, 'Content-Type': 'application/json' },
            });
          }
        }
        // if the direct write failed, fall through to the agent
      }
    }

    // ── mixed path: the note spans two spaces (e.g. a work purchase and a
    // family purchase in one breath). Split deterministically: one model call
    // decides the parts, then we save each part directly.
    const sm = spaceMatches(t);
    if (sm.work && sm.family && ruleSpaceConfident(t) === null) {
      // deno-lint-ignore no-explicit-any
      const splitRaw = await callModel(ai, [
        { role: 'system', content: SPLIT_SYSTEM },
        // deno-lint-ignore no-explicit-any
        { role: 'user', content: t } as any,
      ]).catch(() => '');
      const parts = splitRaw ? parseSplit(splitRaw) : null;
      if (parts && parts.length > 1) {
        if (note_id) await toolDeleteNote(supa, { note_id });
        const doneLabels: string[] = [];
        for (const p of parts) {
          const saved = await toolSaveNote(supa, userId, spaceByType, { text: p.text, space_type: p.space_type }, photoUrl);
          if (!saved.error) doneLabels.push(SPACE_LABEL[p.space_type]);
        }
        if (doneLabels.length > 0) {
          const ar = /[؀-ۿ]/.test(t);
          const answer = ar
            ? `انحفظت بمساحة ${doneLabels.join(' ومساحة ')}`
            : `Saved to ${doneLabels.join(' and ')}`;
          return new Response(JSON.stringify({ answer, actions: ['split+save_note x' + doneLabels.length] }), {
            headers: { ...cors, 'Content-Type': 'application/json' },
          });
        }
        // if every save failed, fall through to the agent
      } else if (parts && parts.length === 1) {
        // model says it's really one note → save it directly, no ReAct needed
        if (note_id) {
          const moved = await toolMoveNote(supa, spaceByType, { note_id, space_type: parts[0].space_type });
          if (!moved.error) {
            const ar = /[؀-ۿ]/.test(t);
            const answer = ar ? `انحفظت بمساحة ${moved.space_label}` : `Saved to ${moved.space_label}`;
            return new Response(JSON.stringify({ answer, actions: ['move_note (split-single)'] }), {
              headers: { ...cors, 'Content-Type': 'application/json' },
            });
          }
        } else {
          const saved = await toolSaveNote(supa, userId, spaceByType, { text: parts[0].text, space_type: parts[0].space_type }, photoUrl);
          if (!saved.error) {
            const ar = /[؀-ۿ]/.test(t);
            const answer = ar ? `انحفظت بمساحة ${saved.space_label}` : `Saved to ${saved.space_label}`;
            return new Response(JSON.stringify({ answer, actions: ['save_note (split-single)'] }), {
              headers: { ...cors, 'Content-Type': 'application/json' },
            });
          }
        }
      }
      // unparseable split → fall through to the agent
    }

    // light context: recent notes + open items (so the agent often answers without a tool round-trip)
    const [notesRes, itemsRes, openBorrowsRes] = await Promise.all([
      supa.from('notes').select('id, transcript, created_at, space_id').order('created_at', { ascending: false }).limit(8),
      supa.from('items').select('id, kind, title, details, due_at, status, meta').eq('status', 'open').order('created_at', { ascending: false }).limit(20),
      supa.from('borrows').select('id, item_title, borrower, lent_at, due_at').is('returned_at', null).order('lent_at', { ascending: false }).limit(10),
    ]);
    const ctxLines: string[] = [];
    for (const n of (notesRes.data ?? []).reverse()) {
      ctxLines.push(`- note id=${n.id} (${(n.created_at ?? '').slice(0, 10)}): ${(n.transcript ?? '').slice(0, 120)}`);
    }
    for (const it of (itemsRes.data ?? []).reverse()) {
      ctxLines.push(`- ${it.kind} id=${it.id} "${it.title}"${it.details ? ` — ${String(it.details).slice(0, 80)}` : ''}${it.due_at ? ` @ ${it.due_at.slice(0, 16)}` : ''}${it.meta?.price ? ` (price: ${it.meta.price})` : ''}`);
    }
    for (const b of (openBorrowsRes.data ?? []).reverse()) {
      ctxLines.push(`- borrow id=${b.id} "${b.item_title}" مع ${b.borrower} (من ${(b.lent_at ?? '').slice(0, 10)})${b.due_at ? ` — ترجع ${(b.due_at ?? '').slice(0, 10)}` : ''}`);
    }

    const convo = hist.map((m) => `${m.role === 'user' ? 'user' : 'assistant'}: ${(m.text ?? '').slice(0, 300)}`).join('\n');
    const sessionNote = note_id
      ? `\nThis message arrived as an already-saved voice note (id: ${note_id}). If you answer it as a question or apply it as a correction, delete that note afterwards with delete_note. If it's a real note to keep, move it to the right space with move_note when needed.`
      : '';

    // deno-lint-ignore no-explicit-any
    const messages: any[] = [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `Today is ${todayStr}.\n\nYour recent notes and open items:\n${ctxLines.join('\n') || '(none yet)'}\n\n${convo ? `Recent conversation:\n${convo}\n\n` : ''}${sessionNote}\nUser message: ${t}\n\nReply with ONLY one JSON object.`,
      },
    ];

    let answer = 'ما قدرت أفهم الطلب — جرّب تصيغه بطريقة ثانية.';
    const actions: string[] = [];
    for (let step = 0; step < 5; step++) {
      const raw = await callModel(ai, messages);
      const stepParsed = salvageStep(raw);
      if (!stepParsed) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'That was not valid JSON. Reply with ONLY one JSON object: {"thought":"...","tool":"...","args":{...}} or {"thought":"...","answer":"..."}' });
        continue;
      }
      if (stepParsed.answer !== undefined) {
        answer = stepParsed.answer.slice(0, 1500);
        break;
      }
      if (stepParsed.tool) {
        const result = await runTool(supa, userId, spaceByType, stepParsed.tool, stepParsed.args, photoUrl);
        actions.push(`${stepParsed.tool}`);
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: `Tool "${stepParsed.tool}" result: ${JSON.stringify(result).slice(0, 2000)}\n\nContinue: use another tool if needed, or reply with {"thought":"...","answer":"..."} (ONLY the JSON object).` });
        continue;
      }
      break;
    }

    return new Response(JSON.stringify({ answer, actions }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});

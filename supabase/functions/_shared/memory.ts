// ── 🧠 Memory engine ("ذاكرة زي Muse") ─────────────────────────────────────
// ONE shared engine consumed by:
//   * memory-learn      — implicit learning: extracts durable facts from every
//                         chat turn (the app learns like Muse, not just from
//                         explicit "ناديني X" commands)
//   * chat              — recall: relevance-ranked facts injected per turn +
//                         remember_fact / forget_fact / list_memories tools
//   * memory-consolidate — nightly: daily episodes, dedupe, decay, cap
//
// Store: items rows with kind='memory' (migration 0023) in the user's PRIVATE
// space — owner-only by RLS, invisible in every tab. meta carries:
//   { mkey, mcat, layer, importance 1-5, source: 'explicit'|'learned'|'episode' }
//
// Zero-dependency, extractable: pure functions + a tiny Supabase surface.
// No pgvector needed — v1 retrieval is token-overlap scoring with Arabic
// normalization; swap scoreFact() for vector search later without touching
// the consumers.

// deno-lint-ignore no-explicit-any
type Supa = any;

export interface LearnedFact {
  /** one concise line in the user's language, e.g. "بيناديني: أبو كريم" */
  content: string;
  /** stable snake_case key, e.g. "identity:name" — same concept, same key */
  mkey: string;
  /** identity|family|preference|routine|meaning|entity|episode|place_habit|route */
  mcat: string;
  /** 1-5: 5 = identity/family core, 1 = trivial */
  importance: number;
  /** optional structured payload (e.g. routing rules) — persisted into meta */
  // deno-lint-ignore no-explicit-any
  meta?: Record<string, any>;
}

export interface MemoryRow {
  id: string;
  title: string;
  details: string | null;
  meta: Record<string, any>;
  created_at: string;
  updated_at: string;
}

/** Arabic-aware normalization: uniform matching across dialects. */
export function normAr(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^ء-غف-يa-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set([
  'انا', 'انت', 'انتي', 'هو', 'هي', 'احنا', 'نحن', 'هاد', 'هاي', 'هاظ', 'هادا',
  'هيدا', 'اللي', 'اللى', 'التي', 'الذي', 'في', 'من', 'على', 'الى', 'إلى',
  'مع', 'و', 'او', 'أو', 'بس', 'كمان', 'عشان', 'عند', 'عندي', 'شو', 'ايش',
  'مين', 'وين', 'كيف', 'ليش', 'the', 'a', 'an', 'and', 'or', 'is', 'are',
  'my', 'me', 'i',
]);

function tokens(s: string): string[] {
  return normAr(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w));
}

/** Relevance of one fact to the current user message. */
export function scoreFact(f: MemoryRow, queryTokens: string[]): number {
  const factTokens = new Set(tokens(`${f.title} ${f.details ?? ''}`));
  if (factTokens.size === 0 || queryTokens.length === 0) return 0;
  let hits = 0;
  for (const q of queryTokens) {
    for (const t of factTokens) {
      if (t === q || (t.length > 3 && q.length > 3 && (t.includes(q) || q.includes(t)))) {
        hits++;
        break;
      }
    }
  }
  const importance = Number(f.meta?.importance ?? 3);
  const daysOld =
    (Date.now() - new Date(f.updated_at ?? f.created_at).getTime()) / 86400000;
  const recency = Math.max(0, 1 - daysOld / 180);
  return hits * 3 + importance * 0.6 + recency * 0.5;
}

/** Load all open memory facts for a space. */
export async function loadFacts(supa: Supa, spaceId: string): Promise<MemoryRow[]> {
  const { data } = await supa
    .from('items')
    .select('id, title, details, meta, created_at, updated_at')
    .eq('space_id', spaceId)
    .eq('kind', 'memory')
    .eq('status', 'open')
    .order('updated_at', { ascending: false })
    .limit(300);
  return (data ?? []) as MemoryRow[];
}

/**
 * Recall: top-N facts ranked for THIS message (like Muse re-reading MEMORY.md
 * every turn — but relevance-ranked, so 200 facts don't bloat the prompt).
 */
export async function recallFacts(
  supa: Supa,
  spaceId: string,
  query: string,
  limit = 12,
): Promise<MemoryRow[]> {
  const facts = await loadFacts(supa, spaceId);
  const qt = tokens(query);
  return facts
    .filter((f) => f.meta?.mcat !== 'route') // routing rules aren't conversational memories
    .map((f) => ({ f, s: scoreFact(f, qt) }))
    .filter((x) => x.s > 1.2)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f);
}

export function factLine(f: MemoryRow): string {
  const v = (f.details ?? '').trim();
  return v ? `${f.title}: ${v}`.slice(0, 140) : f.title.slice(0, 140);
}

/** System prompt for the extraction call. Existing facts are passed so the
 *  model reuses mkeys instead of duplicating ("smart" dedupe at write time). */
export function learnSystem(existing: MemoryRow[], uiAr: boolean): string {
  const known = existing
    .slice(0, 40)
    .map((f) => `- ${String(f.meta?.mkey ?? '?')}: ${factLine(f)}`)
    .join('\n');
  return `You extract DURABLE user memories from one conversation turn. Reply with ONLY JSON: {"facts":[{"content":"...","mkey":"...","mcat":"...","importance":1-5}]}.

Rules:
- "content": ONE concise line in the ${uiAr ? 'user\u2019s language (Levantine Arabic as they write it)' : 'user\u2019s language'}.
- "mkey": stable snake_case key (identity:name, family:son_name, preference:wake_time, routine:friday, meaning:خضرة, place_habit:keys). SAME concept as an existing fact below → reuse its exact mkey (that updates it instead of duplicating).
- "mcat": identity | family | preference | routine | meaning | entity | place_habit
- "importance": 5 = identity/family core · 4 = strong preference/routine · 3 = useful fact · 2 = weak · 1 = trivial
- Extract ONLY lasting facts: name/nickname, family members + relations, routines, habits, strong likes/dislikes, word meanings, where they habitually keep things.
- NEVER extract: one-off tasks, appointments, shopping items, places of single notes (those live in items/notes already) · transient statements ("I'm tired now") · the assistant's own words as user facts.
- PRIVACY HARD RULE: if the turn mentions secret words, codes, passwords, PINs, or anything the user wants hidden/protected, extract NOTHING from that turn. Secrets are never memorized.
- If nothing durable: {"facts":[]}.

Already known (reuse mkeys!):
${known || '(none yet)'}`;
}

/** Parse the model's extraction reply. Never throws. */
export function parseLearned(raw: string): LearnedFact[] {
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const p = JSON.parse(clean);
    const arr = Array.isArray(p.facts) ? p.facts : [];
    return arr
      .filter((x: any) => typeof x?.content === 'string' && x.content.trim())
      .map((x: any) => ({
        content: String(x.content).trim().slice(0, 160),
        mkey: String(x.mkey ?? '').toLowerCase().replace(/[^a-z0-9_:ء-غف-ي-]/g, '').slice(0, 60) || `fact:${Date.now()}`,
        mcat: ['identity', 'family', 'preference', 'routine', 'meaning', 'entity', 'place_habit', 'episode'].includes(x.mcat) ? x.mcat : 'preference',
        importance: Math.min(5, Math.max(1, Number(x.importance) || 3)),
      }))
      .slice(0, 8);
  } catch {
    return [];
  }
}

/**
 * Upsert learned facts. Same mkey → update + reinforce (importance bump, like
 * Muse's "last reinforced"). Returns counts for logging.
 */
export async function upsertFacts(
  supa: Supa,
  spaceId: string,
  userId: string,
  facts: LearnedFact[],
  source: 'learned' | 'explicit' | 'episode' = 'learned',
): Promise<{ saved: number; updated: number }> {
  let saved = 0;
  let updated = 0;
  for (const f of facts) {
    const { data: existing } = await supa
      .from('items')
      .select('id, meta')
      .eq('space_id', spaceId)
      .eq('kind', 'memory')
      .eq('status', 'open')
      .eq('meta->>mkey', f.mkey)
      .limit(1)
      .maybeSingle();
    if (existing) {
      const oldImp = Number(existing.meta?.importance ?? 3);
      await supa
        .from('items')
        .update({
          details: f.content,
          updated_at: new Date().toISOString(),
          meta: { ...(existing.meta ?? {}), ...(f.meta ?? {}), importance: Math.min(5, Math.max(oldImp, f.importance) + (oldImp >= f.importance ? 1 : 0)), mcat: f.mcat, source },
        })
        .eq('id', existing.id);
      updated++;
    } else {
      const { error } = await supa.from('items').insert({
        space_id: spaceId,
        kind: 'memory',
        title: f.mkey,
        details: f.content,
        status: 'open',
        created_by: userId,
        meta: { ...(f.meta ?? {}), mkey: f.mkey, mcat: f.mcat, layer: f.mcat === 'episode' ? 'episode' : 'fact', importance: f.importance, source },
      });
      if (!error) saved++;
    }
  }
  return { saved, updated };
}

/** Cap the store: drop the weakest (low importance, stalest) beyond `keep`. */
export async function pruneFacts(supa: Supa, spaceId: string, keep = 200): Promise<number> {
  const facts = await loadFacts(supa, spaceId);
  if (facts.length <= keep) return 0;
  const victim = facts
    .slice()
    .sort((a, b) => Number(a.meta?.importance ?? 3) - Number(b.meta?.importance ?? 3) || (a.updated_at < b.updated_at ? -1 : 1))
    .slice(0, facts.length - keep);
  let n = 0;
  for (const v of victim) {
    const { error } = await supa.from('items').delete().eq('id', v.id);
    if (!error) n++;
  }
  return n;
}

/** Find the user's private space id (memory lives there, owner-only). */
export async function privateSpaceId(supa: Supa): Promise<string | null> {
  const { data } = await supa.from('spaces').select('id').eq('type', 'private').limit(1).maybeSingle();
  return (data as any)?.id ?? null;
}

// ── 🗂️ tabs.ts: tab-aware AI helpers ────────────────────────────────────
// What the chat agent needs to READ tabs and PROPOSE new ones:
//
//   resolveTabName(tabs, query) — pure fuzzy match ("الاوراق الخاصة" finds
//                                 📄 اوراقي الخاصة; "اشياء احمد" finds أشياء أحمد)
//   listTabs(supa, spaceId, spaceType) — tabs + live note counts
//   getTabNotes(supa, spaceId, tabId, limit) — newest notes + total count
//
// Pure parts are unit-tested in supabase/tests/unit.test.mjs (no Deno APIs,
// no imports beyond routing.ts). DB readers take the caller's supabase client
// so RLS applies; the secret vault (tab_id='secret') is never listed.

import { normAr } from './routing.ts';

export interface TabRef {
  id: string; // 'main' | 'papers' | space_tabs uuid
  title: string;
  icon: string;
  isCustom: boolean;
  noteCount: number;
}

export interface TabNote {
  id: string;
  title: string; // first line of the transcript
  snippet: string; // transcript slice for the model to categorize
  created_at: string;
}

// "اوراقي"→"اوراق", "اشيائي"→"اشياء", "تبويبي"→"تبويب": possessive suffixes
// that users add/drop freely when naming a tab out loud.
const stripPossessive = (w: string): string =>
  w.replace(/(ي|ك|ه|ها|هم|هن|كن|نا)$/, '');

// Canonical form for comparison: normalized, no ال-prefix, no possessive.
const canon = (s: string): string =>
  stripPossessive(normAr(s).replace(/^(ال|لل|بال|كال|فال)/, '').trim());

export function resolveTabName(
  tabs: { id: string; title: string }[],
  query: string,
): { id: string; title: string } | null {
  const q = normAr(query ?? '')
    .replace(/^(تبويب|فولدر|مجلد)\s+/, '')
    .trim();
  if (!q) return null;
  const norm = tabs.map((t) => ({ ...t, n: normAr(t.title), c: canon(t.title) }));
  const qc = canon(q);
  // 1) exact normalized match
  let hit = norm.find((t) => t.n === q);
  if (hit) return hit;
  // 2) canonical match (ال-prefix + possessives stripped)
  hit = norm.find((t) => t.c === qc);
  if (hit) return hit;
  // 3) contains either way ("اوراق" ⊂ "اوراقي الخاصه")
  hit = norm.find((t) => t.n.includes(q) || q.includes(t.n));
  if (hit) return hit;
  // 4) every query token appears in the title (canonicalized)
  const qt = qc.split(/\s+/).filter((w) => w.length > 1);
  if (qt.length > 0) {
    hit = norm.find((t) => qt.every((tok) => t.c.includes(tok)));
    if (hit) return hit;
  }
  return null;
}

// deno-lint-ignore no-explicit-any
type Supa = any;

/** All tabs of a space the agent can read: main notes + 📄 papers (private/work) + custom tabs, with live note counts. */
export async function listTabs(supa: Supa, spaceId: string, spaceType: string): Promise<TabRef[]> {
  const tabs: TabRef[] = [
    { id: 'main', title: 'الملاحظات الرئيسية', icon: '📝', isCustom: false, noteCount: 0 },
  ];
  if (spaceType === 'private' || spaceType === 'work') {
    tabs.push({ id: 'papers', title: 'اوراقي الخاصة', icon: '📄', isCustom: false, noteCount: 0 });
  }
  try {
    const { data: rows } = await supa
      .from('space_tabs')
      .select('id, title, icon')
      .eq('space_id', spaceId)
      .order('position', { ascending: true });
    for (const r of rows ?? []) {
      tabs.push({ id: r.id, title: r.title, icon: r.icon ?? '📁', isCustom: true, noteCount: 0 });
    }
  } catch { /* custom tabs degrade to built-ins */ }
  // live note counts (the secret vault is excluded everywhere)
  try {
    const { data: notes } = await supa
      .from('notes')
      .select('tab_id')
      .eq('space_id', spaceId)
      .is('deleted_at', null)
      .neq('tab_id', 'secret');
    const counts: Record<string, number> = {};
    for (const n of notes ?? []) {
      const k = n.tab_id == null ? 'main' : String(n.tab_id);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const t of tabs) t.noteCount = counts[t.id] ?? 0;
  } catch { /* counts stay 0 */ }
  return tabs;
}

const firstLine = (s: string): string =>
  (s ?? '').split('\n')[0].trim().slice(0, 80);

/** Newest notes of one tab + the total count (for "شو في عندي في الأوراق؟"). */
export async function getTabNotes(
  supa: Supa,
  spaceId: string,
  tabId: string,
  limit = 20,
): Promise<{ notes: TabNote[]; totalCount: number }> {
  const lim = Math.min(Math.max(limit, 1), 30);
  // deno-lint-ignore no-explicit-any
  let q: any = supa
    .from('notes')
    .select('id, transcript, created_at')
    .eq('space_id', spaceId)
    .is('deleted_at', null)
    .neq('tab_id', 'secret')
    .order('created_at', { ascending: false })
    .limit(lim);
  q = tabId === 'main' ? q.is('tab_id', null) : q.eq('tab_id', tabId);
  // deno-lint-ignore no-explicit-any
  let cq: any = supa
    .from('notes')
    .select('id', { count: 'exact', head: true })
    .eq('space_id', spaceId)
    .is('deleted_at', null)
    .neq('tab_id', 'secret');
  cq = tabId === 'main' ? cq.is('tab_id', null) : cq.eq('tab_id', tabId);
  const [{ data }, { count }] = await Promise.all([q, cq]);
  const notes: TabNote[] = (data ?? []).map(
    (n: { id: string; transcript: string; created_at: string }) => ({
      id: n.id,
      title: firstLine(n.transcript) || '—',
      snippet: (n.transcript ?? '').slice(0, 200),
      created_at: (n.created_at ?? '').slice(0, 10),
    }),
  );
  return { notes, totalCount: count ?? notes.length };
}

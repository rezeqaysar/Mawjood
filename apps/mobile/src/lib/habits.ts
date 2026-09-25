// ── 📊 Habit-learning engine ("الريموت 9 من 10 مرات كان بالصالون") ────
// Place items already record (item → place) over time; this aggregates
// them into frequencies — no new storage, pure aggregation.
// Feeds two surfaces:
//   1. the detective: learned places outrank heuristic suspects
//      ("🕵️ الصالون (9 من 10 مرات)")
//   2. "وين بلاقي الريموت عادة؟" → a direct probabilistic answer
//
// REUSABLE BY DESIGN: no React, no UI imports — pure intent detection,
// data shaping and formatting. Nothing here touches storage except
// through the structural HabitClient.

import type { Item } from '@mawjood/voice-engine';
import { tx } from './i18n';

/** Minimal client surface habit learning needs — structural typing. */
export interface HabitClient {
  listSpaces(): Promise<{ id: string }[]>;
  search(
    spaceId: string,
    query: string,
    opts: { kinds?: string[]; includeNotes?: boolean },
  ): Promise<{ items: Item[] }>;
}

export interface PlaceHabit {
  place: string;
  count: number;
  total: number;
}

// ── intent detection ────────────────────────────────────────────────

function cleanCapture(s: string): string {
  return s
    .trim()
    .replace(/^(my|the)\s+/i, '')
    .replace(/[؟?!.,،:؛]+$/g, '')
    .trim();
}

const AR_HABIT: RegExp[] = [
  /وين\s+(?:عادة|عادةً)\s+(?:بلاقي|بحط|بخلي|بحطه)\s+(.+)/, // وين عادة بلاقي الريموت
  /وين\s+بلاقي\s+(.+?)\s+عادة/, // وين بلاقي الريموت عادة
  /عادة\s+وين\s+(?:بلاقي|بحط)\s+(.+)/,
  /وين\s+متعود\s+(?:أحط|احط|أخلي|اخلي)\s+(.+)/, // وين متعود أحط الريموت
];

const EN_HABIT: RegExp[] = [
  /where\s+do\s+i\s+usually\s+(?:find|leave|keep|put)\s+(.+)/i,
  /where\s+is\s+(?:the\s+|my\s+)?(.+?)\s+usually/i,
];

/** "وين بلاقي الريموت عادة؟" → the item name, else null. */
export function parseHabitQuery(text: string): string | null {
  const clean = text.trim();
  for (const re of [...AR_HABIT, ...EN_HABIT]) {
    const m = clean.match(re);
    if (m?.[1]) {
      const item = cleanCapture(m[1]);
      if (item.length > 0 && item.length <= 40) return item;
    }
  }
  return null;
}

// ── aggregation ─────────────────────────────────────────────────────

function stripAl(s: string): string {
  return s.trim().replace(/^ال/, '');
}

/** "ريموت" ↔ "الريموت" both ways. */
export function itemNamesMatch(a: string, b: string): boolean {
  const x = stripAl(a).toLowerCase();
  const y = stripAl(b).toLowerCase();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/** "على طاولة الصالون" / "في الصالون" / "بالصالون" → one group key. */
function normPlace(s: string): string {
  let p = s.trim().toLowerCase();
  p = p.replace(/^(في|على|at|in|on)\s+/i, '');
  p = p.replace(/^بال/, 'ال'); // بالصالون → الصالون
  p = p.replace(/^ب/, ''); // بدرج → درج
  p = p.replace(/^ال/, '');
  return p.trim();
}

function queryVariants(item: string): string[] {
  const v = new Set<string>();
  v.add(item);
  const noAl = stripAl(item);
  if (noAl !== item) v.add(noAl);
  if (!item.startsWith('ال')) v.add('ال' + item);
  return [...v];
}

/** Aggregate (item → place) records into frequencies, most common first. */
export function computeHabits(
  items: Pick<Item, 'title' | 'details'>[],
  item: string,
): PlaceHabit[] {
  const groups = new Map<string, { display: string; count: number }>();
  let total = 0;
  for (const it of items ?? []) {
    if (!itemNamesMatch(it.title, item)) continue;
    const where = (it.details ?? '').trim();
    if (!where) continue;
    const key = normPlace(where);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { display: where, count: 1 });
    total++;
  }
  return [...groups.values()]
    .map((g) => ({ place: g.display, count: g.count, total }))
    .sort((a, b) => b.count - a.count);
}

/** Fetch + aggregate across every space. */
export async function getPlaceHabits(client: HabitClient, item: string): Promise<PlaceHabit[]> {
  const spaces = await client.listSpaces().catch(() => []);
  const all: Item[] = [];
  const variants = queryVariants(item);
  await Promise.all(
    spaces.map(async (s) => {
      for (const v of variants) {
        try {
          const { items } = await client.search(s.id, v, {
            kinds: ['place', 'thing'],
            includeNotes: false,
          });
          all.push(...(items ?? []));
        } catch {
          /* a failing space must not kill the aggregation */
        }
      }
    }),
  );
  return computeHabits(all, item);
}

// ── formatting ──────────────────────────────────────────────────────

/** "الريموت عادةً بالصالون (9 من 10 مرات)" (+ runners-up). */
export function formatHabit(item: string, habits: PlaceHabit[]): string {
  if (habits.length === 0) return tx('habitNone', { item });
  const top = habits[0];
  const head = tx('habitTop', {
    item,
    place: top.place,
    count: String(top.count),
    total: String(top.total),
  });
  if (habits.length === 1) return head;
  const rest = habits
    .slice(1, 3)
    .map((h) => tx('habitOther', { place: h.place, count: String(h.count) }))
    .join('\n');
  return `${head}\n${rest}`;
}

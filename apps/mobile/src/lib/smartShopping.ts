// ── 🛒 Smart shopping engine ("شو ناقصنا؟") ──────────────────────────
// Purchase history (bought shopping items with bought_at) reveals
// rhythms: "حليب كل 5 أيام". When a rhythm is due, the item is probably
// forgotten — the heart of "أشيائنا الي بنشتريها ع طول وبننساها".
//
// REUSABLE BY DESIGN: no React, no UI imports — pure intent detection,
// data shaping and formatting. Nothing here touches storage except
// through the structural SmartShoppingClient.

import type { ShoppingList } from '@mawjood/voice-engine';
import { getLang, t, tx } from './i18n';

/** Minimal client surface smart shopping needs — structural typing. */
export interface SmartShoppingClient {
  listShoppingLists(spaceId: string): Promise<ShoppingList[]>;
  createShoppingList(input: {
    spaceId: string;
    title: string;
    assignedTo: string | null;
    assignedName: string | null;
    items: string[];
    userId?: string;
  }): Promise<ShoppingList>;
}

export interface BuyRhythm {
  item: string;
  count: number;
  intervalDays: number; // median days between purchases
  lastBoughtAt: string; // ISO
  daysSince: number;
  overdueBy: number; // days past the rhythm (≥ 0 when due)
}

// ── intent detection ────────────────────────────────────────────────

const AR_SMART: RegExp[] = [
  /شو\s+ناقص(نا|كم)/, // شو ناقصنا؟
  /ايش\s+ناقص(نا|كم)/,
  /شو\s+لازم\s+نشتري/,
  /شو\s+بيخلص/,
  /شو\s+رح\s+يخلص/,
];

const EN_SMART: RegExp[] = [
  /what\s+are\s+we\s+running\s+out\s+of/i,
  /what\s+do\s+we\s+need\s+to\s+buy/i,
];

/** "شو ناقصنا؟" → true. */
export function parseSmartQuery(text: string): boolean {
  const clean = text.trim();
  return [...AR_SMART, ...EN_SMART].some((re) => re.test(clean));
}

const AR_ADD: RegExp[] = [/^(ضيفهم|ضيفهن|حطهم بالقائمة|زدهم)\s*$/];
const EN_ADD: RegExp[] = [/^add them\s*$/i];

/** "ضيفهم" (follow-up after suggestions) → true. */
export function parseSmartAdd(text: string): boolean {
  const clean = text.trim();
  return [...AR_ADD, ...EN_ADD].some((re) => re.test(clean));
}

// ── rhythm analysis ─────────────────────────────────────────────────

function stripAl(s: string): string {
  return s.trim().replace(/^ال/, '');
}

function normName(s: string): string {
  return stripAl(s).toLowerCase();
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** bought_at history per item → rhythms (needs ≥2 purchases). */
export function computeRhythms(
  purchases: { name: string; at: string }[],
  now = Date.now(),
): BuyRhythm[] {
  const groups = new Map<string, { display: string; ats: number[] }>();
  for (const p of purchases) {
    const key = normName(p.name);
    if (!key) continue;
    const ts = new Date(p.at).getTime();
    if (Number.isNaN(ts)) continue;
    const g = groups.get(key);
    if (g) g.ats.push(ts);
    else groups.set(key, { display: p.name.trim(), ats: [ts] });
  }
  const rhythms: BuyRhythm[] = [];
  for (const g of groups.values()) {
    if (g.ats.length < 2) continue;
    const sorted = g.ats.sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((sorted[i] - sorted[i - 1]) / 864e5);
    }
    const interval = Math.max(1, Math.round(median(gaps)));
    const last = sorted[sorted.length - 1];
    const daysSince = Math.max(0, Math.floor((now - last) / 864e5));
    rhythms.push({
      item: g.display,
      count: sorted.length,
      intervalDays: interval,
      lastBoughtAt: new Date(last).toISOString(),
      daysSince,
      overdueBy: daysSince - interval,
    });
  }
  return rhythms;
}

/** Rhythms whose time has (almost) come, most overdue first. */
export function getSuggestions(rhythms: BuyRhythm[]): BuyRhythm[] {
  return rhythms
    .filter((r) => r.daysSince >= r.intervalDays * 0.85)
    .sort((a, b) => b.overdueBy - a.overdueBy);
}

/** All bought items (status done + bought_at) in a space, newest last. */
export async function getBuyHistory(
  client: SmartShoppingClient,
  spaceId: string,
): Promise<{ name: string; at: string }[]> {
  const lists = await client.listShoppingLists(spaceId).catch(() => []);
  const out: { name: string; at: string }[] = [];
  for (const l of lists ?? []) {
    for (const it of l.items ?? []) {
      if (it.status === 'done' && it.bought_at) {
        out.push({ name: it.title, at: it.bought_at });
      }
    }
  }
  return out;
}

// ── formatting ──────────────────────────────────────────────────────

function arDays(n: number): string {
  if (n <= 0) return 'اليوم';
  if (n === 1) return 'يوم';
  if (n === 2) return 'يومين';
  if (n <= 10) return `${n} أيام`;
  return `${n} يوم`;
}

function arAgo(n: number): string {
  if (n <= 0) return 'اليوم';
  if (n === 1) return 'قبل يوم';
  if (n === 2) return 'قبل يومين';
  if (n <= 10) return `قبل ${n} أيام`;
  return `قبل ${n} يوم`;
}

/** "🛒 شكله ناقصكم:\n• حليب — كل 5 أيام، وآخر مرة قبل 6 أيام\n…" */
export function formatSuggestions(suggestions: BuyRhythm[]): string {
  if (suggestions.length === 0) return t('smartNone');
  const ar = getLang() === 'ar';
  const lines = suggestions.slice(0, 8).map((s) =>
    tx('smartLine', {
      item: s.item,
      interval: ar ? arDays(s.intervalDays) : `${s.intervalDays} days`,
      ago: ar ? arAgo(s.daysSince) : `${s.daysSince} days ago`,
    }),
  );
  return `${t('smartTitle')}\n${lines.join('\n')}\n${t('smartHint')}`;
}

export function formatSmartAdded(title: string, items: string[]): string {
  return tx('smartAdded', { title, items: items.join('، ') });
}

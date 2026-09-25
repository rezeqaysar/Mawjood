// ── 🔍 Detective engine ("ضيّعت الريموت") ───────────────────────────────
// A lost-item report turns into a ranked search plan:
//   1. known places from memory (place/thing items' details)
//   2. open borrows involving the item ("مع أحمد")
//   3. heuristic suspect places per item type (remote → couch, keys → entryway…)
// then an interactive check-off session lives in chat:
//   "شطبت الصالون" → marks it checked, suggests the next spot
//   "لقيته!" → celebrates, asks where, and SAVES the answer as place
//   memory so next time "وين الريموت؟" answers instantly.
//   "بث للعيلة" → hands off to the family-broadcast engine.
//
// REUSABLE BY DESIGN: no React, no UI imports — pure intent detection,
// data shaping and formatting. Session state is a plain object the caller
// holds (e.g. a ref); nothing here touches storage except through the
// structural LostClient. Pull this file into anything: chat interception,
// a widget, a server edge function (pair with a server client).

import type { Borrow, Item } from '@mawjood/voice-engine';
import { getLang, t, tx } from './i18n';

/** Minimal client surface the detective needs — structural typing. */
export interface LostClient {
  listSpaces(): Promise<{ id: string }[]>;
  search(
    spaceId: string,
    query: string,
    opts: { kinds?: string[]; includeNotes?: boolean },
  ): Promise<{ items: Item[] }>;
  listBorrows(spaceId: string): Promise<Borrow[]>;
  createItem(input: {
    spaceId: string;
    kind: 'place';
    title: string;
    details?: string | null;
    userId?: string;
  }): Promise<Item>;
}

export interface PlanPlace {
  name: string;
  source: 'memory' | 'borrow' | 'suspect';
  detail?: string;
}

export interface SearchPlan {
  item: string;
  places: PlanPlace[];
}

/** Interactive check-off state — the caller keeps this (e.g. a ref). */
export interface SearchSession {
  item: string;
  places: PlanPlace[];
  checked: string[];
  awaitingPlace: boolean;
}

// ── intent detection ────────────────────────────────────────────────

function cleanCapture(s: string): string {
  return s.trim().replace(/[؟?!.,،:؛]+$/g, '').trim();
}

const AR_LOST: RegExp[] = [
  /ضيّ?عت\s+(.+)/, // ضيعت / ضيّعت الريموت (الشدة على الياء)
  /فقدت\s+(.+)/,
  /(?:مش|مو)\s+لاقي(?:ة)?\s+(.+)/, // مش لاقي / مو لاقية الريموت
  /دورت\s+على\s+(.+?)\s+وما\s+لقيت/, // دورت على الريموت وما لقيت
];

const EN_LOST: RegExp[] = [
  /\bi\s+lost\s+(?:my\s+)?(.+)/i,
  /\blost\s+my\s+(.+)/i,
  /can'?t\s+find\s+(?:my\s+)?(.+)/i,
  /cannot\s+find\s+(?:my\s+)?(.+)/i,
  /misplaced\s+(?:my\s+)?(.+)/i,
];

/** "ضيّعت الريموت" / "I lost the remote" → the item name, else null. */
export function parseLostReport(text: string): string | null {
  const clean = text.trim();
  for (const re of [...AR_LOST, ...EN_LOST]) {
    const m = clean.match(re);
    if (m?.[1]) {
      const item = cleanCapture(m[1]);
      if (item.length > 0 && item.length <= 40) return item;
    }
  }
  return null;
}

/** "لقيته!" / "لقيتها" / "found it" → the search is over. */
export function parseFoundIt(text: string): boolean {
  const c = text.trim().replace(/[؟?!.,،:؛]+$/g, '').trim();
  return /^(لقيته|لقيتها|لقيتو|وجدته)$/.test(c) || /^(found it|i found it)$/i.test(c);
}

const AR_CHECKED: RegExp[] = [
  /شطبت\s+(.+)/, // شطبت الصالون
  /شيكت\s+على\s+(.+)/,
  /دورت\s+(?:ب|في|بال)\s*(.+?)(?:\s+وما\s+لقيت.*)?$/, // دورت بالصالون / دورت بالصالون وما لقيت
  /ما\s+لقيت.*\s+(?:ب|في|بال)\s*(.+)/, // ما لقيته بالصالون
];

const EN_CHECKED: RegExp[] = [
  /checked\s+(.+)/i,
  /looked\s+in\s+(.+)/i,
];

/** "شطبت الصالون" / "checked the living room" → the place name, else null. */
export function parseCheckedPlace(text: string): string | null {
  const clean = text.trim();
  for (const re of [...AR_CHECKED, ...EN_CHECKED]) {
    const m = clean.match(re);
    if (m?.[1]) {
      const place = cleanCapture(m[1]);
      if (place.length > 0 && place.length <= 40) return place;
    }
  }
  return null;
}

// ── search plan ─────────────────────────────────────────────────────

function stripAl(s: string): string {
  return s.trim().replace(/^ال/, '');
}

/** "ريموت" ↔ "الريموت" both ways. */
function namesMatch(a: string, b: string): boolean {
  const x = stripAl(a).toLowerCase();
  const y = stripAl(b).toLowerCase();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

function queryVariants(item: string): string[] {
  const v = new Set<string>();
  v.add(item);
  const noAl = stripAl(item);
  if (noAl !== item) v.add(noAl);
  if (!item.startsWith('ال')) v.add('ال' + item);
  return [...v];
}

// Heuristic suspect places per item type — labeled as guesses, not memory.
const SUSPECTS: { re: RegExp; ar: string[]; en: string[] }[] = [
  {
    re: /ريموت|remote/i,
    ar: ['تحت الكنبة', 'بين وسايد الكنبة', 'طاولة القهوة', 'غرفة النوم'],
    en: ['under the couch', 'between the couch cushions', 'the coffee table', 'the bedroom'],
  },
  {
    re: /مفاتيح|keys/i,
    ar: ['طاولة المدخل', 'جيب الجاكيت', 'المطبخ', 'درج التسريحة'],
    en: ['the entryway table', 'your jacket pocket', 'the kitchen', 'the dresser drawer'],
  },
  {
    re: /محفظة|جزدان|wallet/i,
    ar: ['جيب البنطلون', 'طاولة المدخل', 'غرفة النوم', 'السيارة'],
    en: ['your pants pocket', 'the entryway table', 'the bedroom', 'the car'],
  },
  {
    re: /نظارة|نضارة|glasses/i,
    ar: ['طاولة السرير', 'الحمام', 'المطبخ', 'السيارة'],
    en: ['the nightstand', 'the bathroom', 'the kitchen', 'the car'],
  },
  {
    re: /تلفون|جوال|موبايل|هاتف|phone/i,
    ar: ['تحت الوسادة', 'بين وسايد الكنبة', 'المطبخ', 'السيارة'],
    en: ['under the pillow', 'between the couch cushions', 'the kitchen', 'the car'],
  },
  {
    re: /شاحن|charger/i,
    ar: ['جنب السرير', 'الصالون', 'المكتب', 'السيارة'],
    en: ['by the bed', 'the living room', 'the desk', 'the car'],
  },
];

const GENERIC_AR = ['المطبخ', 'الصالون', 'غرفة النوم', 'الحمام', 'السيارة', 'مدخل البيت'];
const GENERIC_EN = ['the kitchen', 'the living room', 'the bedroom', 'the bathroom', 'the car', 'the entryway'];

/**
 * Build the ranked plan: memory places first, then open borrows,
 * then heuristic suspects. Searches every space — a lost remote
 * doesn't care which space its place note lives in.
 */
export async function buildSearchPlan(client: LostClient, item: string): Promise<SearchPlan> {
  const places: PlanPlace[] = [];
  const seen = new Set<string>();
  const add = (p: PlanPlace) => {
    const key = stripAl(p.name).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    places.push(p);
  };

  const spaces = await client.listSpaces().catch(() => []);
  const variants = queryVariants(item);

  // 1. known places from memory (place/thing details)
  await Promise.all(
    spaces.map(async (s) => {
      for (const v of variants) {
        try {
          const { items } = await client.search(s.id, v, {
            kinds: ['place', 'thing'],
            includeNotes: false,
          });
          for (const it of items ?? []) {
            if (!namesMatch(it.title, item)) continue;
            const where = (it.details ?? '').trim();
            if (where) add({ name: where, source: 'memory' });
          }
        } catch {
          /* a failing space must not kill the plan */
        }
      }
    }),
  );

  // 2. open borrows involving the item
  await Promise.all(
    spaces.map(async (s) => {
      try {
        const borrows = await client.listBorrows(s.id);
        for (const b of borrows ?? []) {
          if (namesMatch(b.item_title, item)) {
            add({ name: b.borrower, source: 'borrow', detail: b.lent_at });
          }
        }
      } catch {
        /* best effort */
      }
    }),
  );

  // 3. heuristic suspects for the item type (or generic fallback)
  const ar = getLang() === 'ar';
  const hit = SUSPECTS.find((s) => s.re.test(item));
  const suspects = hit ? (ar ? hit.ar : hit.en) : ar ? GENERIC_AR : GENERIC_EN;
  for (const name of suspects) add({ name, source: 'suspect' });

  return { item, places };
}

// ── session ─────────────────────────────────────────────────────────

export function startSession(plan: SearchPlan): SearchSession {
  return { item: plan.item, places: plan.places, checked: [], awaitingPlace: false };
}

export function remainingPlaces(s: SearchSession): PlanPlace[] {
  return s.places.filter((p) => !s.checked.includes(stripAl(p.name).toLowerCase()));
}

/** Mark a place checked (fuzzy name match) → the matched plan place or null. */
export function checkPlace(s: SearchSession, placeName: string): PlanPlace | null {
  const hit = remainingPlaces(s).find((p) => namesMatch(p.name, placeName));
  if (!hit) return null;
  s.checked.push(stripAl(hit.name).toLowerCase());
  return hit;
}

// ── formatting ──────────────────────────────────────────────────────

function sourceIcon(source: PlanPlace['source']): string {
  return source === 'memory' ? '📍' : source === 'borrow' ? '🤝' : '🕵️';
}

function describePlace(p: PlanPlace): string {
  if (p.source === 'memory') return tx('detectiveKnownPlace', { place: p.name });
  if (p.source === 'borrow') {
    const date = p.detail ? new Date(p.detail).toLocaleDateString(getLang() === 'ar' ? 'ar-EG' : 'en-US') : '';
    return tx('detectiveBorrowPlace', { name: p.name, date });
  }
  return p.name;
}

/** The full plan message sent when a search starts. */
export function formatSearchPlan(plan: SearchPlan): string {
  const lines = plan.places.map((p, i) => `${i + 1}. ${sourceIcon(p.source)} ${describePlace(p)}`);
  const head = tx('detectivePlanTitle', { item: plan.item });
  const borrow = plan.places.find((p) => p.source === 'borrow');
  const hint = borrow
    ? tx('detectiveHintBorrow', { name: borrow.name, item: plan.item })
    : t('detectiveHint');
  return `${head}\n${lines.join('\n')}\n\n${hint}`;
}

/** After "شطبت X": confirmation + what's left + the next suggestion. */
export function formatChecked(s: SearchSession, hit: PlanPlace): string {
  const rest = remainingPlaces(s);
  const done = tx('detectiveChecked', { place: hit.name });
  if (rest.length === 0) return `${done}\n\n${t('detectiveAllChecked')}`;
  const next = rest[0];
  const restList = rest.map((p) => `${sourceIcon(p.source)} ${describePlace(p)}`).join('\n');
  return `${done}\n\n${tx('detectiveRemaining', { n: String(rest.length), places: `\n${restList}` })}\n\n${tx('detectiveNext', { place: describePlace(next) })}`;
}

export function formatFoundAsk(): string {
  return t('detectiveFoundAsk');
}

export function formatPlaceSaved(item: string, place: string): string {
  return tx('detectivePlaceSaved', { item, place });
}

// ── 🕰️ Item timeline engine ("وين كان المفك؟") ───────────────────────
// Every sighting of a thing already lives somewhere: place/thing items
// ("المفك في درج المطبخ"), borrows ("مع أحمد"), watches ("أُخذ على
// الكراج"). The timeline unions them into one chronological story —
// the memory behind "أوراقنا المهمة الي دايماً ضايعة".
//
// REUSABLE BY DESIGN: no React, no UI imports — pure intent detection,
// data shaping and formatting. Nothing here touches storage except
// through the structural TimelineClient.

import type { Borrow, Item } from '@mawjood/voice-engine';
import { getLang, t, tx } from './i18n';

/** Minimal client surface the timeline needs — structural typing. */
export interface TimelineClient {
  listSpaces(): Promise<{ id: string }[]>;
  search(
    spaceId: string,
    query: string,
    opts: { kinds?: string[]; includeNotes?: boolean },
  ): Promise<{ items: Item[] }>;
  listBorrows(spaceId: string): Promise<Borrow[]>;
  listWatches(spaceId: string): Promise<Item[]>;
}

export interface TimelineEvent {
  at: string; // ISO timestamp
  icon: string;
  text: string; // human line without the date
}

// ── intent detection ────────────────────────────────────────────────

function cleanCapture(s: string): string {
  return s
    .trim()
    .replace(/^(my|the)\s+/i, '')
    .replace(/[؟?!.,،:؛]+$/g, '')
    .trim();
}

const AR_TL: RegExp[] = [
  /وين\s+كان\s+(.+)/, // وين كان المفك؟
  /(.+)\s+وين\s+كان\??$/, // المفك وين كان
  /تاريخ\s+(.+)/, // تاريخ المفك (history, not the date)
];

const EN_TL: RegExp[] = [
  /where\s+has\s+(?:the\s+|my\s+)?(.+?)\s+been/i,
  /history\s+of\s+(?:the\s+|my\s+)?(.+)/i,
];

/** "وين كان المفك؟" → the item name, else null. */
export function parseTimelineQuery(text: string): string | null {
  const clean = text.trim();
  for (const re of [...AR_TL, ...EN_TL]) {
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

/** Union every sighting of the item across spaces, newest first. */
export async function getItemTimeline(
  client: TimelineClient,
  item: string,
): Promise<TimelineEvent[]> {
  const spaces = await client.listSpaces().catch(() => []);
  const events: TimelineEvent[] = [];
  const variants = queryVariants(item);

  await Promise.all(
    spaces.map(async (s) => {
      // place/thing sightings
      for (const v of variants) {
        try {
          const { items } = await client.search(s.id, v, {
            kinds: ['place', 'thing'],
            includeNotes: false,
          });
          for (const it of items ?? []) {
            if (!namesMatch(it.title, item)) continue;
            const where = (it.details ?? '').trim();
            events.push({
              at: it.created_at,
              icon: '📍',
              text: where || t('timelineRecorded'),
            });
          }
        } catch {
          /* best effort */
        }
      }
      // borrows
      try {
        for (const b of (await client.listBorrows(s.id)) ?? []) {
          if (!namesMatch(b.item_title, item)) continue;
          events.push({ at: b.lent_at, icon: '🤝', text: tx('timelineLent', { name: b.borrower }) });
          if (b.returned_at) {
            events.push({
              at: b.returned_at,
              icon: '↩️',
              text: tx('timelineReturned', { name: b.borrower }),
            });
          }
        }
      } catch {
        /* best effort */
      }
      // prevention watches
      try {
        for (const w of (await client.listWatches(s.id)) ?? []) {
          if (!namesMatch(w.title, item)) continue;
          const to = w.meta?.taken_to;
          events.push({
            at: w.created_at,
            icon: '🛡️',
            text: to ? tx('timelineTakenTo', { place: to }) : t('timelineWatched'),
          });
        }
      } catch {
        /* best effort */
      }
    }),
  );

  const sorted = events.sort((a, b) => b.at.localeCompare(a.at));
  // variant searches can return the same row twice — collapse identical events
  const seen = new Set<string>();
  return sorted
    .filter((e) => {
      const key = `${e.at}|${e.icon}|${e.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

// ── formatting ──────────────────────────────────────────────────────

function relDay(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(d)) / 864e5);
  if (days <= 0) return t('today');
  if (days === 1) return t('yesterday');
  return d.toLocaleDateString(getLang() === 'ar' ? 'ar-EG' : 'en-US', {
    day: 'numeric',
    month: 'numeric',
  });
}

/** "🕰️ خط زمني للمفك:\n• اليوم: 🛡️ أُخذ على الكراج\n…" */
export function formatTimeline(item: string, events: TimelineEvent[]): string {
  if (events.length === 0) return tx('timelineNone', { item });
  const head = tx('timelineTitle', { item });
  const shown = events.slice(0, 10);
  const lines = shown.map((e) => `• ${relDay(e.at)}: ${e.icon} ${e.text}`);
  const more =
    events.length > shown.length ? `\n${tx('timelineMore', { n: String(events.length - shown.length) })}` : '';
  return `${head}\n${lines.join('\n')}${more}`;
}

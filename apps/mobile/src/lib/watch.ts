// ── 🛡️ Prevention engine ("أخذت المفك على الكراج" → "رجّعته لمكانه؟") ─
// Taking something somewhere creates a 'watch' item due in WATCH_HOURS;
// the server cron (migration 0022) then asks the whole space
// "رجّع المفك لمكانه؟". Replies resolve it in chat:
//   "رجعته" → done · "لسا" → snoozed +WATCH_HOURS (re-arms the reminder).
// The item's usual place (habit learning) is stored on the watch so the
// reminder can say "لمكانه (عادةً: درج المطبخ)".
//
// REUSABLE BY DESIGN: no React, no UI imports — pure intent detection,
// data shaping and formatting. Nothing here touches storage except
// through the structural WatchClient.

import type { Item } from '@mawjood/voice-engine';
import { getLang, t, tx } from './i18n';
import { getPlaceHabits, type HabitClient } from './habits';

/** Hours until the "did you put it back?" nudge (and each snooze). */
export const WATCH_HOURS = 4;

/** Minimal client surface prevention needs — structural typing. */
export interface WatchClient extends HabitClient {
  listWatches(spaceId: string): Promise<Item[]>;
  createItem(input: {
    spaceId: string;
    kind: 'watch';
    title: string;
    details?: string | null;
    dueAt?: string | null;
    userId?: string;
    meta?: Item['meta'];
  }): Promise<Item>;
  resolveWatch(itemId: string): Promise<Item>;
  setItemDueAt(itemId: string, dueAt: string | null): Promise<Item>;
}

// ── intent detection ────────────────────────────────────────────────

function cleanCapture(s: string): string {
  return s.trim().replace(/[؟?!.,،:؛]+$/g, '').trim();
}

const AR_TAKE: RegExp[] = [
  /(?:رح|راح)\s+[أاآ]خذ\s+(.+?)\s+(?:على|إلى|الى)\s+(.+)/, // رح آخذ المفك على الكراج
  /[أا]خذت\s+(.+?)\s+(?:على|إلى|الى|لـ|ل)\s+(.+)/, // أخذت المفك على الكراج
];

const EN_TAKE: RegExp[] = [
  /(?:took|taking|bringing|take|grabbing)\s+(?:the\s+|my\s+)?(.+?)\s+to\s+(?:the\s+)?(.+)/i,
];

/** "أخذت المفك على الكراج" → { item, place }, else null. */
export function parseTakeTo(text: string): { item: string; place: string } | null {
  const clean = text.trim();
  for (const re of [...AR_TAKE, ...EN_TAKE]) {
    const m = clean.match(re);
    if (m?.[1] && m?.[2]) {
      const item = cleanCapture(m[1]);
      const place = cleanCapture(m[2]);
      if (item.length > 0 && item.length <= 40 && place.length > 0 && place.length <= 40) {
        return { item, place };
      }
    }
  }
  return null;
}

export interface WatchReply {
  action: 'done' | 'snooze';
  /** the item name, when the reply names it ("رجعت المفك") */
  item?: string;
}

const AR_DONE: RegExp[] = [
  /^(?:اه|أيوه|ايوه|نعم)\s+رجعته?$/, // اه رجعته
  /^رجعته?$/, // رجعته / رجعت
  /^رجعتها$/,
  /^رجعت\s+(.+)/, // رجعت المفك
  /^(?:اه|أيوه|ايوه|نعم|yes)\s*$/, // bare affirmation — needs an open watch
];

const AR_SNOOZE: RegExp[] = [
  /^(لسا|لسه|بعد|بعدني|ذكرني بعدين)\s*$/,
  /^not yet\s*$/,
  /^remind me later\s*$/i,
];

const EN_DONE: RegExp[] = [
  /^(i )?(put it back|returned it|i returned it)\s*$/i,
  /^yes,? (i )?(put it back|returned it)\s*$/i,
];

/** "رجعته" → done · "لسا" → snooze · else null. */
export function parseWatchReply(text: string): WatchReply | null {
  const clean = text.trim();
  for (const re of AR_DONE) {
    const m = clean.match(re);
    if (m) return m[1] ? { action: 'done', item: cleanCapture(m[1]) } : { action: 'done' };
  }
  for (const re of EN_DONE) {
    if (re.test(clean)) return { action: 'done' };
  }
  for (const re of AR_SNOOZE) {
    if (re.test(clean)) return { action: 'snooze' };
  }
  return null;
}

// ── watches ─────────────────────────────────────────────────────────

function stripAl(s: string): string {
  return s.trim().replace(/^ال/, '');
}

function namesMatch(a: string, b: string): boolean {
  const x = stripAl(a).toLowerCase();
  const y = stripAl(b).toLowerCase();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/** Open watches across every space, soonest due first. */
export async function listOpenWatches(client: WatchClient): Promise<Item[]> {
  const spaces = await client.listSpaces().catch(() => []);
  const all: Item[] = [];
  await Promise.all(
    spaces.map(async (s) => {
      try {
        all.push(...(await client.listWatches(s.id)));
      } catch {
        /* best effort */
      }
    }),
  );
  return all.filter((w) => w.status === 'open');
}

/**
 * Match a reply to a watch: named → by name; unnamed + exactly one → it;
 * unnamed + several → 'ambiguous'; none → null.
 */
export function resolveWatchReply(
  watches: Item[],
  reply: WatchReply,
): Item | 'ambiguous' | null {
  const open = watches.filter((w) => w.status === 'open');
  if (open.length === 0) return null;
  if (reply.item) {
    return open.find((w) => namesMatch(w.title, reply.item!)) ?? null;
  }
  if (open.length === 1) return open[0];
  return 'ambiguous';
}

export interface CreatedWatch {
  watch: Item;
  homePlace: string | null;
}

/** Create the watch; the usual place (habits) rides along in meta. */
export async function createWatch(
  client: WatchClient,
  input: { spaceId: string; userId: string; item: string; place: string },
): Promise<CreatedWatch> {
  const habits = await getPlaceHabits(client, input.item).catch(() => []);
  const homePlace = habits[0]?.place ?? null;
  const dueAt = new Date(Date.now() + WATCH_HOURS * 3600e3).toISOString();
  const ar = getLang() === 'ar';
  const watch = await client.createItem({
    spaceId: input.spaceId,
    kind: 'watch',
    title: input.item,
    details: ar ? `أخذه على ${input.place}` : `took it to ${input.place}`,
    dueAt,
    userId: input.userId,
    meta: { taken_to: input.place, home_place: homePlace },
  });
  return { watch, homePlace };
}

/** Snooze: push the due date WATCH_HOURS out (re-arms the reminder). */
export function snoozeDueAt(): string {
  return new Date(Date.now() + WATCH_HOURS * 3600e3).toISOString();
}

// ── formatting ──────────────────────────────────────────────────────

export function formatWatchCreated(item: string, homePlace: string | null): string {
  const home = homePlace ? tx('watchHomeKnown', { place: homePlace }) : t('watchHomeDefault');
  return tx('watchCreated', { item, home });
}

export function formatWatchDone(item: string): string {
  return tx('watchDone', { item });
}

export function formatWatchSnoozed(item: string): string {
  return tx('watchSnoozed', { item });
}

export function formatWatchWhich(watches: Item[]): string {
  const list = watches
    .filter((w) => w.status === 'open')
    .map((w) => w.title)
    .join('، ');
  return tx('watchWhich', { list });
}

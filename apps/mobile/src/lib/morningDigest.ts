// ── ☀️ Morning digest engine ─────────────────────────────────────────
// "شو عندي اليوم؟" → today's appointments + due/overdue tasks +
// open shopping lists + open borrows, in one formatted chat message.
//
// REUSABLE BY DESIGN: no React, no UI imports — pure intent detection,
// data shaping and formatting. Any caller can run:
//   isDigestRequest(text) → fetchDigestData(client) → formatDigest(data)
// Pull this file into anything: chat interception, a future morning-push
// cron, a widget, a server edge function (pair with a server client).
// The client surface is structural (DigestClient), so any compatible
// client works — mobile VoiceEngine today, something else tomorrow.

import type { Borrow, Item, ShoppingList } from '@mawjood/voice-engine';
import { getLang, t, tx } from './i18n';

/** Minimal client surface the digest needs — structural typing. */
export interface DigestClient {
  listSpaces(): Promise<{ id: string }[]>;
  listTasks(spaceId: string): Promise<Item[]>;
  listUpcoming(spaceId: string): Promise<Item[]>;
  listShoppingLists(spaceId: string): Promise<ShoppingList[]>;
  listBorrows(spaceId: string): Promise<Borrow[]>;
}

export interface DigestListLine {
  title: string;
  openCount: number;
}

export interface DigestData {
  builtAt: Date;
  /** open appointments due today (or already overdue) */
  appointmentsToday: Item[];
  overdueTasks: Item[];
  dueTodayTasks: Item[];
  openLists: DigestListLine[];
  openBorrows: Borrow[];
}

// ── intent detection ────────────────────────────────────────────────

const AR_PATTERNS = [
  'شو عندي اليوم',
  'شو عندي لليوم',
  'ايش عندي اليوم',
  'وش عندي اليوم',
  'شو في عندي اليوم',
  'ملخص اليوم',
  'ملخص الصباح',
  'ملخص صباحي',
  'برنامج اليوم',
  'جدول اليوم',
  'جدولي اليوم',
  'مهامي اليوم',
  'مواعيدي اليوم',
];

const EN_PATTERNS = [
  'morning digest',
  'morning summary',
  'morning briefing',
  'daily digest',
  'daily briefing',
  "what's on today",
  'what is on today',
  'what do i have today',
  "what's today",
  'show my day',
  'my schedule today',
  'today overview',
];

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[؟?!.،,؛:«»""]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** true when the user is asking for their morning/day digest. */
export function isDigestRequest(raw: string): boolean {
  const norm = normalize(raw);
  if (!norm) return false;
  return (
    AR_PATTERNS.some((p) => norm.includes(p)) ||
    EN_PATTERNS.some((p) => norm.includes(p))
  );
}

// ── data shaping ────────────────────────────────────────────────────

function dayStart(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

function dayEnd(d: Date): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

export async function fetchDigestData(
  client: DigestClient,
  now: Date = new Date(),
): Promise<DigestData> {
  const spaces = await client.listSpaces().catch((): { id: string }[] => []);
  const ids = spaces.map((s) => s.id);
  const [tasksBySpace, apptsBySpace, listsBySpace, borrowsBySpace] =
    await Promise.all([
      Promise.all(ids.map((id) => client.listTasks(id).catch((): Item[] => []))),
      Promise.all(ids.map((id) => client.listUpcoming(id).catch((): Item[] => []))),
      Promise.all(
        ids.map((id) => client.listShoppingLists(id).catch((): ShoppingList[] => [])),
      ),
      Promise.all(ids.map((id) => client.listBorrows(id).catch((): Borrow[] => []))),
    ]);

  const start = dayStart(now);
  const end = dayEnd(now);
  const byDueAsc = (a: Item, b: Item) =>
    String(a.due_at ?? '').localeCompare(String(b.due_at ?? ''));
  const dueDate = (it: Item) => new Date(String(it.due_at));

  const openTasks = tasksBySpace
    .flat()
    .filter((it) => it.status === 'open' && it.due_at);
  const overdueTasks = openTasks
    .filter((it) => dueDate(it) < start)
    .sort(byDueAsc);
  const dueTodayTasks = openTasks
    .filter((it) => {
      const d = dueDate(it);
      return d >= start && d <= end;
    })
    .sort(byDueAsc);

  const appointmentsToday = apptsBySpace
    .flat()
    .filter((it) => it.status === 'open' && it.due_at && dueDate(it) <= end)
    .sort(byDueAsc);

  const openLists: DigestListLine[] = listsBySpace
    .flat()
    .filter((l) => l.status === 'open')
    .map((l) => ({
      title: l.title,
      openCount: l.items.filter((i) => i.status === 'open').length,
    }))
    .filter((l) => l.openCount > 0);

  const openBorrows = borrowsBySpace
    .flat()
    .sort((a, b) => String(a.lent_at ?? '').localeCompare(String(b.lent_at ?? '')));

  return {
    builtAt: now,
    appointmentsToday,
    overdueTasks,
    dueTodayTasks,
    openLists,
    openBorrows,
  };
}

// ── formatting (follows the current UI language) ────────────────────

function locale(): string {
  return getLang() === 'ar' ? 'ar' : 'en-US';
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale(), {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function dateOf(iso: string): string {
  return new Date(iso).toLocaleDateString(locale(), {
    day: 'numeric',
    month: 'long',
  });
}

function taskLine(it: Item): string {
  const who = it.assigned_to ? ` — 👤 ${it.assigned_to}` : '';
  return `• ${it.title}${who}`;
}

/** One formatted chat message. Empty sections are skipped; when there is
 *  nothing at all, a friendly "clear day" message is returned. */
export function formatDigest(d: DigestData): string {
  const lines: string[] = [];
  const dateStr = d.builtAt.toLocaleDateString(locale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  lines.push(tx('digestTitle', { date: dateStr }));

  const hasAny =
    d.appointmentsToday.length +
      d.overdueTasks.length +
      d.dueTodayTasks.length +
      d.openLists.length +
      d.openBorrows.length >
    0;
  if (!hasAny) {
    lines.push('', t('digestEmpty'));
    return lines.join('\n');
  }

  if (d.appointmentsToday.length > 0) {
    const start = dayStart(d.builtAt);
    lines.push('', t('digestAppointments'));
    for (const a of d.appointmentsToday) {
      const overdue = new Date(String(a.due_at)) < start;
      lines.push(
        `• ${timeOf(String(a.due_at))} — ${a.title}${overdue ? ` ${t('digestOverdueTag')}` : ''}`,
      );
    }
  }

  if (d.overdueTasks.length > 0) {
    lines.push('', t('digestTasksOverdue'));
    for (const it of d.overdueTasks) {
      lines.push(`${taskLine(it)} (${dateOf(String(it.due_at))})`);
    }
  }

  if (d.dueTodayTasks.length > 0) {
    lines.push('', t('digestTasksToday'));
    for (const it of d.dueTodayTasks) lines.push(taskLine(it));
  }

  if (d.openLists.length > 0) {
    lines.push('', t('digestShopping'));
    for (const l of d.openLists) {
      lines.push(`• ${l.title} — ${tx('digestItemsCount', { n: l.openCount })}`);
    }
  }

  if (d.openBorrows.length > 0) {
    lines.push('', t('digestBorrows'));
    for (const b of d.openBorrows) {
      const due = b.due_at ? ` — ${tx('digestBorrowDue', { date: dateOf(b.due_at) })}` : '';
      lines.push(`• ${b.item_title} — 🤝 ${b.borrower}${due}`);
    }
  }

  return lines.join('\n');
}

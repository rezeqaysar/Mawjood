// ── 💰 Household-expenses engine ("مصاريف البيت") ──────────────────────────
// UI-free, reusable module (user rule: build as an engine so the code can be
// pulled for reuse tomorrow — e.g. a monthly budget report or a widget).
//
// What it does:
//   * parseExpenseRecord("صرفت 40 على الخضرة") → { amount, title }
//   * parseExpenseQuery("قديش صرفنا هالشهر؟") → { period, filter? }
//   * recordExpense(...) → stores an items row with kind='expense'
//     (meta = { amount, paid_by })
//   * summarizeExpenses(...) → pure totals: per-person + top items
//   * formatExpenseSummary(...) → chat-ready message (UI language)
//
// Storage note: kind='expense' requires migration 0021 (CHECK constraint).
// Until it is applied, recordExpense throws and callers fall back to the agent.

import type { Item, ItemKind } from '@mawjood/voice-engine';
import { getLang, t, tx } from './i18n';

/** Minimal surface this engine needs — structurally satisfied by VoiceEngine. */
export interface ExpenseClient {
  listSpaces(): Promise<{ id: string }[]>;
  listExpenses(spaceId: string, limit?: number): Promise<Item[]>;
  createItem(input: {
    spaceId: string;
    kind: ItemKind;
    title: string;
    details?: string | null;
    userId?: string;
    meta?: { amount?: number | null; paid_by?: string | null } | null;
  }): Promise<Item>;
}

// ── parsing ────────────────────────────────────────────────────────────────

const EASTERN = '٠١٢٣٤٥٦٧٨٩';

function toWestern(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String(EASTERN.indexOf(d)));
}

/** "40" / "٤٠" / "1,000" / "40.5" → number, else null. */
export function parseAmount(raw: string): number | null {
  const w = toWestern(raw).replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$/.test(w)) return null;
  const n = parseFloat(w);
  return Number.isFinite(n) && n > 0 && n < 1e9 ? n : null;
}

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[؟?!.،,؛:«»"""]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ExpenseRecord {
  amount: number;
  title: string;
}

/**
 * Detect a spend command: "صرفت 40 على الخضرة" / "دفعت 25 بنزين" /
 * "spent 40 on groceries" / "paid 25 for gas".
 * "اشتريت X بـ40" is intentionally NOT matched — purchases keep flowing
 * through the 📦 things pipeline (which already records prices).
 */
export function parseExpenseRecord(raw: string): ExpenseRecord | null {
  const text = normalize(raw);
  // Arabic: verb amount [currency] [على] title
  let m = text.match(
    /^(صرفت|صرفنا|دفعت|دفعنا)\s+([٠-٩\d.,]+)\s*(دولار|دولارات|\$|شيكل|يورو|ليرة)?\s*(.+)?$/,
  );
  if (m) {
    const amount = parseAmount(m[2]);
    const title = (m[4] ?? '').replace(/^(على|ع|في|ل|لل)\s+/, '').trim();
    if (amount !== null && title) return { amount, title };
    return null;
  }
  // English: spent|paid amount [on|for] title
  m = text.match(/^(spent|paid)\s+\$?([\d.,]+)\s+(?:on|for\s+)?(.+)$/);
  if (m) {
    const amount = parseAmount(m[2]);
    const title = m[3].trim();
    if (amount !== null && title) return { amount, title };
  }
  return null;
}

export type ExpensePeriod = 'day' | 'week' | 'month';

export interface ExpenseQuery {
  period: ExpensePeriod;
  filter?: string;
}

/**
 * Detect a spending question: "قديش صرفنا هالشهر؟" / "مصاريف اليوم" /
 * "قديش صرفنا على الخضرة" / "how much did we spend this week".
 * No explicit period → this month.
 */
export function parseExpenseQuery(raw: string): ExpenseQuery | null {
  const text = normalize(raw);
  const has = (...words: string[]) => words.some((w) => text.includes(w));
  const isQ = has(
    'قديش صرفنا',
    'قديش صرفت',
    'كم صرفنا',
    'كم صرفت',
    'شو صرفنا',
    'مصاريف',
    'مصروف',
    'how much did we spend',
    'how much did i spend',
    'spending this',
    'expenses',
  );
  if (!isQ) return null;

  let period: ExpensePeriod = 'month';
  if (has('اليوم', 'today')) period = 'day';
  else if (has('هالأسبوع', 'هالاسبوع', 'الأسبوع', 'الاسبوع', 'this week')) period = 'week';

  // optional "على الخضرة" / "on groceries" filter
  let filter: string | undefined;
  const fm = text.match(/(?:^|\s)(?:على|ع|on)\s+(.+)$/);
  if (fm) {
    filter = fm[1]
      .replace(
        /\s+(اليوم|هالشهر|هالاسبوع|هالأسبوع|الأسبوع|الاسبوع|الشهر|today|this week|this month)\s*$/,
        '',
      )
      .trim();
    if (!filter) filter = undefined;
  }
  return { period, filter };
}

// ── recording ──────────────────────────────────────────────────────────────

export interface RecordExpenseInput {
  spaceId: string;
  userId?: string;
  title: string;
  details?: string | null;
  amount: number;
  paidBy?: string | null;
}

/** Persist one expense. Throws (→ caller falls back to the agent) if
 *  migration 0021 hasn't been applied yet (kind CHECK constraint). */
export async function recordExpense(
  client: ExpenseClient,
  input: RecordExpenseInput,
): Promise<Item> {
  return client.createItem({
    spaceId: input.spaceId,
    kind: 'expense' as ItemKind,
    title: input.title,
    details: input.details ?? null,
    userId: input.userId,
    meta: { amount: input.amount, paid_by: input.paidBy ?? null },
  });
}

// ── summarizing (pure) ─────────────────────────────────────────────────────

export interface ExpenseSummary {
  period: ExpensePeriod;
  periodLabel: string;
  total: number;
  count: number;
  byPerson: { name: string; total: number }[];
  topItems: { title: string; total: number }[];
  filter?: string;
}

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

/** day → today; week → Saturday..today (matches the app's Saturday-start
 *  week); month → 1st..today. */
export function periodRange(period: ExpensePeriod, now = new Date()): {
  start: Date;
  end: Date;
} {
  const end = new Date(now);
  if (period === 'day') return { start: startOfDay(now), end };
  if (period === 'week') {
    const start = startOfDay(now);
    // Saturday start: (getDay()+1) % 7 → days since Saturday
    start.setDate(start.getDate() - ((start.getDay() + 1) % 7));
    return { start, end };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { start, end };
}

const amountOf = (it: Item): number =>
  typeof it.meta?.amount === 'number' && Number.isFinite(it.meta.amount)
    ? it.meta.amount
    : 0;

export function periodLabel(period: ExpensePeriod, now = new Date()): string {
  if (period === 'day') return t('expensePeriodDay');
  if (period === 'week') return t('expensePeriodWeek');
  const lang = getLang();
  try {
    return now.toLocaleDateString(lang === 'ar' ? 'ar' : 'en-US', { month: 'long' });
  } catch {
    return t('expensePeriodMonth');
  }
}

export function summarizeExpenses(
  items: Item[],
  q: ExpenseQuery,
  now = new Date(),
): ExpenseSummary {
  const { start, end } = periodRange(q.period, now);
  const inRange = items.filter((it) => {
    if (it.kind !== 'expense') return false;
    const c = new Date(it.created_at);
    return c >= start && c <= end;
  });
  const scoped = q.filter
    ? inRange.filter((it) =>
        `${it.title} ${it.details ?? ''}`
          .toLowerCase()
          .includes(q.filter!.toLowerCase()),
      )
    : inRange;

  const total = scoped.reduce((s, it) => s + amountOf(it), 0);

  const byPersonMap = new Map<string, number>();
  for (const it of scoped) {
    const name = it.meta?.paid_by?.trim() || t('expenseUnknown');
    byPersonMap.set(name, (byPersonMap.get(name) ?? 0) + amountOf(it));
  }
  const byPerson = [...byPersonMap.entries()]
    .map(([name, t2]) => ({ name, total: t2 }))
    .sort((a, b) => b.total - a.total);

  const byTitle = new Map<string, number>();
  for (const it of scoped) byTitle.set(it.title, (byTitle.get(it.title) ?? 0) + amountOf(it));
  const topItems = [...byTitle.entries()]
    .map(([title, t2]) => ({ title, total: t2 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  return {
    period: q.period,
    periodLabel: periodLabel(q.period, now),
    total,
    count: scoped.length,
    byPerson,
    topItems,
    filter: q.filter,
  };
}

// ── formatting ─────────────────────────────────────────────────────────────

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** "$40" in EN, "40$" in AR (reads better in RTL bubbles). */
export function money(n: number): string {
  const s = trimNum(n);
  return getLang() === 'ar' ? `${s}$` : `$${s}`;
}

export function formatExpenseRecorded(rec: ExpenseRecord): string {
  return tx('expenseRecorded', { title: rec.title, amount: money(rec.amount) });
}

export function formatExpenseSummary(s: ExpenseSummary): string {
  const lines: string[] = [];
  if (s.filter) {
    lines.push(tx('expenseFilterTitle', { filter: s.filter, period: s.periodLabel }));
  } else {
    lines.push(tx('expenseSummaryTitle', { period: s.periodLabel }));
  }
  if (s.count === 0) {
    lines.push('', t('expenseNoData'));
    return lines.join('\n');
  }
  lines.push(tx('expenseTotal', { amount: money(s.total), n: s.count }));
  if (s.byPerson.length > 1) {
    for (const p of s.byPerson) lines.push(`• ${p.name}: ${money(p.total)}`);
  }
  if (!s.filter && s.topItems.length > 1) {
    lines.push('', t('expenseTop'));
    for (const it of s.topItems) lines.push(`• ${it.title}: ${money(it.total)}`);
  }
  return lines.join('\n');
}

/** Fetch expenses across spaces (each space fails independently). */
export async function fetchAllExpenses(
  client: ExpenseClient,
  spaces: { id: string }[],
): Promise<Item[]> {
  const per = await Promise.all(
    spaces.map((s) => client.listExpenses(s.id).catch((): Item[] => [])),
  );
  return per.flat();
}

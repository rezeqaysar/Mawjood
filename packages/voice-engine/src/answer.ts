import type { Item, Note } from './types';

// Local (on-device, no-AI) question answerer.
// Used as a demo fallback while the AI `ask` function has no OpenAI credits.
// Answers are keyword-based and ALWAYS cite their source note.

export interface AnswerSource {
  note_id: string;
  snippet: string;
}

export interface LocalAnswer {
  answer: string;
  sources: AnswerSource[];
  demo: true;
  /** the item this answer is based on (for follow-up corrections) */
  item?: Item;
}

// ── unified input: question vs statement detection ─────────────

// NOTE: \b doesn't work with Arabic letters in JS (they're non-\w),
// so boundaries are written explicitly as (^|\s) / (\s|$).
const QUESTION_START =
  /^(وين|فين|اين|متى|متي|امتى|امتي|شو|ايش|اشنو|شنو|ماذا|مذا|كم|كيف|ليش|لماذا|هل|مين|من)(\s|$)/;
const QUESTION_END =
  /(^|\s)(وين|فين|اين|متى|متي|امتى|شو|ايش|ماذا|كم|كيف|ليش|لماذا)\s*[؟?]?$/;

/** Is this input a question (→ answer) or a statement (→ save as note)? */
export function isQuestion(text: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (/[؟?]/.test(t)) return true;
  const n = normalizeAr(t);
  return QUESTION_START.test(n) || QUESTION_END.test(n);
}

// ── conversational correction: "لا، نقلته على الخزانة" ──────────

const CORRECTION_STRIP = new Set(
  'لا بس بل انا نقلته نقلتها نقلت حطيته حطيتها حطيت وديته وديتها صار صارت موجود موجوده هلا هلق اسا على علي ع الي اللي'.split(' '),
);

/**
 * If the text is a correction ("لا، نقلته على الخزانة"), extract the new
 * place/value. Returns null when it's not a correction.
 */
export function extractCorrectionPlace(text: string): string | null {
  const n = normalizeAr((text || '').trim());
  if (!/^(لا|بس|بل)(\s|$)/.test(n)) return null;
  const words = n
    .split(/[\s,؛;:.!?؟"“”'()]+/)
    .filter((w) => w.length > 1 && !CORRECTION_STRIP.has(w));
  if (words.length === 0) return null;
  return words.join(' ');
}

export function isCorrection(text: string): boolean {
  return extractCorrectionPlace(text) !== null;
}

/** Unify Arabic letter variants + strip diacritics so matching is forgiving. */
export function normalizeAr(s: string): string {
  return (s || '')
    .replace(/[ً-ٰٟ]/g, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase();
}

const QUESTION_WORDS = new Set(
  'وين فين اين متى متي امتى شو ايش اشنو شنو ماذا مذا كم كيف ليش لماذا هل ما ماهو من مين و شو هو هي هاد هاي هذا هذه ذي الي اللي في على عن عند مع كان كانت يكون بدي بدك بدنا لو سمحت من فضلك ؟'.split(
    ' ',
  ),
);

function keywords(q: string): string[] {
  return normalizeAr(q)
    .split(/[\s,؛;:.!?؟"“”'()\[\]]+/)
    .filter((w) => w.length > 1 && !QUESTION_WORDS.has(w));
}

type Intent = 'where' | 'when' | 'spec' | 'opinion' | 'checklist' | 'general';

function detectIntent(q: string): Intent {
  const n = normalizeAr(q);
  if (/وين|فين|اين/.test(n)) return 'where';
  if (/مقاس|قياس|size|موديل|مودل|رقم/.test(n)) return 'spec';
  if (/متي|متى|امتي|امتى|when/.test(n)) return 'when';
  if (/عجب|جرب|راي|رأي/.test(n)) return 'opinion';
  if (/سفر|رحله|رحلة/.test(n)) return 'checklist';
  return 'general';
}

function itemText(it: Item): string {
  return normalizeAr(`${it.title} ${it.details ?? ''}`);
}

function noteText(n: Note): string {
  return normalizeAr(n.transcript ?? '');
}

function score(text: string, kws: string[]): number {
  let s = 0;
  for (const k of kws) {
    if (text.includes(k)) s += k.length > 4 ? 3 : 2;
  }
  return s;
}

function snippet(n: Note): string {
  const t = (n.transcript ?? '').trim();
  return t.length > 90 ? t.slice(0, 90) + '…' : t;
}

function fmtDate(d: string | null): string {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return d;
  }
}

/**
 * Answer a question from notes + items using keyword overlap.
 * Returns null when nothing relevant is found.
 */
export function answerLocally(
  question: string,
  notes: Note[],
  items: Item[],
): LocalAnswer | null {
  const kws = keywords(question);
  if (kws.length === 0) return null;
  const intent = detectIntent(question);
  const noteById = new Map(notes.map((n) => [n.id, n]));

  const src = (it: Item): AnswerSource => ({
    note_id: it.note_id ?? '',
    snippet: it.note_id && noteById.get(it.note_id)
      ? snippet(noteById.get(it.note_id)!)
      : it.title,
  });

  const rankedItems = items
    .map((it) => ({ it, s: score(itemText(it), kws) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s);
  const rankedNotes = notes
    .map((n) => ({ n, s: score(noteText(n), kws) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s);

  // ── where: "وين حطيت جواز السفر؟" ──
  if (intent === 'where') {
    const place = rankedItems.find((r) => r.it.kind === 'place');
    if (place) {
      const { it } = place;
      return {
        answer: `📍 ${it.title}: ${it.details || 'مسجّل بدون تفاصيل مكان'}`,
        sources: [src(it)],
        demo: true,
        item: it,
      };
    }
  }

  // ── spec: "شو مقاس الفلتر تبعي؟" ──
  if (intent === 'spec') {
    const spec = rankedItems.find((r) => r.it.kind === 'spec');
    if (spec) {
      const { it } = spec;
      return {
        answer: `📏 ${it.title}: ${it.details || ''}`.trim(),
        sources: [src(it)],
        demo: true,
        item: it,
      };
    }
  }

  // ── when: "آخر مرة اشتريت فلتر المكيف متى؟" ──
  if (intent === 'when') {
    const dated = rankedItems.find((r) => r.it.due_at);
    if (dated) {
      const { it } = dated;
      return {
        answer: `${it.title} — بتاريخ ${fmtDate(it.due_at)}`,
        sources: [src(it)],
        demo: true,
      };
    }
    if (rankedNotes[0]) {
      const { n } = rankedNotes[0];
      return {
        answer: `لقيت هالملاحظة بتاريخ ${fmtDate(n.created_at)}: ${snippet(n)}`,
        sources: [{ note_id: n.id, snippet: snippet(n) }],
        demo: true,
      };
    }
  }

  // ── opinion: "شو المنتجات الي جربتها وما عجبتني؟" ──
  if (intent === 'opinion') {
    // opinions are inherently the answer — don't require keyword overlap
    const ops = items.filter((it) => it.kind === 'opinion');
    const pool = (ops.length > 0 ? ops : rankedItems.map((r) => r.it)).slice(0, 8);
    if (pool.length > 0) {
      return {
        answer:
          '💭 ' + pool.map((it) => `• ${it.title}${it.details ? ` — ${it.details}` : ''}`).join('\n'),
        sources: pool.map(src),
        demo: true,
      };
    }
  }

  // ── checklist: "شو لازم أتذكر قبل السفر؟" ──
  if (intent === 'checklist') {
    const lists = items.filter((it) => it.kind === 'checklist').slice(0, 12);
    if (lists.length > 0) {
      return {
        answer:
          '🧳 قبل السفر:\n' + lists.map((it) => `• ${it.title}`).join('\n'),
        sources: lists.map(src),
        demo: true,
      };
    }
  }

  // ── general: best item, else best note ──
  if (rankedItems[0]) {
    const { it } = rankedItems[0];
    const icon = { task: '⬜', appointment: '📅', shopping: '🛒', place: '📍', spec: '📏', opinion: '💭', checklist: '🧳' }[it.kind] ?? '•';
    return {
      answer: `${icon} ${it.title}${it.details ? `: ${it.details}` : ''}${it.due_at ? ` (${fmtDate(it.due_at)})` : ''}`,
      sources: [src(it)],
      demo: true,
      item: it.kind === 'place' || it.kind === 'spec' ? it : undefined,
    };
  }
  if (rankedNotes[0]) {
    const { n } = rankedNotes[0];
    return {
      answer: snippet(n),
      sources: [{ note_id: n.id, snippet: snippet(n) }],
      demo: true,
    };
  }
  return null;
}

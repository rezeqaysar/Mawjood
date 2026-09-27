// ── 🧭 routing.ts: the routing engine ("وين أحط هاي؟") ────────────────────
// Decides WHERE a note goes: which SPACE and which TAB — in 4 ordered layers,
// so the agent stops guessing:
//
//   1. explicit — the user names the destination ("حطها بالعيلة") → 100%
//   2. learned  — the user corrected us before ("لا هاي للشغل") → their rule
//   3. rules    — the curated pattern table (papers→private/أوراق, …)
//   4. model    — returns null; the caller (chat agent) decides with the
//                full tab list in context, and asks when unsure
//
// Pure TypeScript, zero dependencies — extractable on its own.
// Learning writes go through buildRouteFact(); the caller persists them
// (memory engine: mkey "route:…", mcat "route").

export type SpaceType = 'private' | 'family' | 'work';

export interface TabInfo {
  id: string; // uuid from space_tabs, or 'papers' for 📄 اوراقي الخاصة
  title: string; // e.g. "مشتريات", "اوراقي الخاصة"
  icon: string;
  space: SpaceType;
}

export interface RouteDecision {
  space: SpaceType;
  tabId: string | null;
  confidence: number; // 0..1
  source: 'explicit' | 'learned' | 'rule';
  reason: string; // short Arabic label for logs/debugging
}

export interface LearnedRoute {
  keywords: string[]; // normalized tokens
  space: SpaceType;
  tabId: string | null;
  hits: number; // reinforcement count
}

// ── normalization (standalone: this file has no imports) ──
export function normAr(s: string): string {
  return (s ?? '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ؤ]/g, 'و')
    .replace(/[ئ]/g, 'ي')
    .replace(/[\u064B-\u0652\u0670]/g, '')
    .toLowerCase()
    .trim();
}

const tokens = (s: string): string[] =>
  normAr(s).split(/[\s،,؛;:.!?؟"'\-()\[\]]+/).filter((w) => w.length > 1);

// ── layer 1: explicit destination commands ──
const SPACE_WORDS: Record<SpaceType, RegExp> = {
  family: /(العيله|العائله|البيت|الدار|لاهلي|اهلي)/,
  work: /(الشغل|العمل|المكتب|الشركه)/,
  private: /(الخاص|البرايفت|مساحتي|لحالي)/,
};
const EXPLICIT_VERB = /(حط(ها|ه|يه|يها)?|ضيف(ها)?|سجل(ها)?|احفظ(ها)?|انقل(ها)?|ودي(ها)?|خلي(ها)?)/;
const EXPLICIT_DEST = /(للعيله|للعائله|للبيت|للدار|لاهلي|للشغل|للعمل|للمكتب|للشركه|للخاص|ع الخاص|بالخاص|بالعيله|بالشغل)/;

function explicitSpace(t: string): SpaceType | null {
  const n = normAr(t);
  if (!EXPLICIT_VERB.test(n) && !EXPLICIT_DEST.test(n)) return null;
  for (const st of ['family', 'work', 'private'] as SpaceType[]) {
    if (SPACE_WORDS[st].test(n)) return st;
  }
  return null;
}

function explicitTab(t: string, tabs: TabInfo[]): TabInfo | null {
  const n = normAr(t);
  // "بتبويب الأوراق" / "تبويب المشتريات"
  const m = n.match(/(بتبويب|تبويب|فولدر|مجلد)\s+([^\s،,]+)/);
  if (m) {
    const want = m[2];
    const hit = tabs.find((tb) => normAr(tb.title).includes(want) || want.includes(normAr(tb.title)));
    if (hit) return hit;
  }
  // 📄 اوراقي الخاصة shortcuts
  if (/(بالاوراق|بتبويب الاوراق|بالأوراق|بالاوراق الخاصه)/.test(n)) {
    const papers = tabs.find((tb) => tb.id === 'papers');
    if (papers) return papers;
  }
  return null;
}

// ── layer 3: the curated rule table (migrated + extended) ──
const WORK_RE =
  /(شغل|الشغل|عمل|اجتماع|الاجتماع|مدير|المدير|عميل|العميل|شركه|الشركه|مكتب|المكتب|مشروع|المشروع|راتب|work|meeting|boss|manager|client|office|company|project|salary|invoice)/i;
const FAMILY_RE =
  /(اولاد|عيله|عائله|العيله|بيت|البيت|دار|مدرسه|المدرسه|زوجه|زوج|ام|اب|بنت|ولد|جد|ست|خال|عم|بدنا|نشتري|منشتري|اشتري|شراء|شرا|سوبرماركت|مشتريات|تسوق|family|kids|kid|home|house|wife|husband|school|mama|baba|mother|father|son|daughter|buy|buying|groceries|grocery|supermarket|shopping)/i;

interface Rule {
  re: RegExp;
  space: SpaceType;
  tabTitle?: string; // matches TabInfo.title (normalized, includes)
  reason: string;
}
// Order matters: first match wins.
const RULES: Rule[] = [
  { re: /(فاتوره|عقد|جواز|هويه|رخصه|كشف حساب|تامين|ايصال|ضمان|شهاده|passport|contract|invoice|license|insurance)/i, space: 'private', tabTitle: 'اوراق', reason: 'أوراق رسمية → تبويب الأوراق' },
  { re: /(اشتري|اشتر|جيب|جيبي|هات|ناقصنا|لازم نشتري|قائمه (المشتريات|التسوق)|تسوق|سوبرماركت|مشتريات|buy|groceries|grocery|shopping list)/i, space: 'family', tabTitle: 'مشتريات', reason: 'مشتريات → العيلة' },
  { re: /(بكرا|غدا|اليوم|الاسبوع الجاي).{0,20}(اجتماع|موعد|مقابله|عميل)/i, space: 'work', reason: 'موعد شغل' },
  { re: WORK_RE, space: 'work', reason: 'كلمات شغل' },
  { re: FAMILY_RE, space: 'family', reason: 'كلمات عيلة' },
];

function ruleTab(tabTitle: string | undefined, tabs: TabInfo[], space: SpaceType): TabInfo | null {
  if (!tabTitle) return null;
  const want = normAr(tabTitle);
  return tabs.find((tb) => tb.space === space && normAr(tb.title).includes(want)) ?? null;
}

// ── layer 2: learned routes ("لا هاي للشغل" → rule) ──
// Arabic light stemming for matching: strip the definite-article prefixes
// so "الضغط" matches a learned keyword "ضغط".
const stem = (w: string): string => w.replace(/^(لل|بال|كال|فال|ال)/, '');

function matchLearned(t: string, routes: LearnedRoute[]): { route: LearnedRoute; score: number } | null {
  const toks = new Set(tokens(t).map(stem));
  if (toks.size === 0 || routes.length === 0) return null;
  let best: LearnedRoute | null = null;
  let bestScore = 0;
  for (const r of routes) {
    if (!r.keywords.length) continue;
    const keys = r.keywords.map(stem);
    const hits = keys.filter((k) => toks.has(k)).length;
    const score = hits / keys.length;
    if (hits >= 2 && score >= 0.5 && score > bestScore) {
      best = r;
      bestScore = score;
    }
  }
  return best ? { route: best, score: bestScore } : null;
}

// ── the engine ──
export function routeText(
  text: string,
  ctx: { tabs: TabInfo[]; learned: LearnedRoute[] },
): RouteDecision | null {
  const t = (text ?? '').trim();
  if (!t) return null;

  // layer 1 — explicit
  const es = explicitSpace(t);
  if (es) {
    const et = explicitTab(t, ctx.tabs.filter((tb) => tb.space === es));
    return {
      space: es,
      tabId: et ? et.id : null,
      confidence: 1,
      source: 'explicit',
      reason: `أمر صريح → ${es}${et ? ' / ' + et.title : ''}`,
    };
  }

  // layer 2 — learned from the user's own corrections
  const learned = matchLearned(t, ctx.learned);
  if (learned) {
    return {
      space: learned.route.space,
      tabId: learned.route.tabId,
      confidence: 0.85,
      source: 'learned',
      reason: `تعلم من تصحيحك (${learned.route.hits}×)`,
    };
  }

  // layer 3 — rule table (patterns are normalized → test normalized text)
  const n = normAr(t);
  for (const rule of RULES) {
    if (rule.re.test(n)) {
      const tb = ruleTab(rule.tabTitle, ctx.tabs, rule.space);
      return {
        space: rule.space,
        tabId: tb ? tb.id : null,
        confidence: 0.75,
        source: 'rule',
        reason: rule.reason,
      };
    }
  }

  // layer 4 — abstain: the chat agent decides (tabs are in its context)
  return null;
}

// ── learning: turn a correction into a persistent rule ──
const STOPWORDS = new Set(
  'من|على|في|الى|الي|مع|عن|ان|انه|هذا|هذه|هاد|هاي|اللي|الذي|التي|شو|ايش|وين|كيف|ليش|متى|كم|قديش|انا|انت|هو|هي|نحن|احنا|هم|هن|كان|صار|بدي|بدنا|لازم|ممكن|فيه|فيها|كمان|بس|او|و|يا|اه|لا|نعم|the|a|an|to|of|in|on|for|is|are|was|my|me|i|you|we|they|it|this|that'.split('|'),
);

export function extractKeywords(text: string, max = 8): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of tokens(text)) {
    if (w.length < 3 || STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

/** Build the memory fact that persists a routing correction. Caller upserts it. */
export function buildRouteFact(
  noteText: string,
  space: SpaceType,
  tabId: string | null,
  tabTitle?: string,
) {
  const keywords = extractKeywords(noteText);
  const sig = keywords.slice(0, 4).join('_') || 'note';
  const dest = `${space}${tabId ? '/' + (tabTitle ?? tabId) : ''}`;
  return {
    content: `ملاحظات عن (${keywords.slice(0, 5).join('، ')}) ← تروح على ${dest}`,
    mkey: `route:${space}:${tabId ?? 'main'}:${sig}`.slice(0, 80),
    mcat: 'route',
    importance: 4,
    meta: {
      route: { keywords, space, tabId },
    },
  };
}

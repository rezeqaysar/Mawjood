// ── 🧠 User memory ("ذاكرة المستخدم") ──────────────────────────────────────
// The learning half of "professional AI": the app remembers stable facts
// about the user ("ناديني أبو كريم", "الخضرة عندي يعني بندورة وخيار") and
// injects them into the agent's prompt on every turn.
//
// UI-free, zero-dependency engine (user rule: build as an engine so the code
// can be pulled for reuse tomorrow — e.g. a profile page or onboarding).
//
// What it does:
//   * parseMemoryStatement("ناديني أبو كريم") → { key:'identity:name', value:'أبو كريم', ... }
//   * upsertMemoryFact(...) → stores an items row with kind='memory'
//     (meta = { mkey, mcat }); same key overwrites (no duplicates)
//   * loadMemoryFacts(...) → MemoryFact[] for prompt injection
//   * formatMemoriesForPrompt(facts) → "معلومات عن المستخدم:\n- ..."
//   * formatMemorySaved(fact) → chat confirmation "حفظتها 🧠 ..."
//   * parseFeedbackIntent? — no: 👍👎 votes are recorded by the caller as
//     items with kind='feedback' (meta = { rating, question, answer }).
//
// Storage note: kind='memory'/'feedback' require migration 0023 (CHECK
// constraint). Until applied, upsert throws and callers fall back silently.

export type MemoryLang = 'ar' | 'en';

export type MemoryCategory = 'identity' | 'family' | 'preference' | 'meaning';

export interface MemoryFact {
  /** stable upsert key, e.g. 'identity:name', 'family:spouse', 'meaning:الخضرة' */
  key: string;
  /** the remembered value */
  value: string;
  /** human-readable line, e.g. 'بيناديني: أبو كريم' */
  label: string;
  category: MemoryCategory;
}

/** Minimal surface this engine needs — structurally satisfied by VoiceEngine. */
export interface MemoryClient {
  listMemoryItems(spaceId: string): Promise<
    { id: string; title: string; details: string | null; meta: any }[]
  >;
  deleteMemoryItem(id: string): Promise<void>;
  createMemoryItem(input: {
    spaceId: string;
    title: string;
    details: string;
    meta: Record<string, string>;
    userId: string;
  }): Promise<void>;
}

function cleanValue(raw: string): string | null {
  const v = raw
    .replace(/[؟?!.،,؛:«»""()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return v.length >= 2 ? v : null;
}

const isAr = (s: string) => /[\u0600-\u06FF]/.test(s);

// verbs after بحب that mean "I'd like to…" (not a real preference) — skip those
const WANT_VERBS = /^(احكي|أحكي|احكيلك|أحكيلك|قلك|أقلك|اسأل|أسأل|اسألك|اخبرك|أخبرك|سجل|سجلي)/;

interface Rule {
  re: RegExp;
  build: (m: RegExpMatchArray, lang: MemoryLang) => MemoryFact | null;
}

const RULES: Rule[] = [
  // ── identity ──
  {
    re: /ناديني (.+)/,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: 'identity:name', value: v, label: lang === 'en' ? `Call me: ${v}` : `بيناديني: ${v}`, category: 'identity' }
        : null;
    },
  },
  {
    re: /(?:انا )?اسمي (.+)/,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: 'identity:name', value: v, label: lang === 'en' ? `My name: ${v}` : `اسمي: ${v}`, category: 'identity' }
        : null;
    },
  },
  {
    re: /my name is (.+)/i,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: 'identity:name', value: v, label: lang === 'en' ? `My name: ${v}` : `اسمي: ${v}`, category: 'identity' }
        : null;
    },
  },
  {
    re: /call me (.+)/i,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: 'identity:name', value: v, label: lang === 'en' ? `Call me: ${v}` : `بيناديني: ${v}`, category: 'identity' }
        : null;
    },
  },
  // ── family names ──
  {
    re: /(?:مرتي|زوجتي) اسمها (.+)/,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: 'family:spouse', value: v, label: lang === 'en' ? `Wife's name: ${v}` : `مرته اسمها: ${v}`, category: 'family' }
        : null;
    },
  },
  {
    re: /ابني اسمه (.+)/,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: 'family:son', value: v, label: lang === 'en' ? `Son's name: ${v}` : `ابنه اسمه: ${v}`, category: 'family' }
        : null;
    },
  },
  {
    re: /بنتي اسمها (.+)/,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: 'family:daughter', value: v, label: lang === 'en' ? `Daughter's name: ${v}` : `بنته اسمها: ${v}`, category: 'family' }
        : null;
    },
  },
  {
    re: /my wife'?s name is (.+)/i,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: 'family:spouse', value: v, label: lang === 'en' ? `Wife's name: ${v}` : `مرته اسمها: ${v}`, category: 'family' }
        : null;
    },
  },
  // ── meanings ("الخضرة عندي يعني بندورة وخيار") ──
  {
    re: /لما (?:أقول|اقول|أحكي|احكي) (.+?) يعني (.+)/,
    build: (m, lang) => {
      const k = cleanValue(m[1]);
      const v = cleanValue(m[2]);
      return k && v
        ? { key: `meaning:${k}`, value: v, label: lang === 'en' ? `When they say "${k}" they mean: ${v}` : `لما يقول "${k}" يعني: ${v}`, category: 'meaning' }
        : null;
    },
  },
  {
    re: /(.+?) عندي يعني (.+)/,
    build: (m, lang) => {
      const k = cleanValue(m[1]);
      const v = cleanValue(m[2]);
      // guard: "عندي موعد يعني…" is not a meaning definition — keep the
      // key short and noun-like
      if (!k || !v || k.length > 24) return null;
      return { key: `meaning:${k}`, value: v, label: lang === 'en' ? `"${k}" means: ${v}` : `"${k}" عنده يعني: ${v}`, category: 'meaning' };
    },
  },
  {
    re: /when i say (.+?) (?:it )?means (.+)/i,
    build: (m, lang) => {
      const k = cleanValue(m[1]);
      const v = cleanValue(m[2]);
      return k && v
        ? { key: `meaning:${k}`, value: v, label: lang === 'en' ? `When they say "${k}" they mean: ${v}` : `لما يقول "${k}" يعني: ${v}`, category: 'meaning' }
        : null;
    },
  },
  // ── preferences ──
  {
    re: /(?:ما بحب|مابحب) (.+)/,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: `preference:dislike:${v}`, value: v, label: lang === 'en' ? `Dislikes: ${v}` : `ما بيحب: ${v}`, category: 'preference' }
        : null;
    },
  },
  {
    re: /بكره (.+)/,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: `preference:dislike:${v}`, value: v, label: lang === 'en' ? `Dislikes: ${v}` : `ما بيحب: ${v}`, category: 'preference' }
        : null;
    },
  },
  {
    re: /بحب (.+)/,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      if (!v || WANT_VERBS.test(v)) return null;
      return { key: `preference:like:${v}`, value: v, label: lang === 'en' ? `Likes: ${v}` : `بيحب: ${v}`, category: 'preference' };
    },
  },
  {
    re: /i (?:don'?t|do not) like (.+)/i,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: `preference:dislike:${v}`, value: v, label: lang === 'en' ? `Dislikes: ${v}` : `ما بيحب: ${v}`, category: 'preference' }
        : null;
    },
  },
  {
    re: /i (?:like|love) (.+)/i,
    build: (m, lang) => {
      const v = cleanValue(m[1]);
      return v
        ? { key: `preference:like:${v}`, value: v, label: lang === 'en' ? `Likes: ${v}` : `بيحب: ${v}`, category: 'preference' }
        : null;
    },
  },
];

/**
 * Detect a "remember this about me" statement. Returns the fact or null.
 * Conservative: only matches explicit definition patterns — normal notes
 * ("عندي موعد بكرة") never match.
 */
export function parseMemoryStatement(raw: string, lang?: MemoryLang): MemoryFact | null {
  const text = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text || text.length < 6) return null;
  const l: MemoryLang = lang ?? (isAr(raw) ? 'ar' : 'en');
  for (const rule of RULES) {
    const m = text.match(rule.re);
    if (m) {
      const fact = rule.build(m, l);
      if (fact) return fact;
    }
  }
  return null;
}

/** "معلومات عن المستخدم:\n- …" — injected into the agent system prompt. */
export function formatMemoriesForPrompt(facts: MemoryFact[], lang?: MemoryLang): string {
  if (!facts.length) return '';
  const l: MemoryLang = lang ?? 'ar';
  const head = l === 'en' ? 'Known facts about the user (use when relevant):' : 'معلومات معروفة عن المستخدم (استعملها عند الحاجة):';
  return head + '\n- ' + facts.map((f) => f.label).join('\n- ');
}

/** Chat confirmation after saving a fact. */
export function formatMemorySaved(fact: MemoryFact, lang?: MemoryLang): string {
  const l: MemoryLang = lang ?? (isAr(fact.label) ? 'ar' : 'en');
  return l === 'en' ? `Got it 🧠 ${fact.label}` : `حفظتها 🧠 ${fact.label}`;
}

/** Load all stored facts (for prompt injection). */
export async function loadMemoryFacts(
  client: MemoryClient,
  spaceId: string,
): Promise<MemoryFact[]> {
  const rows = await client.listMemoryItems(spaceId).catch(() => []);
  return rows
    .filter((r) => r.meta?.mkey)
    .map((r) => ({
      key: String(r.meta.mkey),
      value: r.details ?? '',
      label: r.title,
      category: (r.meta.mcat as MemoryCategory) ?? 'preference',
    }));
}

/** Upsert by key: same key overwrites, never duplicates. */
export async function upsertMemoryFact(
  client: MemoryClient,
  spaceId: string,
  userId: string,
  fact: MemoryFact,
): Promise<void> {
  const rows = await client.listMemoryItems(spaceId).catch(() => []);
  const existing = rows.find((r) => r.meta?.mkey === fact.key);
  if (existing) {
    await client.deleteMemoryItem(existing.id).catch(() => {});
  }
  await client.createMemoryItem({
    spaceId,
    title: fact.label,
    details: fact.value,
    meta: { mkey: fact.key, mcat: fact.category },
    userId,
  });
}

// ── 🛡️ Scope guard ("حارس النطاق") ─────────────────────────────────────────
// Deterministic "is this outside the app's scope?" check that runs BEFORE the
// AI agent in the interception chain.
//
// Conservative by design: it only intercepts inputs it is SURE are out of
// scope (general knowledge, weather, news/sports, jokes, translation...).
// Everything else passes through to the agent untouched — a false negative
// (letting something through) is always safer than a false positive
// (blocking a legit memory question like "وين المفك؟").
//
// UI-free, zero-dependency engine (user rule: build as an engine so the code
// can be pulled for reuse tomorrow).
//
// What it does:
//   * detectOutOfScope("شو عاصمة فرنسا؟") → { out: true, topic: 'general_knowledge' }
//   * detectOutOfScope("وين المفك؟")      → { out: false }
//   * formatScopeRedirect('ar' | 'en')    → polite "outside my scope" reply

export type ScopeLang = 'ar' | 'en';

export type ScopeTopic =
  | 'general_knowledge'
  | 'weather'
  | 'news_sports'
  | 'jokes'
  | 'translation';

export interface ScopeVerdict {
  out: boolean;
  topic?: ScopeTopic;
}

function normalize(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[؟?!.،,؛:«»""()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Each entry: [topic, patterns]. A pattern matches → out of scope.
// Word-boundary-ish matching via spaces/padding to avoid substring traps
// (e.g. "خبرني" must NOT match "أخبار").
const RULES: [ScopeTopic, RegExp[]][] = [
  [
    'general_knowledge',
    [
      /عاصمة/,
      /عدد (ال)?سكان/,
      /كم (عدد )?سكان/,
      /متى (تأسس|تاسس|انشئ|أنشئ)/,
      /من (هو|هي) (الرئيس|الملك|رئيس|ملك)/,
      /من اخترع/,
      /ما (هي|هو) عملة/,
      /أين تقع/,
      /كم تبعد/,
      /capital of/,
      /population of/,
      /who is the president/,
      /who invented/,
      /when was .* founded/,
      /how far is/,
    ],
  ],
  [
    'weather',
    [
      /طقس/,
      /درجة الحرارة/,
      /رح تمطر/,
      /بتمطر/,
      /\bweather\b/,
      /will it rain/,
      /temperature (today|tomorrow)/,
    ],
  ],
  [
    'news_sports',
    [
      /الأخبار/,
      /أخبار اليوم/,
      /خبر عاجل/,
      /نتيجة (مباراة|المباراة)/,
      /مين فاز/,
      /الدوري/,
      /\bnews\b/,
      /match result/,
      /who won the/,
    ],
  ],
  [
    'jokes',
    [
      /نكتة/,
      /نكته/,
      /احكي ?لي قصة/,
      /حدوتة/,
      /tell me a joke/,
    ],
  ],
  [
    'translation',
    [
      /ترجم/,
      /شو يعني .* بالإنجليزي/,
      /يعني ايه .* بالإنجليزي/,
      /\btranslate\b/,
    ],
  ],
];

/**
 * Conservative out-of-scope detector. Returns { out: true, topic } only for
 * inputs that clearly belong to general knowledge / weather / news / jokes /
 * translation. Everything else → { out: false } (let the agent handle it).
 */
export function detectOutOfScope(raw: string): ScopeVerdict {
  const text = normalize(raw);
  if (!text) return { out: false };
  // Never intercept very short inputs — too ambiguous ("شو؟", "وين؟").
  if (text.length < 6) return { out: false };
  for (const [topic, patterns] of RULES) {
    for (const re of patterns) {
      if (re.test(text)) return { out: true, topic };
    }
  }
  return { out: false };
}

/** Polite "that's outside my scope" reply, in the UI language. */
export function formatScopeRedirect(lang: ScopeLang): string {
  if (lang === 'en') {
    return (
      "That's outside my scope 🙂 I'm your memory for your things, tasks, " +
      'appointments, and expenses — ask me about something of yours, or tell ' +
      'me something you want to remember.'
    );
  }
  return (
    'هاد خارج نطاقي 🙂 أنا ذاكرة أشيائك ومهامك ومواعيدك ومصاريفك — ' +
    'اسألني عن شي بيخصك، أو احكيلي شي بدك تتذكره.'
  );
}

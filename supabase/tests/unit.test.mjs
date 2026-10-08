// Unit tests for the zero-dependency shared engines.
// Run: node --import ./supabase/tests/deno-shim.mjs --test supabase/tests/unit.test.mjs
// (node >= 22 strips types natively; no build step, no extra deps)
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import {
  verifyRouting,
  LEARNED_FIXTURE,
  LEARNED_SCENARIOS,
  SCENARIO_TABS,
} from '../functions/_shared/routing.scenarios.ts';
import { routeText } from '../functions/_shared/routing.ts';
import { resolveTabName } from '../functions/_shared/tabs.ts';
import {
  normAr,
  scoreFact,
  parseLearned,
  factLine,
} from '../functions/_shared/memory.ts';

// edge-auth.ts imports supabase-js from esm.sh — resolve it to our stub
// BEFORE the dynamic import below.
register('./resolve-hook.mjs', import.meta.url);
const edgeAuth = await import('../functions/_shared/edge-auth.ts');

describe('routing engine — scenario suite', () => {
  it('passes all 23 scenarios (no regressions)', () => {
    const r = verifyRouting(LEARNED_FIXTURE);
    const fails = r.results.filter((x) => !x.passed);
    assert.equal(r.failed, 0, `failing scenarios:\n${fails.map((f) => `  "${f.scenario.text}" got ${JSON.stringify(f.got)} (why: ${f.scenario.why})`).join('\n')}`);
    assert.equal(r.passed, 23);
  });

  it('layer 2: learned corrections beat rules', () => {
    for (const s of LEARNED_SCENARIOS) {
      const d = routeText(s.text, { tabs: SCENARIO_TABS, learned: LEARNED_FIXTURE });
      assert.ok(d, `expected a decision for "${s.text}"`);
      assert.equal(d.space, s.expectSpace, `"${s.text}"`);
    }
  });
});

describe('memory engine — pure functions', () => {
  it('normAr normalizes Arabic variants', () => {
    assert.equal(normAr('أحمد'), 'احمد'); // hamza forms → ا
    assert.equal(normAr('السيّارة'), 'السياره'); // shadda stripped, ة → ه
    assert.equal(normAr('Hello, World!'), 'hello world');
    assert.equal(normAr('  في   البيت  '), 'في البيت');
  });

  it('scoreFact ranks relevant facts above irrelevant ones', () => {
    const now = new Date().toISOString();
    const relevant = { title: 'مفتاح السيارة', details: 'في درج المطبخ', meta: { importance: 3 }, created_at: now, updated_at: now };
    const irrelevant = { title: 'موعد دكتور الأسنان', details: 'يوم الخميس', meta: { importance: 3 }, created_at: now, updated_at: now };
    const rel = scoreFact(relevant, ['مفتاح']);
    const irr = scoreFact(irrelevant, ['مفتاح']);
    assert.ok(rel > irr, `relevant=${rel} should beat irrelevant=${irr}`);
    assert.equal(scoreFact(relevant, []), 0, 'empty query → 0');
  });

  it('parseLearned never throws and strips code fences', () => {
    const fenced = '```json\n{"facts":[{"content":"يحب القهوة","mkey":"preference:coffee","mcat":"preference","importance":4}]}\n```';
    const out = parseLearned(fenced);
    assert.equal(out.length, 1);
    assert.equal(out[0].mkey, 'preference:coffee');

    assert.deepEqual(parseLearned('not json at all {{{'), []);
    assert.deepEqual(parseLearned('{"facts":[]}'), []);
  });

  it('factLine truncates long details', () => {
    const line = factLine({ title: 'x', details: 'y'.repeat(200) });
    assert.ok(line.length <= 140);
  });
});

describe('edge-auth — internal secret check', () => {
  const mkReq = (secret) =>
    new Request('http://x/', { headers: secret === undefined ? {} : { 'x-internal-secret': secret } });

  it('accepts the correct secret', () => {
    process.env.INTERNAL_FN_SECRET = 's3cr3t-abc-123';
    assert.equal(edgeAuth.isInternal(mkReq('s3cr3t-abc-123')), true);
  });

  it('rejects wrong / missing / wrong-length secrets', () => {
    process.env.INTERNAL_FN_SECRET = 's3cr3t-abc-123';
    assert.equal(edgeAuth.isInternal(mkReq('wrong')), false);
    assert.equal(edgeAuth.isInternal(mkReq('s3cr3t-abc-124')), false); // same length, 1 char off
    assert.equal(edgeAuth.isInternal(mkReq(undefined)), false);
  });

  it('rejects everything when no secret is configured', () => {
    delete process.env.INTERNAL_FN_SECRET;
    assert.equal(edgeAuth.isInternal(mkReq('anything')), false);
  });

  it('internalHeaders carries the secret header name', () => {
    process.env.INTERNAL_FN_SECRET = 'zz';
    const h = edgeAuth.internalHeaders();
    assert.equal(h['x-internal-secret'], 'zz');
  });
});

describe('ai engine — chatBody token parameter (GPT-5 400 regression)', () => {
  const openaiLike = { supportsMaxTokens: false };
  const groqLike = { supportsMaxTokens: true };

  it('sends max_completion_tokens (not max_tokens) on the OpenAI path', async () => {
    const { chatBody } = await import('../functions/_shared/ai.ts');
    const b = chatBody(openaiLike, { max_tokens: 450, messages: [] });
    assert.equal(b.max_completion_tokens, 450);
    assert.ok(!('max_tokens' in b), 'max_tokens must not be sent to GPT-5');
  });

  it('keeps max_tokens on the Groq path', async () => {
    const { chatBody } = await import('../functions/_shared/ai.ts');
    const b = chatBody(groqLike, { max_tokens: 450, messages: [] });
    assert.equal(b.max_tokens, 450);
    assert.ok(!('max_completion_tokens' in b));
  });
});

describe('rate limiting — window math', () => {
  it('truncates to minute and hour boundaries', async () => {
    const { windowStarts } = await import('../functions/_shared/rate-limit.ts');
    // 2026-09-28T00:37:42.123Z
    const t = Date.UTC(2026, 8, 28, 0, 37, 42, 123);
    const w = windowStarts(t);
    assert.equal(w.minute, '2026-09-28T00:37:00.000Z');
    assert.equal(w.hour, '2026-09-28T00:00:00.000Z');
  });

  it('limits table covers the four AI functions', async () => {
    const { AI_LIMITS, DEFAULT_LIMIT } = await import('../functions/_shared/rate-limit.ts');
    for (const fn of ['chat', 'ask', 'extract', 'transcribe']) {
      assert.ok(AI_LIMITS[fn], `missing limit for ${fn}`);
      assert.ok(AI_LIMITS[fn].perMinute > 0 && AI_LIMITS[fn].perHour > AI_LIMITS[fn].perMinute);
    }
    assert.ok(DEFAULT_LIMIT.perHour > DEFAULT_LIMIT.perMinute);
  });
});

describe('timezone model (P2-3)', () => {
  it('accepts valid IANA zones, rejects garbage', async () => {
    const { sanitizeTimezone, isValidTimezone } = await import('../functions/_shared/time.ts');
    assert.ok(isValidTimezone('America/New_York'));
    assert.ok(isValidTimezone('Asia/Dubai'));
    assert.equal(sanitizeTimezone('Europe/Paris'), 'Europe/Paris');
    assert.equal(sanitizeTimezone('not-a-zone'), 'America/New_York');
    assert.equal(sanitizeTimezone(''), 'America/New_York');
    assert.equal(sanitizeTimezone(null), 'America/New_York');
    assert.equal(sanitizeTimezone(undefined), 'America/New_York');
    assert.equal(sanitizeTimezone('../../etc/passwd'), 'America/New_York');
    assert.equal(sanitizeTimezone('America/New_York; DROP TABLE'), 'America/New_York');
  });

  it('IANA zones carry DST: New York offset shifts across the 2026 spring transition', () => {
    // US DST starts 2026-03-08 07:00 UTC — the audit asks for DST coverage.
    // This pins the platform behavior our relative-date resolution relies on.
    const fmt = (ms) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'shortOffset',
        hour: 'numeric',
      }).format(new Date(ms));
    const before = fmt(Date.UTC(2026, 2, 8, 6, 0)); // 01:00 EST
    const after = fmt(Date.UTC(2026, 2, 8, 8, 0)); // 04:00 EDT
    assert.match(before, /GMT-5/);
    assert.match(after, /GMT-4/);
  });
});

describe('tab-aware AI — resolveTabName (fuzzy Arabic tab matching)', () => {
  const TABS = [
    { id: 'papers', title: 'اوراقي الخاصة' },
    { id: 't1', title: 'أشياء أحمد' },
    { id: 't2', title: '🛒 مشتريات' },
  ];

  it('matches possessive/short forms of the papers tab', () => {
    assert.equal(resolveTabName(TABS, 'الاوراق الخاصة')?.id, 'papers');
    assert.equal(resolveTabName(TABS, 'اوراق خاصه')?.id, 'papers');
    assert.equal(resolveTabName(TABS, 'تبويب الاوراق')?.id, 'papers');
    assert.equal(resolveTabName(TABS, 'اوراقي')?.id, 'papers');
  });

  it('matches member-name tabs through normalization', () => {
    assert.equal(resolveTabName(TABS, 'اشياء احمد')?.id, 't1');
    assert.equal(resolveTabName(TABS, 'أشياء أحمد')?.id, 't1');
    assert.equal(resolveTabName(TABS, 'تبويب اشياء احمد')?.id, 't1');
  });

  it('matches emoji-prefixed titles and partial queries', () => {
    assert.equal(resolveTabName(TABS, 'المشتريات')?.id, 't2');
    assert.equal(resolveTabName(TABS, 'مشتريات')?.id, 't2');
  });

  it('returns null on no match or empty query', () => {
    assert.equal(resolveTabName(TABS, 'السيارة'), null);
    assert.equal(resolveTabName(TABS, ''), null);
    assert.equal(resolveTabName([], 'الاوراق'), null);
  });
});

describe('shopping fast path — detection + parsing (pure)', () => {
  let shop;
  before(async () => {
    shop = await import('../functions/_shared/shopping.ts');
  });

  it('detects clear shopping-list intent', () => {
    assert.ok(shop.looksLikeShoppingList('بدنا نشتري: حليب، خبز، بيض'));
    assert.ok(shop.looksLikeShoppingList('قائمة تسوق: حليب وخبز'));
    assert.ok(shop.looksLikeShoppingList('grocery list: milk, bread'));
    assert.ok(shop.looksLikeShoppingList('جيب حليب، خبز، بيض'));
    assert.ok(shop.looksLikeShoppingList('ناقصنا: سكر، رز'));
  });

  it('rejects non-shopping statements', () => {
    assert.ok(!shop.looksLikeShoppingList('المفاتيح بدرج المطبخ'));
    assert.ok(!shop.looksLikeShoppingList('صباح الخير'));
    assert.ok(!shop.looksLikeShoppingList('حليب'));
    assert.ok(!shop.looksLikeShoppingList('اشتريت حليب مبارح'));
  });

  it('parses the user\'s real list: 14 items, qualifiers kept', () => {
    const items = shop.parseShoppingItems(
      'بدنا نشتري: كلن كلور، كلور وايبس، سائل جلي، صابون إيدين نوع نضيف، صحون بلاستيك، قصدير، قلفز مطبخ نوع للتنظيف ونوع للأكل، خيار، بصل، عنب، بطاطا حلوة، خبز توست أصفر، لحمة، جاج'
    );
    assert.equal(items.length, 14);
    assert.equal(items[0], 'كلن كلور');
    assert.ok(items.includes('صابون إيدين نوع نضيف'));
    assert.ok(items.includes('قلفز مطبخ نوع للتنظيف ونوع للأكل'));
    assert.equal(items[13], 'جاج');
  });

  it('strips intent prefixes and lead verbs, dedupes', () => {
    assert.deepEqual(shop.parseShoppingItems('جيب حليب، خبز، حليب'), ['حليب', 'خبز']);
    assert.deepEqual(shop.parseShoppingItems('shopping list: milk, bread'), ['milk', 'bread']);
  });
});

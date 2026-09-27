// Unit tests for the zero-dependency shared engines.
// Run: node --import ./supabase/tests/deno-shim.mjs --test supabase/tests/unit.test.mjs
// (node >= 22 strips types natively; no build step, no extra deps)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import {
  verifyRouting,
  LEARNED_FIXTURE,
  LEARNED_SCENARIOS,
  SCENARIO_TABS,
} from '../functions/_shared/routing.scenarios.ts';
import { routeText } from '../functions/_shared/routing.ts';
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

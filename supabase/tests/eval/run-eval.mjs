// Phase D — deterministic eval runner for the shared engines.
// Run: node supabase/tests/eval/run-eval.mjs
// (node >= 22 strips types natively; no build step, no extra deps)
// Exit code 1 on ANY failure: the corpora encode intended behavior,
// so a red case is a regression, not a flaky test.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { routeText, normAr as routeNormAr } from '../../functions/_shared/routing.ts';
import {
  normAr,
  parseLearned,
  scoreFact,
  learnSystem,
} from '../../functions/_shared/memory.ts';

const DIR = dirname(fileURLToPath(import.meta.url));
const routing = JSON.parse(readFileSync(join(DIR, 'routing.eval.json'), 'utf8'));
const memory = JSON.parse(readFileSync(join(DIR, 'memory.eval.json'), 'utf8'));

let failures = [];
let routingPassed = 0;
const routingCats = {};

function tabIdFor(tabs, space, title) {
  if (title === null || title === undefined) return null;
  const want = routeNormAr(title);
  const hit = tabs.find(
    (tb) => tb.space === space &&
      (routeNormAr(tb.title).includes(want) || want.includes(routeNormAr(tb.title))),
  );
  return hit ? hit.id : `<<no tab titled "${title}" in ${space}>>`;
}

// ── routing ──
for (const c of routing.cases) {
  const d = routeText(c.text, { tabs: routing.tabs, learned: routing.learned });
  let ok, got;
  if (c.expect.abstain) {
    ok = d === null;
    got = d === null ? 'abstain' : `${d.space}/${d.tabId} (${d.source})`;
  } else {
    const wantTab = tabIdFor(routing.tabs, c.expect.space, c.expect.tab);
    ok = !!d && d.space === c.expect.space && d.tabId === wantTab;
    got = d ? `${d.space}/${d.tabId} (${d.source})` : 'abstain';
  }
  routingCats[c.cat] = routingCats[c.cat] || { passed: 0, total: 0 };
  routingCats[c.cat].total++;
  if (ok) {
    routingPassed++;
    routingCats[c.cat].passed++;
  } else {
    const want = c.expect.abstain ? 'abstain' : `${c.expect.space}/${c.expect.tab ?? 'main'}`;
    failures.push(`[routing:${c.id}] "${c.text}" → got ${got}, want ${want} — ${c.why}`);
  }
}

// ── memory ──
let memoryPassed = 0;
let memoryTotal = 0;
const mem = (id, ok, detail) => {
  memoryTotal++;
  if (ok) memoryPassed++;
  else failures.push(`[memory:${id}] ${detail}`);
};

for (const c of memory.suites.normAr) {
  const got = normAr(c.input);
  mem(c.id, got === c.expect, `normAr("${c.input}") → "${got}", want "${c.expect}"`);
}
for (const c of memory.suites.parseLearned) {
  const got = parseLearned(c.raw);
  let ok = got.length === c.expect.length;
  let detail = `parseLearned → ${got.length} facts, want ${c.expect.length}`;
  if (ok) {
    for (let i = 0; i < got.length; i++) {
      for (const k of Object.keys(c.expect[i])) {
        if (String(got[i][k]) !== String(c.expect[i][k])) {
          ok = false;
          detail = `fact[${i}].${k} → "${got[i][k]}", want "${c.expect[i][k]}"`;
          break;
        }
      }
      if (!ok) break;
    }
  }
  mem(c.id, ok, detail);
}
for (const c of memory.suites.scoreFact) {
  const scores = c.facts.map((f) => scoreFact(f, c.query));
  if (c.bothZero) {
    mem(c.id, scores.every((s) => s === 0), `scores ${scores}, want all 0`);
  } else {
    const top = scores.indexOf(Math.max(...scores));
    mem(c.id, top === c.expectTop, `top=${top} scores=${scores.map((s) => s.toFixed(2))}, want ${c.expectTop}`);
  }
}
for (const c of memory.suites.promptGuards) {
  const sys = learnSystem([], c.uiAr);
  const missing = c.contains.filter((s) => !sys.includes(s));
  mem(c.id, missing.length === 0, `learnSystem(uiAr=${c.uiAr}) missing: ${missing.join(', ')}`);
}

// ── report ──
console.log('── routing accuracy by category ──');
for (const [cat, s] of Object.entries(routingCats)) {
  console.log(`  ${cat.padEnd(10)} ${s.passed}/${s.total} (${((100 * s.passed) / s.total).toFixed(1)}%)`);
}
console.log(`  TOTAL      ${routingPassed}/${routing.cases.length}`);
console.log('── memory ──');
console.log(`  TOTAL      ${memoryPassed}/${memoryTotal}`);

let gitSha = 'unknown';
try {
  gitSha = execSync('git rev-parse --short HEAD', { cwd: join(DIR, '..', '..', '..') }).toString().trim();
} catch { /* not a git checkout */ }

const results = {
  ts: new Date().toISOString(),
  gitSha,
  routingCorpus: routing.version,
  memoryCorpus: memory.version,
  routing: { passed: routingPassed, total: routing.cases.length },
  memory: { passed: memoryPassed, total: memoryTotal },
  failures: failures.map((f) => f.slice(0, 300)),
};
writeFileSync(join(DIR, 'eval-results.json'), JSON.stringify(results, null, 2) + '\n');

if (failures.length) {
  console.log('\n── FAILURES ──');
  for (const f of failures) console.log('  ✗ ' + f);
  console.log(`\n${failures.length} failing case(s) — regression, fix before merge.`);
  process.exit(1);
}
console.log('\n✓ all eval cases green');

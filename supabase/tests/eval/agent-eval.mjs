// Phase D — prompt-level agent eval harness (MANUAL, not CI).
// Run: OPENAI_API_KEY=... node supabase/tests/eval/agent-eval.mjs [--case A001]
// Sends each case's turns to the model with the CURRENT APP_BRAIN prompt,
// auto-checks assertNotContains, appends results to agent-results.jsonl with
// prompt+model versions for regression tracking. Human grades the rest.
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { APP_BRAIN } from '../../functions/_shared/app-brain.ts';

const DIR = dirname(fileURLToPath(import.meta.url));
const corpus = JSON.parse(readFileSync(join(DIR, 'agent.eval.json'), 'utf8'));

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is required (manual run only — never commit a key).');
  process.exit(2);
}
const model = process.env.EVAL_MODEL || corpus.model || 'gpt-5-mini';
const onlyCase = process.argv.find((a) => a.startsWith('--case='))?.split('=')[1];

let promptSha = 'unknown';
try {
  promptSha = execSync('git hash-object functions/_shared/app-brain.ts', {
    cwd: join(DIR, '..', '..', '..'),
  }).toString().trim();
} catch { /* ignore */ }

async function chat(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      // NOTE: no temperature — GPT-5.x guards it (same as chatBody() in prod)
      max_completion_tokens: 600,
    }),
  });
  if (!res.ok) throw new Error(`model API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content ?? '';
}

const logPath = join(DIR, 'agent-results.jsonl');
const ts = new Date().toISOString();
let autoFails = 0;

for (const c of corpus.cases) {
  if (onlyCase && c.id !== onlyCase) continue;
  const messages = [{ role: 'system', content: APP_BRAIN }];
  let last = '';
  for (const t of c.turns) {
    messages.push({ role: 'user', content: t });
    last = await chat(messages);
    messages.push({ role: 'assistant', content: last });
  }
  const leaked = (c.assertNotContains || []).filter((s) => last.includes(s));
  const autoPass = leaked.length === 0;
  if (!autoPass) autoFails++;
  const row = { ts, promptSha, model, corpus: corpus.version, caseId: c.id, autoPass, leaked, output: last };
  appendFileSync(logPath, JSON.stringify(row) + '\n');
  console.log(`\n══ ${c.id} [${c.cat}] auto:${autoPass ? 'PASS' : 'FAIL' + ' leaked=' + leaked.join(',')} ══`);
  console.log(last.slice(0, 600));
  console.log(`   grade → ${c.grade}`);
}

console.log(`\nDone. ${autoFails} auto-fail(s). Full log: ${logPath}`);
console.log('Human grading: review each output against its grade line, then record the verdict.');

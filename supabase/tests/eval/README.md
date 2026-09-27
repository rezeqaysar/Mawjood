# Phase D — AI Evaluation

Versioned corpora that lock the AI's **intended behavior**. Any red case is a
regression: fix the engine (or deliberately update the corpus) before merging.

## Deterministic evals (CI-gated, 100% required)

Run: `node supabase/tests/eval/run-eval.mjs`

| Corpus | Cases | What it locks |
|---|---|---|
| `routing.eval.json` v1 | 86 | Space/tab routing: explicit commands, shopping/papers/work/family rules, `SA()`/`KIN()` standalone guards (جد/ست/عم/عمل، ام/اب), custom tabs, learned corrections + layer order, AR/EN/mixed, abstention |
| `memory.eval.json` v1 | 23 | `normAr` dialect normalization, `parseLearned` robustness, `scoreFact` ranking, `learnSystem` privacy-hard-rule presence |

Per-category accuracy prints on every run; results (+ git SHA) append to
`eval-results.json`. **Threshold: 100%.** The corpora only contain
unambiguous intended behaviors — debatable cases belong in the agent harness.

### Findings so far (locked as cases)

- `للخاص`-style glued `لل` destinations now route explicitly (was: fell through
  to a false family match via `اب` inside `الحساب`).
- `KIN()` guards `ام`/`اب`: possessive suffixes (`امي، امك، ابوك، ابوها`) and
  `ال` (`الأم`) still route family; glued traps (`بكلامه، الحساب، امبارح`)
  abstain.

### Adding a case

1. Append to the JSON with a new id (`R###` / `M###` / `P###` / `S###` / `G###`).
2. `expect`: `{space, tab}` (tab = title, `null` = main notes) or `{abstain: true}`.
3. Run the runner — it must stay 100% green.

## Prompt-level agent eval (manual, human-graded)

`agent.eval.json` v1 (14 cases) + `agent-eval.mjs`. Tests the `APP_BRAIN`
prompt **without tools**: prompt-injection resistance, secret non-disclosure
(auto-checked via `assertNotContains`), abstention, brand law
(`موجود`/`Mwjood` lead), small-talk, corrections, conflicts.

Run: `OPENAI_API_KEY=... node supabase/tests/eval/agent-eval.mjs [--case=A001]`

Results append to `agent-results.jsonl` with `{ts, promptSha, model, corpus}` —
this is the prompt/model/version tracking the audit asks for. Grade each
output against its `grade` line by hand.

## Known edges (future passes, not locked)

- `بنت/ولد/خال` kinship words are still unguarded substrings (same class
  `KIN()` fixed for `ام/اب`) — needs its own scenario design.
- `KIN()` matches kunya `ابو أحمد` as family — accepted: it's always a person
  reference, never a false-positive word.
- The harness is tool-free: tool-routing quality is covered by the routing
  corpus; a tools-enabled agent eval is future work.

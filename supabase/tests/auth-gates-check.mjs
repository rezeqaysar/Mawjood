// auth-gates-check.mjs — STATIC tripwire: every edge function must declare
// its auth gate in source.
//
// SCOPE / LIMITATION — read before trusting this script:
//   This is a tripwire, not proof. It checks that index.ts CONTAINS the
//   expected auth marker — it cannot prove the gate is checked BEFORE any
//   privileged work, that failures short-circuit, or that callers can't
//   reach the handler another way. Full assurance comes from the live
//   401-probes run against deployed functions (Phase A security probes),
//   which exercise the actual request path.
//   Note also: Supabase's platform-level verify_jwt (function default) adds
//   a gateway layer on top of these in-source gates; this script only sees
//   the in-source half.
//
// Usage: no DATABASE_URL needed.
//   node supabase/tests/auth-gates-check.mjs
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FUNCTIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'functions');

// Gate classes and the REAL source markers each one must contain.
// (Markers learned from supabase/functions/_shared/edge-auth.ts.)
const GATE_MARKERS = {
  // end-user call: Authorization JWT resolved to a user id (authUserId() or
  // supa.auth.getUser()), missing/invalid -> 401 / 'not authenticated'
  'user-jwt': ['authUserId(', '.auth.getUser(', 'json401(', 'not_authenticated'],
  // console/admin calls: x-admin-token header compared against ADMIN_TOKEN secret
  'admin-token': ['x-admin-token', 'ADMIN_TOKEN'],
  // service-to-service: x-internal-secret header / INTERNAL_FN_SECRET / isInternal()
  'internal-secret': ['x-internal-secret', 'INTERNAL_FN_SECRET', 'isInternal('],
  // pg_cron / scheduled: x-cron-secret header / CRON_SECRET env
  'cron-secret': ['CRON_SECRET', 'x-cron-secret'],
};

// Public functions need an explicit, reasoned entry here — anything else
// claiming to be public fails loudly.
const ALLOW_PUBLIC = {
  'public-config': 'read-only remote-config (feature catalog + plan prices); no user data, no secrets, no writes',
  // ⚠ stateless AI helpers: no DB, no secrets — but anonymous calls burn the
  // server AI key's quota. Currently not invoked by the client; if that
  // changes (or abuse appears), add a user-jwt gate.
  classify: 'stateless text classifier, no DB/secrets (AI-quota burn risk documented)',
  route: 'stateless input router, no DB/secrets (AI-quota burn risk documented)',
};

// Expected gate class(es) per function directory. Dual-gate functions
// (internal callers may skip the user JWT) must declare BOTH markers.
const MANIFEST = {
  'account-delete': ['user-jwt'],
  'account-export': ['user-jwt'],
  'admin-ai-governance': ['admin-token'],
  'admin-broadcast': ['admin-token'],
  'admin-catalog': ['admin-token'],
  'admin-set-limits': ['admin-token'],
  'admin-stats': ['admin-token'],
  'admin-subscribe': ['admin-token'],
  'admin-user': ['admin-token'],
  ask: ['user-jwt'],
  // chat: user-jwt primary; isInternal() appears only for the eval_mode
  // impersonation override, which still requires eval_mode + a uuid-shaped id
  chat: ['user-jwt'],
  classify: ['public'],
  extract: ['user-jwt', 'internal-secret'],
  'family-members': ['user-jwt'],
  'join-family': ['user-jwt'],
  'memory-consolidate': ['cron-secret'],
  'memory-learn': ['user-jwt'],
  notify: ['user-jwt', 'internal-secret'],
  'public-config': ['public'],
  'report-error': ['user-jwt'],
  route: ['public'],
  transcribe: ['user-jwt'],
  // vault-master: user JWT (getUser -> 401) for every action; management
  // actions additionally require the HMAC mgmt capability (VAULT_MGMT_SECRET)
  'vault-master': ['user-jwt'],
};

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg, detail) => {
  failures++;
  console.log(`  ✗ ${msg}`);
  if (detail) console.error(`    ${detail}`);
};

console.log('\n── edge function auth gates (static tripwire)');

const dirs = readdirSync(FUNCTIONS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== '_shared')
  .map((d) => d.name)
  .sort();

// fail on manifest drift in EITHER direction
for (const dir of dirs) {
  if (!(dir in MANIFEST)) bad(`unclassified function: ${dir}`, 'add it to MANIFEST with its gate class');
}
for (const name of Object.keys(MANIFEST)) {
  if (!dirs.includes(name)) bad(`manifest entry has no directory: ${name}`, 'remove stale entry');
}

for (const dir of dirs) {
  if (!(dir in MANIFEST)) continue;
  const entry = join(FUNCTIONS, dir, 'index.ts');
  if (!existsSync(entry)) {
    bad(`${dir}`, 'index.ts missing');
    continue;
  }
  const src = readFileSync(entry, 'utf8');
  const expected = MANIFEST[dir];
  let dirOk = true;
  const matched = [];
  for (const gate of expected) {
    if (gate === 'public') {
      if (dir in ALLOW_PUBLIC) matched.push(`public (${ALLOW_PUBLIC[dir].split(';')[0]})`);
      else {
        dirOk = false;
        bad(`${dir}`, `marked public but not in ALLOW_PUBLIC — add a reasoned entry or a gate`);
      }
      continue;
    }
    const markers = GATE_MARKERS[gate];
    const hit = markers.find((m) => src.includes(m));
    if (hit) matched.push(`${gate}: '${hit}'`);
    else {
      dirOk = false;
      bad(`${dir}`, `expected ${gate} gate, no marker found (looked for: ${markers.join(', ')})`);
    }
  }
  if (dirOk) ok(`${dir} [${expected.join(' + ')}] → ${matched.join(' | ')}`);
}

console.log(
  failures === 0
    ? '\n✅ auth-gates-check: ALL GREEN (tripwire only — see header)'
    : `\n❌ auth-gates-check: ${failures} failure(s)`,
);
process.exit(failures === 0 ? 0 : 1);

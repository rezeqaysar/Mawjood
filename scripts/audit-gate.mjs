// scripts/audit-gate.mjs — dependency vulnerability gate.
//
// Fails CI only on NEW high/critical advisories versus audit-baseline.json.
// Pre-existing Expo-toolchain advisories are pinned in the baseline (they
// cannot be fixed without breaking the Expo SDK pin); any advisory NOT in
// the baseline is a regression and fails the build.
//
// Usage: node scripts/audit-gate.mjs   (run from repo root)
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const baseline = new Set(
  JSON.parse(readFileSync(new URL('../audit-baseline.json', import.meta.url), 'utf8')).advisories,
);

let audit;
try {
  const out = execSync('npm audit --json', {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  audit = JSON.parse(out);
} catch (e) {
  // npm audit exits non-zero when issues are found — the JSON is still on stdout
  const stdout = e.stdout?.toString() ?? '';
  try {
    audit = JSON.parse(stdout);
  } catch {
    console.error('audit-gate: could not parse `npm audit --json` output');
    console.error(stdout.slice(0, 500));
    process.exit(2);
  }
}

const SEV_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };
const found = new Map(); // ghsa-id -> {severity, title}

// npm v7+ format
for (const v of Object.values(audit.vulnerabilities ?? {})) {
  for (const via of v.via ?? []) {
    if (via && typeof via === 'object' && via.url) {
      const m = String(via.url).match(/GHSA-[a-z0-9-]+/);
      if (m && (SEV_RANK[via.severity] ?? 0) >= SEV_RANK.high) {
        if (!found.has(m[0])) found.set(m[0], { severity: via.severity, title: via.title ?? '' });
      }
    }
  }
}
// legacy format (npm v6)
for (const a of Object.values(audit.advisories ?? {})) {
  const m = String(a.url ?? '').match(/GHSA-[a-z0-9-]+/);
  const id = m ? m[0] : null;
  if (id && (SEV_RANK[a.severity] ?? 0) >= SEV_RANK.high && !found.has(id)) {
    found.set(id, { severity: a.severity, title: a.title ?? '' });
  }
}

const fresh = [...found.keys()].filter((id) => !baseline.has(id));
if (fresh.length > 0) {
  console.error('❌ NEW high/critical vulnerabilities vs audit-baseline.json:');
  for (const id of fresh) {
    const a = found.get(id);
    console.error(`   - ${id} [${a.severity}] ${a.title}`);
  }
  console.error('\nFix the dependency, then add the advisory ID to audit-baseline.json with justification.');
  process.exit(1);
}
console.log(`✅ audit gate: ${found.size} high/critical advisories, all in baseline, 0 new.`);

// rls-audit.mjs — STATIC RLS policy audit (not a behavioral test).
//
// SCOPE / LIMITATION — read before trusting this script:
//   This is a STATIC audit of policy DEFINITIONS on plain Postgres. CI has
//   no Supabase Auth (no JWTs, no auth.users identities), so we CANNOT prove
//   that a policy actually grants/denies the right rows to the right user.
//   What this catches: tables with RLS off, permissive policies whose USING
//   / WITH CHECK clause is the literal `true` (open to every authenticated
//   caller), and tables with zero policies. What it does NOT prove: that an
//   owner-only policy really restricts to the owner, or that any role can
//   actually read its own rows.
//   REMEDIATION (non-blocking future work): run true behavioral tests with
//   Supabase Auth — `supabase db reset` via the Supabase CLI, create test
//   users, mint their JWTs, and issue queries as each role (anon,
//   authenticated-as-owner, authenticated-as-stranger, service_role).
//
// Usage (run AFTER migrate-check against the same scratch database):
//   DATABASE_URL=postgres://user:pass@host:5432/postgres \
//     node supabase/tests/rls-audit.mjs
import pg from 'pg';

const TEST_DB = 'mawjood_migtest';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error('DATABASE_URL is required, e.g. postgres://postgres:postgres@localhost:5432/postgres');
  process.exit(2);
}

const step = (msg) => console.log(`\n── ${msg}`);
let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures++;
  console.log(`  ✗ ${name}`);
  if (detail) console.error(`    ${detail}`);
};

// Migration bookkeeping tables are infrastructure, not user data —
// they carry no rows worth protecting and often deliberately have RLS off.
const MIGRATION_TABLES = `t.tablename <> ALL(ARRAY['schema_migrations','supabase_migrations']) AND t.tablename NOT LIKE '%_migrations'`;

try {
  const db = new pg.Client({ connectionString: baseUrl.replace(/\/[^/]*$/, `/${TEST_DB}`) });
  await db.connect();

  step('a. every public table has RLS enabled');
  {
    const { rows } = await db.query(`
      select t.tablename
      from pg_tables t
      join pg_class c on c.relname = t.tablename
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = t.schemaname
      where t.schemaname = 'public'
        and ${MIGRATION_TABLES}
        and c.relrowsecurity = false
      order by 1`);
    if (rows.length === 0) ok('all public tables have RLS enabled');
    else bad(`${rows.length} table(s) without RLS`, rows.map((r) => r.tablename).join(', '));
  }

  step('b. no permissive policy with a trivially-true qualifier');
  {
    // A PERMISSIVE policy with USING(true) or WITH CHECK(true) opens the
    // table (or the checked operation) to every role the policy applies to.
    // Compare trimmed/lowercased because pg renders the expr as `true`.
    const { rows } = await db.query(`
      select schemaname, tablename, policyname,
             coalesce(nullif(trim(lower(qual)), ''), '<null>') as qual,
             coalesce(nullif(trim(lower(with_check)), ''), '<null>') as wchk
      from pg_policies
      where schemaname in ('public','storage')
        and permissive = 'PERMISSIVE'
        and (trim(lower(coalesce(qual,''))) = 'true'
          or trim(lower(coalesce(with_check,''))) = 'true')`);
    if (rows.length === 0) ok('no permissive policy with USING(true) or WITH CHECK(true)');
    else
      bad(
        `${rows.length} permissive trivially-true policy(ies)`,
        rows.map((r) => `${r.schemaname}.${r.tablename}.${r.policyname} (qual=${r.qual}, with_check=${r.wchk})`).join('\n    '),
      );
  }

  step('c. every public user-data table has >= 1 policy');
  {
    const { rows } = await db.query(`
      select t.tablename
      from pg_tables t
      left join pg_policies p on p.schemaname = t.schemaname and p.tablename = t.tablename
      where t.schemaname = 'public'
        and ${MIGRATION_TABLES}
      group by t.tablename
      having count(p.policyname) = 0
      order by 1`);
    if (rows.length === 0) ok('all public tables define at least one policy');
    else bad(`${rows.length} table(s) with zero policies`, rows.map((r) => r.tablename).join(', '));
  }

  step('d. storage.objects has restrictive policies (if storage exists)');
  {
    const { rows: exists } = await db.query(`
      select 1 from information_schema.tables
      where table_schema = 'storage' and table_name = 'objects'`);
    if (exists.length === 0) {
      console.log('  ⊘ storage schema absent (plain Postgres) — skipped');
    } else {
      const { rows } = await db.query(`
        select policyname, permissive,
               coalesce(trim(qual),'') as qual,
               coalesce(trim(with_check),'') as wchk
        from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
        order by 1`);
      if (rows.length === 0) {
        bad('storage.objects exists but has zero policies', null);
      } else {
        // "Restrictive" here = at least one policy whose qualifier is not a
        // blanket `true` (an owner- or bucket-scoped predicate). Behavioral
        // correctness of the predicate still needs the Supabase Auth harness.
        const scoped = rows.filter(
          (r) => !(trim_lower(r.qual) === 'true' && trim_lower(r.wchk) === 'true'),
        );
        if (scoped.length === 0) {
          bad('storage.objects policies are all blanket-true', rows.map((r) => r.policyname).join(', '));
        } else {
          ok(`storage.objects has ${rows.length} policy(ies), ${scoped.length} scoped`);
          for (const r of rows) console.log(`    - ${r.policyname} [${r.permissive}]`);
        }
      }
    }
  }

  await db.end();
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  process.exit(2);
}

function trim_lower(s) {
  return (s ?? '').trim().toLowerCase();
}

console.log(failures === 0 ? '\n✅ rls-audit: ALL GREEN (static definitions only — see header)' : `\n❌ rls-audit: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

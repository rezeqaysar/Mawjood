// migrate-check.mjs — Phase B: prove migrations 0001..NNNN apply cleanly
// on a FRESH database, catching structural errors (like the 0029
// `storage.objects` policy bug) before they reach a human's SQL editor.
//
// Usage (CI):
//   DATABASE_URL=postgres://user:pass@host:5432/postgres \
//     node supabase/tests/migrate-check.mjs
//
// What it does:
//   1. drops + recreates a scratch database `mawjood_migtest`
//   2. installs stubs for Supabase-managed pieces that don't exist on
//      vanilla Postgres (see migrate-lib.mjs)
//   3. applies every supabase/migrations/*.sql in filename order, each in
//      its own transaction (like Supabase does)
//   4. runs post-migration assertions on the security-critical objects
import pg from 'pg';
import {
  STUBS,
  PGCRYPTO_FALLBACK,
  ASSERTIONS,
  migrationFiles,
  readMigration,
} from './migrate-lib.mjs';

const TEST_DB = 'mawjood_migtest';

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error('DATABASE_URL is required, e.g. postgres://postgres:postgres@localhost:5432/postgres');
  process.exit(2);
}

const step = (msg) => console.log(`\n── ${msg}`);
let failures = 0;

try {
  const admin = new pg.Client({ connectionString: baseUrl });
  await admin.connect();

  step('recreating scratch database');
  await admin.query(`drop database if exists ${TEST_DB}`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();

  const db = new pg.Client({ connectionString: baseUrl.replace(/\/[^/]*$/, `/${TEST_DB}`) });
  await db.connect();

  step('installing platform stubs');
  await db.query(STUBS);
  try {
    await db.query('create extension if not exists pgcrypto');
    console.log('  pgcrypto: real extension');
  } catch {
    await db.query(PGCRYPTO_FALLBACK);
    console.log('  pgcrypto: stubbed (structure test only)');
  }

  step('applying migrations in order');
  const files = migrationFiles();
  console.log(`  ${files.length} files`);
  for (const f of files) {
    try {
      await db.query('begin');
      await db.query(readMigration(f));
      await db.query('commit');
      console.log(`  ✓ ${f}`);
    } catch (e) {
      await db.query('rollback').catch(() => {});
      failures++;
      console.error(`  ✗ ${f}\n    ${e.message.split('\n')[0]}`);
    }
  }

  step('post-migration assertions');
  for (const a of ASSERTIONS) {
    try {
      const { rows } = await db.query(a.sql);
      const ok = rows[0]?.ok === true;
      console.log(`  ${ok ? '✓' : '✗'} ${a.name}`);
      if (!ok) failures++;
    } catch (e) {
      failures++;
      console.error(`  ✗ ${a.name}\n    ${e.message.split('\n')[0]}`);
    }
  }

  await db.end();
} catch (e) {
  console.error('HARNESS ERROR:', e.message);
  process.exit(2);
}

console.log(failures === 0 ? '\n✅ migrate-check: ALL GREEN' : `\n❌ migrate-check: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);

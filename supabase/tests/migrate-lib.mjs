// migrate-lib.mjs — shared by migrate-check.mjs (pg, CI) and any local
// PGlite-based runner. One source of truth for stubs + assertions.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// MIGRATIONS_DIR override lets us verify a modified copy (e.g. proving the
// harness catches a known-bad migration).
export const MIGRATIONS = process.env.MIGRATIONS_DIR || join(ROOT, 'supabase', 'migrations');

export function neutralize(sql) {
  // pg_cron / pg_net / pgcrypto are Supabase-provided extensions.
  // pg_cron and pg_net cannot be installed on vanilla Postgres and neither
  // is exercised at migrate time, so their lines become no-ops.
  // pgcrypto IS installed by the harness itself (real when the server has
  // it, stubbed otherwise), so the per-file line is dropped to avoid a
  // double-install failing on servers without contrib.
  return sql
    .replace(/create\s+extension\s+if\s+not\s+exists\s+pg_cron\s*;/gi, '-- [stubbed] pg_cron extension (Supabase platform)')
    .replace(/create\s+extension\s+if\s+not\s+exists\s+pg_net\s*;/gi, '-- [stubbed] pg_net extension (Supabase platform)')
    .replace(/create\s+extension\s+if\s+not\s+exists\s+pgcrypto\s*;/gi, '-- [harness] pgcrypto installed by migrate harness');
}

export function migrationFiles() {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
}

export function readMigration(f) {
  return neutralize(readFileSync(join(MIGRATIONS, f), 'utf8'));
}

export const STUBS = `
-- Supabase platform roles (exist on every Supabase project)
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;

-- auth schema (Supabase Auth)
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid());
create or replace function auth.uid() returns uuid
  language sql stable as $$ select null::uuid $$;

-- storage schema (Supabase Storage) — column subset our migrations touch
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false not null
);
insert into storage.buckets (id, name, public)
  values ('voice-notes','voice-notes',true), ('item-photos','item-photos',true)
  on conflict (id) do nothing;
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text,
  name text,
  owner uuid,
  created_at timestamptz default now()
);
create or replace function storage.foldername(name text)
  returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;

-- realtime publication (Supabase platform; 0004 adds tables to it)
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- cron schema (pg_cron stub) — records jobs so we can assert they exist
create schema if not exists cron;
create table if not exists cron._jobs (jobname text primary key, schedule text, command text);
create or replace function cron.schedule(p_jobname text, p_schedule text, p_command text)
  returns bigint language plpgsql as $$
  begin
    insert into cron._jobs(jobname, schedule, command) values (p_jobname, p_schedule, p_command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command;
    return 1;
  end $$;
create or replace function cron.unschedule(p_jobname text)
  returns boolean language plpgsql as $$
  begin
    delete from cron._jobs where jobname = p_jobname;
    return true;
  end $$;
`;

export const PGCRYPTO_FALLBACK = `
  create or replace function gen_salt(t text, i int default 6) returns text
    language sql immutable as $$ select '$2b$10$' || md5(random()::text) $$;
  create or replace function crypt(p text, s text) returns text
    language sql immutable as $$ select '$2b$10$stub$' || md5(p || s) $$;`;

export const ASSERTIONS = [
  {
    name: 'secret_code plaintext column is gone (0028)',
    sql: `select count(*)::int = 0 as ok from information_schema.columns
          where table_schema='public' and table_name='secret_vault' and column_name='secret_code'`,
  },
  {
    name: 'secret_code_hash exists (0028)',
    sql: `select count(*)::int = 1 as ok from information_schema.columns
          where table_schema='public' and table_name='secret_vault' and column_name='secret_code_hash'`,
  },
  {
    name: 'voice-notes + item-photos buckets are private (0029)',
    sql: `select bool_and(public = false) as ok from storage.buckets
          where id in ('voice-notes','item-photos')`,
  },
  {
    name: 'item-photos read policy exists (0029)',
    sql: `select count(*)::int = 1 as ok from pg_policies
          where schemaname='storage' and tablename='objects' and policyname='item_photos_owner_read'`,
  },
  {
    name: 'storage.objects has RLS enabled',
    sql: `select relrowsecurity as ok from pg_class
          join pg_namespace n on n.oid = relnamespace
          where n.nspname='storage' and relname='objects'`,
  },
  {
    name: 'reminder cron jobs scheduled',
    sql: `select count(*)::int >= 1 as ok from cron._jobs
          where jobname in ('mawjood-due-reminders','mawjood-watch-reminders')`,
  },
];

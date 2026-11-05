-- ============================================================
-- FenceFlow -- a record of which SQL files have been applied
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- WHY THIS EXISTS
--   Nothing recorded which of these files had been run. On 2026-11-05 there
--   were 346 supabase_*.sql files on disk and 208 named in
--   supabase/dev/apply-order.txt, so 138 were in no order at all -- and the
--   live database was the only place the answer existed. That is how
--   supabase_r8_deposit_follows_price.sql sat unapplied for six weeks: the
--   money rule March decided on 24 September had never fired once, its
--   function was live, its trigger had never been created, and nothing could
--   say so. r20, r42, r53 and crew_job_scope were in the same state, each
--   found only by querying production.
--
--   A ledger turns "which of these ran?" from an investigation into a select.
--
-- KIND
--   ADDITIVE. One new table. It touches no existing table, no policy and no
--   function, and it stores no customer data -- only file names, checksums
--   and timestamps.
--
-- THE GRANT TRAP THIS FILE IS BUILT AROUND
--   Supabase's default privileges hand every new table in `public` to `anon`
--   and `authenticated` on creation. A ledger that any signed-out caller can
--   read is a list of this system's internals, and one they could WRITE is
--   worse: a forged row makes the runner skip a migration for good. So the
--   grants are revoked explicitly and RLS is enabled with no policy at all,
--   which denies every client outright. postgres and service_role reach it
--   because the table owner and service_role bypass RLS, which is exactly
--   the set of callers that should: the runner, and nothing else.
--
--   PART 2 proves all of that rather than trusting the revokes, and carries
--   canaries so a check that has stopped checking cannot read as a pass.
--
-- ORIGIN, and why it is not a boolean
--   'applied' means the runner executed this file and recorded it.
--   'adopted' means the file was recorded WITHOUT being run, because it
--   predates this ledger and the live schema already reflects it. Adopted is
--   an honest "assumed, not verified" -- it stops the runner re-running two
--   hundred historical files, and it never claims the file was proven.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  the ledger
-- ------------------------------------------------------------------------

create table if not exists public.schema_migrations (
    filename    text        primary key,
    sha256      text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
    origin      text        not null check (origin in ('applied', 'adopted')),
    applied_at  timestamptz not null default now(),
    applied_by  text        not null default current_user,
    notes       text        not null default ''
);

comment on table public.schema_migrations is
    'Which supabase_*.sql files have been applied, and the checksum each was '
    'applied at. Written only by scripts/apply-migrations.mjs. origin=applied '
    'means the runner ran it; origin=adopted means it was recorded without '
    'running because it predates this ledger. See supabase_r63_migration_ledger.sql.';

comment on column public.schema_migrations.sha256 is
    'sha256 of the file as applied. The runner refuses a file whose checksum '
    'has changed since it was recorded: editing an applied migration in place '
    'is how two databases silently stop matching.';

-- No client may read or write this, by privilege AND by RLS -- two layers,
-- because either one alone has been enough to go wrong here before.
revoke all on public.schema_migrations from anon, authenticated;
alter table public.schema_migrations enable row level security;

-- ------------------------------------------------------------------------
-- PART 2  prove it. Every row must read true.
-- ------------------------------------------------------------------------

-- Tries the insert the constraints are supposed to refuse, and says whether it
-- got through. It cleans up after itself rather than leaving probe rows in the
-- ledger, and it answers for the GOOD case too -- a constraint test that
-- refuses everything would otherwise read as a pass.
create function pg_temp.insert_succeeds(p_sha text, p_origin text) returns boolean
language plpgsql as $fn$
declare
    probe text := '__probe__' || p_sha || '/' || p_origin;
begin
    begin
        insert into public.schema_migrations (filename, sha256, origin, notes)
        values (probe, p_sha, p_origin, 'constraint probe');
    exception when others then
        return false;
    end;
    delete from public.schema_migrations where filename = probe;
    return true;
end $fn$;

with checks as (
    select 'the ledger exists' as claim,
           exists (select 1 from information_schema.tables
                    where table_schema = 'public' and table_name = 'schema_migrations') as ok
    union all
    select 'CANARY: the table test can answer false for a table that is not there',
           not exists (select 1 from information_schema.tables
                        where table_schema = 'public' and table_name = 'schema_migrations_xyz')
    union all
    select 'row level security is on',
           (select relrowsecurity from pg_class where oid = 'public.schema_migrations'::regclass)
    union all
    select 'and it has no policy, so RLS denies every client outright',
           not exists (select 1 from pg_policies
                        where schemaname = 'public' and tablename = 'schema_migrations')
    union all
    select 'CANARY: the policy test can find a policy that does exist',
           exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'app_errors')
    union all
    select 'anon holds no privilege on it',
           not exists (select 1 from information_schema.role_table_grants
                        where table_schema = 'public' and table_name = 'schema_migrations'
                          and grantee = 'anon')
    union all
    select 'authenticated holds no privilege on it',
           not exists (select 1 from information_schema.role_table_grants
                        where table_schema = 'public' and table_name = 'schema_migrations'
                          and grantee = 'authenticated')
    union all
    select 'CANARY: the grant test can see a grant that does exist (companies/authenticated)',
           exists (select 1 from information_schema.role_table_grants
                    where table_schema = 'public' and table_name = 'companies'
                      and grantee = 'authenticated')
    union all
    select 'no column-level grant slipped in either',
           not exists (select 1 from information_schema.role_column_grants
                        where table_schema = 'public' and table_name = 'schema_migrations'
                          and grantee in ('anon', 'authenticated'))
    union all
    select 'a bad checksum is refused by the check constraint',
           not pg_temp.insert_succeeds('not-a-sha', 'applied')
    union all
    select 'CANARY: a GOOD checksum is accepted, so the test above is not refusing everything',
           pg_temp.insert_succeeds(repeat('a', 64), 'applied')
    union all
    select 'an unknown origin is refused',
           not pg_temp.insert_succeeds(repeat('b', 64), 'guessed')
)
select claim, ok from checks order by 1;

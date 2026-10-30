-- UNDOES r53. I BUILT THE WRONG TABLE.
--
-- r53 created public.job_assignments to hold more than one crew member on a
-- job, because the owner asked for that and nothing in the database provided
-- it. The table was sound on its own terms and its self-tests passed.
--
-- It was still wrong, because the feature already existed.
--
-- website/dashboard.html has carried the whole thing since September: pickers
-- that add and remove crew, the access-request queue, the calendar chips that
-- name who is on each job, and the "nobody is booked on this day" alert. All
-- of it reads job_assignments with columns `kind` ('CREW' | 'ACCESS') and
-- `ended_at`, and writes through three functions -- set_job_crew,
-- end_job_assignment, decide_job_access. The backend for all of it is
-- supabase_crew_job_scope.sql, 1112 lines written 2026-09-22, which has never
-- been applied. The office hides those sections when the table is absent, by
-- design, so nothing ever looked broken.
--
-- WHY THIS HAS TO BE DROPPED RATHER THAN LEFT ALONE. That file begins with
-- `create table if not exists public.job_assignments`. My table satisfies that
-- test, so the real definition would be SKIPPED: the apply would appear to
-- succeed and leave a table with crew_role and removed_at where the office,
-- the three functions and their foreign keys all expect kind and ended_at.
-- Half-applied, silently -- the worst possible outcome, and entirely of my
-- making. An empty table nothing reads is cheap to remove; a half-applied
-- feature is not.
--
-- Verified before dropping: 0 rows, and it carries crew_role/removed_at
-- rather than kind/ended_at, so there is nothing in it and nothing reads it.
--
-- WHAT STILL HAS TO HAPPEN, and why I did not do it tonight: applying
-- supabase_crew_job_scope.sql narrows what a crew login can see to the jobs
-- it is on. Its own header says so -- "a login with no crew record correctly
-- sees NO jobs once this is applied" -- and on 2026-09-21 no employee in
-- production was linked to a login. Applying it unattended could leave the
-- crew opening the app to an empty list. That is the owner's call to make
-- with his crew in front of him, not a 4am decision. See
-- docs/CREW_ON_A_JOB_PENDING.md.

do $$
declare n int; wrong int;
begin
  if not exists (select 1 from information_schema.tables
                  where table_schema='public' and table_name='job_assignments') then
      raise notice 'r56: job_assignments is already absent; nothing to undo';
      return;
  end if;

  select count(*) into n from public.job_assignments;
  select count(*) into wrong from information_schema.columns
   where table_schema='public' and table_name='job_assignments'
     and column_name in ('crew_role', 'removed_at');

  -- REFUSES TO DROP THE REAL ONE. If this runs after
  -- supabase_crew_job_scope.sql has been applied, the table in front of it is
  -- the right one and must be left exactly where it is.
  if wrong = 0 then
      raise notice 'r56: job_assignments does not carry r53''s columns -- this is '
        'the real table from supabase_crew_job_scope.sql. Left untouched.';
      return;
  end if;

  -- And never drop one that somehow has data in it.
  if n <> 0 then
      raise exception 'r56 REFUSED: r53''s job_assignments holds % rows. Nothing was '
        'dropped. Move them by hand before running this.', n;
  end if;

  drop table public.job_assignments;
  raise notice 'r56 ok: r53''s empty job_assignments dropped, so crew_job_scope can create the real one';
end $$;

select 'r53 table is gone, and the real one can now be created' as check,
       not exists (
         select 1 from information_schema.columns
          where table_schema='public' and table_name='job_assignments'
            and column_name in ('crew_role', 'removed_at')
       ) as pass;

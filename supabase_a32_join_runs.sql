-- ============================================================
-- FenceFlow -- joining runs (PART 1) and, optionally, the transition run (PART 2)
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- STATUS: WRITTEN, NOT APPLIED. Nothing has run this. Apply to the DEV project first
-- (DEV_ENVIRONMENT.md), read the proof rows at the bottom, and only then to production.
-- Spec and reasoning: docs/JOINING_RUNS.md. Tests that wait for it:
-- tests/a32-join-posts.test.mjs (PART 1) and tests/a32-join-transition.test.mjs (PART 2).
--
-- READ FIRST: THE STORAGE QUESTION IS SETTLED. THIS FILE IS THE ANSWER.
--   There were two designs for where a join lives: these COLUMNS, and a Room table
--   (run_joins, app/.../data/RunJoin.kt, schema 48). Decided 1 Oct 2026 in favour of the
--   columns, with the reasons and the cost of retiring the table written out in
--   docs/JOINING_RUNS.md section 11.1. Nothing else changes in this file as a result: it
--   was already the columns design and it is still unapplied.
--   The table has NOT been deleted yet, and must not be deleted as part of applying this.
--   It is wired into AppDatabase.kt and Repository.kt and shipped in build 568, so removing
--   it is a Room migration and a source change, not a file deletion -- 11.1 says exactly
--   what it costs. Until then it is inert: nothing prices from it and no screen calls it.
--
-- KIND
--   ADDITIVE ONLY. Columns on public.fence_runs. No row is read, rewritten or deleted, no
--   policy, grant, trigger or function is touched. Every existing run reads '' / '' (/ false),
--   which is exactly "not joined" -- today's behaviour -- so a price already quoted cannot
--   move because this file ran.
--
--   NO BACKFILL, on purpose. Runs whose end points already coincide are NOT joined for
--   the owner. A join removes a post from a price; doing it behind his back would change
--   quotes he has sent. (Probed read-only on 2026-10-01: of 13 drawn runs in 9 jobs, no
--   two meet at all, so there is nothing to backfill and nothing hidden.)
--
-- WHY TEXT AND NOT A NULLABLE uuid
--   The phone's JSON has explicitNulls = false (EntitySync.kt), so a Kotlin null is LEFT OUT
--   of the upsert body and the column keeps its old value. A nullable "joined to" column
--   could be SET from the phone and never CLEARED: un-joining on the phone would leave the
--   office pricing the runs as joined. The same trap is documented on deleted_at in
--   EntitySync.kt. A NOT NULL text column whose "nothing" is '' travels as an explicit
--   value in both directions, like points_encoded, gates_encoded and suppressed_roles.
--
-- WHY NO CHECK CONSTRAINT
--   Upserts to fence_runs are batched; one row the table refuses fails the WHOLE batch and
--   no run for that company syncs (the same way one duplicate estimate-line id once
--   stopped a job's estimate reaching the cloud). So the database accepts any text and the
--   READERS validate: price-job and the phone both treat a value that is not a uuid, or that
--   names no run in the job, as '' (not joined). Invalid data fails toward today's price.
--
-- WHAT THE COLUMNS MEAN (docs/JOINING_RUNS.md sections 1 and 4)
--   start_joint / end_joint  The joint this run's FIRST / LAST point stands at: a uuid the
--                            phone generates, or '' for a free end. Runs whose ends carry the
--                            same joint id share ONE post. There is no joints table: a joint
--                            has no attributes, only members. A T is three ends with one id.
--   is_transition (PART 2)   This run is the stepped or raked bay between two heights. Its
--                            panel line is the TRANSITION_PANEL catalog item, not PANEL.
--
-- NOT IN THIS FILE, and the order matters (docs/JOINING_RUNS.md 7.2 and 11.2):
--   THE FOLLOW-UP FILE NOW EXISTS: supabase_a56_join_reapproval_fingerprint.sql, also
--   UNAPPLIED. It must run AFTER this one (it names these columns, and a function body that
--   names a column that does not exist is refused at CREATE time). It has two parts:
--   * PART A -- the re-approval fingerprint. reapp_row_takeoff does not read these columns
--     today (verified live from pg_proc, 1 Oct 2026: the text 'start_joint' appears nowhere
--     in it, nor in reapp_run_takeoff, reapp_job_takeoff or reapp_run_snapshot), and
--     reapp_on_run_change returns early when a run's before and after fingerprints match.
--     So joining two runs on an APPROVED quote changes its post count and the approval
--     stands. Apply PART A before the join UI ships. The last proof row below is the gap.
--   * PART B -- reapp_run_snapshot does not carry them, so a restore puts yesterday's points
--     back under today's joints. PART B must NOT be applied until the phone's
--     parseRunSnapshot and the office's reapprovalRestoreState accept a seven-part snapshot;
--     both refuse anything but 3 or 6 parts today.
--
-- To undo: the columns can be dropped, but that discards every join anyone has made -- do not,
--   once the join UI has shipped.
-- ============================================================

-- ---------- PART 1. joining: the two joint columns ------------------------
alter table public.fence_runs add column if not exists start_joint text not null default '';
alter table public.fence_runs add column if not exists end_joint   text not null default '';

comment on column public.fence_runs.start_joint is
  'Joint id (uuid text) at this run''s first point, or empty for a free end. Runs whose ends share an id share one post. Readers treat anything that is not a uuid naming a run in this job as empty. See docs/JOINING_RUNS.md.';
comment on column public.fence_runs.end_joint is
  'Joint id (uuid text) at this run''s last point, or empty for a free end. See start_joint.';

-- ---------- PART 2. the transition run: ONLY IF that item is being built --------
-- CONTESTED. The request this was written for asked for a transition item; other work written the
-- same day records an owner decision that a 6-to-4 fence is priced as the 6 ft fence, with no item,
-- no role and no flag (docs/JOINING_RUNS.md section 6). Joining does not depend on this column.
-- Confirm with the owner, and if the item is not wanted DELETE THIS PART and the last two proof
-- rows before applying anything.
alter table public.fence_runs add column if not exists is_transition boolean not null default false;

comment on column public.fence_runs.is_transition is
  'True for the stepped or raked bay between two heights: its panel line is the TRANSITION_PANEL catalog item. Honoured for VINYL, ALUMINUM and ORNAMENTAL_IRON only.';

-- ---------- proof. Every row must read true. ------------------------------
-- Read-only: each is a plain SELECT, no write, no temp table.

select 'PART 1: start_joint, end_joint are text NOT NULL default empty' as check,
       (select count(*) = 2
          from information_schema.columns
         where table_schema = 'public' and table_name = 'fence_runs'
           and column_name in ('start_joint', 'end_joint')
           and data_type = 'text' and is_nullable = 'NO'
           and column_default = '''''::text') as ok
union all
-- Positive control first: there must be rows to test, or the next line is a true about nothing.
select 'there are runs to test this against (a true below is not an empty table)',
       (select count(*) > 0 from public.fence_runs)
union all
select 'PART 1: no existing run is joined (the file changed no price)',
       (select coalesce(bool_and(start_joint = '' and end_joint = ''), true)
          from public.fence_runs)
union all
-- CANARY: the test above must be able to fail. The same predicate, run on a planted row that
-- DOES carry a joint id, must read false.
select 'CANARY: the same test on a planted joined row reads false (so it can fail)',
       (select bool_and(start_joint = '' and end_joint = '')
          from (values ('a32a0001-0000-4000-8000-000000000001'::text, ''::text))
               as t(start_joint, end_joint)) = false
union all
-- KNOWN GAP, stated as a check so it is read on every run of this file. true = the gap is still
-- open (the fingerprint does not read the new columns); it turns false once
-- supabase_a56_join_reapproval_fingerprint.sql has been applied. DO NOT SHIP THE JOIN UI while
-- this still reads true -- that is the whole reason the row is here.
select 'KNOWN GAP (docs/JOINING_RUNS.md 7.2): the re-approval fingerprint does not read the joint columns yet -- apply supabase_a56_join_reapproval_fingerprint.sql',
       (select bool_and(position('start_joint' in prosrc) = 0 and position('end_joint' in prosrc) = 0)
          from pg_proc
         where pronamespace = 'public'::regnamespace
           and proname in ('reapp_run_takeoff', 'reapp_row_takeoff', 'reapp_run_snapshot'))
union all
-- PART 2 only. Catalog-only, so it reads false (not an error) when PART 2 was left out, which
-- is the right answer if the item is not being built.
select 'PART 2 (only if applied): is_transition is boolean NOT NULL default false',
       (select count(*) = 1
          from information_schema.columns
         where table_schema = 'public' and table_name = 'fence_runs'
           and column_name = 'is_transition'
           and data_type = 'boolean' and is_nullable = 'NO'
           and column_default = 'false');

-- ============================================================
-- FenceFlow -- joining runs (PART 1) and, optionally, the transition run (PART 2)
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- STATUS: WRITTEN, NOT APPLIED. Nothing has run this. Apply to the DEV project first
-- (DEV_ENVIRONMENT.md), read the proof rows at the bottom, and only then to production.
-- Spec and reasoning: docs/JOINING_RUNS.md. Tests that wait for it:
-- tests/a32-join-posts.test.mjs (PART 1) and tests/a32-join-transition.test.mjs (PART 2).
--
-- READ FIRST: THIS IS ONE OF TWO DESIGNS FOR WHERE A JOIN LIVES.
--   This file is the COLUMNS design: two text columns on fence_runs. The same fact is also
--   recorded as ROWS in app/.../data/RunJoin.kt (a Room table, run_joins, schema 48). Both
--   cannot be the home of a join, and nothing syncs either yet, so choosing now is free and
--   choosing later is a migration. docs/JOINING_RUNS.md section 1.6 compares them and
--   recommends this one. If the table is chosen instead, do NOT apply this file.
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
-- NOT IN THIS FILE, and the order matters (docs/JOINING_RUNS.md 7.2):
--   * reapp_row_takeoff / reapp_run_takeoff (the re-approval fingerprint) do not read these
--     columns yet. Until a follow-up file teaches them, joining two runs on an APPROVED quote
--     would change its posts without withdrawing the approval. Do not ship the join UI before
--     that file. The last proof row below states this gap so it cannot be forgotten.
--   * reapp_run_snapshot (drawing versions) does not carry them, so a restore leaves the
--     current joints beside restored points. Its readers (the phone's parseRunSnapshot and the
--     office's reapprovalRestoreState, both strict about length) must change first.
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
-- open (the fingerprint does not read the new columns); it turns false once the follow-up file lands.
select 'KNOWN GAP (docs/JOINING_RUNS.md 7.2): the re-approval fingerprint does not read the joint columns yet',
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

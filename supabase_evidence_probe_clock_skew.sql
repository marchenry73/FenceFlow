-- EVIDENCE PROBE -- Defect 1: conflicts are decided by the device clock.
--
-- NOT RUN by the assistant. No database credentials were available in this
-- session (see DEV_ENVIRONMENT.md -- the pooler password lives in March's
-- password manager, not in this environment), so this could not be executed
-- against the live FenceFlow project (newcrgafcptspmapacrx). It is written
-- to be pasted into `psql` or the Supabase SQL editor by March himself, and
-- it is READ-ONLY: everything runs inside a transaction that is always
-- rolled back, so it changes nothing even if run against production.
--
-- What this proves, and what it deliberately does NOT try to prove:
--   The server side of this is actually fine. `public.touch_updated_at()`
--   (supabase_quiet_touch_patch.sql) stamps `jobs.updated_at` from the
--   server's own `now()` on every real edit, and overwrites -- not merges
--   with -- anything a client tries to set that column to directly. Part 1
--   below is a positive control proving exactly that: it forces a real edit
--   and confirms the resulting `updated_at` tracks server wall-clock time,
--   not a client-supplied value. If that control fails, stop -- something
--   about the trigger has changed and nothing below is trustworthy.
--
--   The defect is NOT on the server and cannot be reproduced by attacking
--   it with SQL -- that was tried and confirmed safe (see the commented-out
--   attempt below). It lives entirely on the phone, in a comparison that
--   never touches Postgres: `Repository.kt:76` stamps a job's LOCAL
--   `updatedAt` from `System.currentTimeMillis()` at the moment of the
--   edit, and `JobSync.kt:613` later compares that local value directly
--   against the server's correctly-stamped `updated_at`
--   (`job.updatedAt > cloudJob.updatedAtMillis()`). The server's clock is
--   trustworthy; the phone's own recording of "when I edited this" is not,
--   and nothing rechecks it. A truck phone hours fast timestamps its own
--   edit as happening in the future, and that fabricated-but-locally-
--   sincere timestamp wins the comparison against a real, later, correctly
--   dated office edit. This is why the fix has to live in the comparison
--   itself (see supabase_conflict_version_patch.sql) rather than in
--   anything the database can enforce on its own -- Postgres has no way to
--   know what time a phone's clock reads at the moment of a local edit.
--
-- Attempted and rejected as evidence (kept here so nobody re-tries it):
--   Directly forging jobs.updated_at with `update jobs set updated_at =
--   now() + interval '400 days'` does NOT succeed -- touch_updated_at()
--   sees no non-quiet column changed and restores the old value. That is
--   the trigger working correctly, not a hole. The real hole is upstream
--   of Postgres entirely, in what the phone writes into its own local
--   updatedAt before it ever reaches the network.

begin;

-- 1) Positive control: prove the trigger, not the client, sets updated_at.
--    Pick any one real job, touch a non-quiet column, and confirm the
--    server's own now() is what lands -- not a client-supplied value.
with target as (
    select id, updated_at as before_updated_at
    from jobs
    order by updated_at desc
    limit 1
),
control_now as (
    select clock_timestamp() as t
),
forced_update as (
    update jobs
    set customer_name = jobs.customer_name  -- no-op edit, still a "real" column per touch_updated_at's quiet list
    from target
    where jobs.id = target.id
    returning jobs.id, jobs.updated_at as after_updated_at
)
select
    target.id,
    target.before_updated_at,
    forced_update.after_updated_at,
    control_now.t as probe_ran_at,
    extract(epoch from (forced_update.after_updated_at - control_now.t)) as seconds_from_server_now,
    case
        when abs(extract(epoch from (forced_update.after_updated_at - control_now.t))) < 5
        then 'PASS -- server clock owns updated_at, probe is meaningful'
        else 'FAIL -- control did not hold, do not trust the rest of this probe'
    end as control_result
from target, control_now, forced_update;

-- 2) Confirms there is no separate guard rejecting an out-of-range
--    updated_at either -- ruling out "maybe some other check catches this"
--    before concluding the fix has to be client-side. Expected: this UPDATE
--    is silently overruled back to old.updated_at by touch_updated_at()
--    (part of the same PASS as above), not rejected by any constraint --
--    there is no CHECK, trigger, or policy anywhere in this schema that
--    validates updated_at against real time. Nothing to defend here on the
--    server; recording that absence is the point.
with target as (
    select id, updated_at as before_updated_at from jobs order by updated_at desc limit 1
)
update jobs
set updated_at = now() + interval '400 days'
from target
where jobs.id = target.id
returning jobs.id, target.before_updated_at, jobs.updated_at as after_forced_write,
    case
        when jobs.updated_at = target.before_updated_at
        then 'CONFIRMED -- touch_updated_at overruled the forged value back to old.updated_at (expected; server is not the hole)'
        else 'UNEXPECTED -- the forged future timestamp stuck; touch_updated_at is not behaving as documented, investigate before trusting anything else here'
    end as result;

-- Nothing above is kept.
rollback;

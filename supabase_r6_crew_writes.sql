-- ============================================================
-- FenceFlow -- a crew phone writes field work, and only field work
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   ADDITIVE           crew_writable_job_columns() (new).
--   FUNCTION-REPLACING crew_save_job() -- the LIVE body plus one block at a
--                      named anchor; nothing else in it changes.
--   TRIGGER-RENAMING   protect_customer_identity -> 00_protect_customer_identity
--                      (ALTER TRIGGER ... RENAME: same function, same event,
--                      only the firing position moves).
--   No row is deleted or rewritten; no RLS policy changes.
--
-- APPLY ORDER
--   * After supabase_r6_price_stability.sql (crew_save_job drops
--     job_money_columns(), which that file extends with accepted_total --
--     read at run time, so either order works, but that is the tested one).
--   * BEFORE supabase_crew_job_scope.sql, as that file asks. Either order is
--     safe: crew_save_job is patched here the way that file patches it (the
--     LIVE body, at the same sync_id anchor, which is left in place), so the
--     second file to run keeps the first one's lines.
--   * With the app release whose CREW_WRITABLE_JOB_KEYS (cloud/SyncScope.kt)
--     is this same list. JobSyncCrewDoorTest reads the array below and fails
--     the moment the two differ -- change both together.
--
-- WHAT WAS WRONG (diag 2026-09-21)
--
--   1. crew_save_job wrote every key the phone sent, minus money and the
--      contract columns. The phone sent its WHOLE local row, so a crew phone
--      holding an older copy of a job wrote that copy back: the office's
--      notes, HOA and permit details, waste percent, template, status.
--      Proved in a rolled-back transaction as the crew login (notes, hoa_name
--      and permit_number all came back '' on 10b0407f). It also sent
--      priced_by = '' and pricing_engine_version = '' on every push (CloudJob
--      defaulted them to "", and encodeDefaults sends a non-null default) --
--      it happened for real on 10b0407f today: priced_at 19:00:08 with both
--      blanked -- and a blank priced_by makes an office price read as "not
--      office-priced", which the next phone recompute then overwrites.
--      Now a caller WITHOUT EDIT_JOBS (crew, foreman) can write only
--      crew_writable_job_columns(): finishing the job, the held-up report,
--      the locate ticket, the closing sign-off and the survey they drew --
--      what the crew screens actually edit (CrewJobViewModel, JobBlockedSection,
--      LocateSection, OverrunSection, the teardown feet field, SurveyViewModel).
--      A foreman (SCHEDULE_AND_ASSIGN) may also send the duration, the date
--      and the assignee, as the phone does only when has_permission says so.
--      (The first version of this file dropped the date and assignee for
--      foremen too, taking rescheduling and reassigning away from the one
--      role that exists to do them; crew_strip_assignment in
--      supabase_crew_job_scope.sql keeps both for SCHEDULE_AND_ASSIGN.)
--      status may only become COMPLETED -- a stale local DRAFT or ACCEPTED
--      must never roll a job back. production_stage is not here: it has its own door,
--      set_production_stage(), and the phone never sends it on a row push.
--      Callers WITH EDIT_JOBS are untouched (they hold SEE_MONEY and write
--      the base table anyway).
--
--   2. A reverted crew edit still moved the edit clock. Postgres fires
--      same-event BEFORE triggers in name order, and jobs_touch_updated_at
--      sorted before protect_customer_identity: the clock saw the crew's
--      customer name, stamped updated_at = now(), and only then did the
--      identity hold put the old name back. An update that changed nothing
--      but the clock -- so every phone pulled the row, and the crew phone's
--      own pull wrote the server's blank name over it (job 4598150b,
--      "on the crew phone I opened a job and it erased the name"). Renamed
--      with the 00_ prefix the other holds already use, so it runs before
--      the clock, which then compares the row as it will really be written.
--
-- ALSO NEEDS DOING when this lands (files this one does not own):
--   supabase_p2_customer_identity_email.sql's self-check and the probe files
--   look the trigger up by NAME ('protect_customer_identity'); change them to
--   `tgfoid = 'public.protect_customer_identity()'::regprocedure`, or
--   re-running them fails. supabase_views_and_admin_patch.sql recreates the
--   old name if re-run; PART 3 below drops such a duplicate on its next run.
--   supabase/dev/fingerprint-prod.txt names the old trigger; regenerate it.
--
-- Proof: supabase_r6_price_crew_probe.sql and tests/r6-price-crew.test.mjs.
-- ============================================================


-- ------------------------------------------------------------------------
-- PART 1 -- the list
-- ------------------------------------------------------------------------
-- The ONLY jobs columns a caller without EDIT_JOBS may write through
-- crew_save_job. A verbatim copy of CREW_WRITABLE_JOB_KEYS in
-- app/src/main/java/com/fenceestimator/app/cloud/SyncScope.kt; the scheduler
-- keys (CREW_SCHEDULER_JOB_KEYS: duration, date, assignee) are added in
-- crew_save_job for SCHEDULE_AND_ASSIGN only. Keep one name per quoted
-- string: the app's test parses this array.
create or replace function public.crew_writable_job_columns()
 returns text[]
 language sql
 immutable
 set search_path to 'public'
as $function$
    select array[
        'status',
        'blocked_reason', 'blocked_at', 'customer_must_clear', 'customer_notified_at', 'overrun_reason',
        'locate_ticket_no', 'locate_called_at', 'locate_dig_after', 'locate_expires_at', 'locate_notes',
        'teardown_feet', 'final_sign_off_storage_path', 'final_sign_off_at',
        'survey_storage_path', 'calibration_pixels_per_foot', 'calibration_known_feet',
        'grid_extent_ft', 'grid_feet_per_square', 'site_lat', 'site_lon'
    ]::text[]
$function$;

revoke execute on function public.crew_writable_job_columns() from public, anon;
grant  execute on function public.crew_writable_job_columns() to authenticated, service_role;


-- ------------------------------------------------------------------------
-- PART 2 -- crew_save_job writes only that list for crew
-- ------------------------------------------------------------------------
-- The LIVE body is read and one block is inserted directly after its
-- "sync_id required" check -- the same anchor supabase_crew_job_scope.sql
-- uses, left intact so that file still finds it exactly once. Everything
-- else stays as it is: sign-in, company, suspension and permission checks,
-- the money / contract / reapproval drop_keys, "deleted_at is null".
-- Filtering `clean` before the column lookup means a dropped key is simply
-- absent, so its column is left alone -- the function's existing rule for
-- an omitted key. Idempotent: a body that already uses the list is left
-- alone.
do $crewjob$
declare
    d text;
    n int;
    anchor constant text :=
        $re$(if clean->>'sync_id' is null then\s+raise exception 'sync_id required';\s+end if;)$re$;
begin
    d := pg_get_functiondef('public.crew_save_job(jsonb)'::regprocedure);
    if position('crew_writable_job_columns' in d) > 0 then
        -- Already patched. A body from the first version of this block lets
        -- a scheduler send only the duration; widen that one condition in
        -- place, and change nothing else.
        if position('''scheduled_date''' in d) = 0 then
            -- Plain text, not a pattern: replace() and a count of the exact
            -- first-version condition.
            n := (length(d) - length(replace(d, $old$e.key in ('estimated_duration_hours', 'duration_manually_set')$old$, '')))
                 / length($old$e.key in ('estimated_duration_hours', 'duration_manually_set')$old$);
            if n <> 1 then
                raise exception 'crew_save_job: the scheduler condition to widen appears % times, not once. '
                                'Not touched -- merge PART 2 by hand.', n;
            end if;
            execute replace(d,
                $old$e.key in ('estimated_duration_hours', 'duration_manually_set')$old$,
                $new$e.key in ('estimated_duration_hours', 'duration_manually_set',
                          'scheduled_date', 'assigned_employee_sync_id', 'assigned_employee_id')$new$);
        end if;
        return;
    end if;
    select count(*) into n from regexp_matches(d, anchor, 'g');
    if n <> 1 then
        raise exception 'crew_save_job: the sync_id check to anchor on appears % times, not once. '
                        'Not touched -- merge PART 2 by hand.', n;
    end if;
    d := regexp_replace(d, anchor, $rep$\1

    -- r6_crew_writes. A caller who may not edit jobs writes field work
    -- only (crew_writable_job_columns); a foreman (SCHEDULE_AND_ASSIGN) may
    -- also send the duration, the date and who is on it -- scheduling is
    -- what that role is for, and crew_strip_assignment keeps who-and-when
    -- for it too. The phone used to send its whole local row and this wrote
    -- all of it, so a crew phone's older copy blanked the office's notes,
    -- HOA and permit details and priced_by (10b0407f, 2026-09-21).
    if not public.has_permission('EDIT_JOBS') then
        select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into clean
          from jsonb_each(clean) e
         where e.key = 'sync_id'
            or e.key = any (public.crew_writable_job_columns())
            or (e.key in ('estimated_duration_hours', 'duration_manually_set',
                          'scheduled_date', 'assigned_employee_sync_id', 'assigned_employee_id')
                and public.has_permission('SCHEDULE_AND_ASSIGN'));
        -- Crew may finish a job. A stale local DRAFT or ACCEPTED must never
        -- move it anywhere else, so any other status is dropped, not refused.
        if clean ? 'status' and clean->>'status' is distinct from 'COMPLETED' then
            clean := clean - 'status';
        end if;
    end if;$rep$);
    execute d;
end $crewjob$;

-- CREATE OR REPLACE keeps the grants; restated so this file alone says who
-- may call it.
revoke execute on function public.crew_save_job(jsonb) from public, anon;
grant  execute on function public.crew_save_job(jsonb) to authenticated, service_role;


-- ------------------------------------------------------------------------
-- PART 3 -- the identity hold runs before the edit clock
-- ------------------------------------------------------------------------
-- A rename, not a drop and create: the hold is never absent, not even for
-- the length of this statement. Idempotent across the states a re-run can
-- meet: old name only (rename it), new name only (nothing to do), both
-- (supabase_views_and_admin_patch.sql re-run after this recreated the old
-- one -- drop that duplicate; the renamed trigger runs the same function),
-- neither (create it).
do $rename$
declare
    has_old boolean;
    has_new boolean;
begin
    select exists (select 1 from pg_trigger where tgrelid = 'public.jobs'::regclass
                      and tgname = 'protect_customer_identity' and not tgisinternal),
           exists (select 1 from pg_trigger where tgrelid = 'public.jobs'::regclass
                      and tgname = '00_protect_customer_identity' and not tgisinternal)
      into has_old, has_new;
    if has_old and not has_new then
        alter trigger protect_customer_identity on public.jobs rename to "00_protect_customer_identity";
    elsif has_old and has_new then
        drop trigger protect_customer_identity on public.jobs;
    elsif not has_new then
        create trigger "00_protect_customer_identity"
            before update on public.jobs
            for each row execute function public.protect_customer_identity();
    end if;
end $rename$;


-- ------------------------------------------------------------------------
-- Self-check. Fails loudly, and the whole file rolls back with it.
-- ------------------------------------------------------------------------
do $check$
declare
    n int;
    nm text;
    d text;
    bad text[];
begin
    -- Every listed column is a real jobs column, and none is money or the
    -- acceptance signature (the completion sign-off pair is crew work).
    select array_agg(c) into bad
      from unnest(public.crew_writable_job_columns()) c
     where not exists (select 1 from information_schema.columns ic
                        where ic.table_schema = 'public' and ic.table_name = 'jobs'
                          and ic.column_name = c)
        or c = any (public.job_money_columns())
        or (c = any (public.job_contract_columns())
            and c <> all (array['final_sign_off_storage_path', 'final_sign_off_at']));
    if bad is not null then
        raise exception 'crew_writable_job_columns() lists columns crew must not write, or that do not exist: %', bad;
    end if;

    d := pg_get_functiondef('public.crew_save_job(jsonb)'::regprocedure);
    if position('crew_writable_job_columns' in d) = 0 then
        raise exception 'crew_save_job() does not apply crew_writable_job_columns()';
    end if;
    -- supabase_crew_job_scope.sql must still find its anchor exactly once.
    select count(*) into n
      from regexp_matches(d, $re$if clean->>'sync_id' is null then\s+raise exception 'sync_id required';\s+end if;$re$, 'g');
    if n <> 1 then
        raise exception 'crew_save_job(): the sync_id check supabase_crew_job_scope.sql anchors on now appears % times', n;
    end if;

    select count(*), min(t.tgname) into n, nm
      from pg_trigger t
     where t.tgrelid = 'public.jobs'::regclass and not t.tgisinternal
       and t.tgfoid = 'public.protect_customer_identity()'::regprocedure;
    if n <> 1 then
        raise exception 'expected exactly one identity trigger on jobs, found %', n;
    end if;
    if nm collate "C" >= 'jobs_touch_updated_at' collate "C" then
        raise exception 'identity trigger % still fires after jobs_touch_updated_at', nm;
    end if;
end $check$;

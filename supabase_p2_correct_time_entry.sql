-- ---------------------------------------------------------------------------
-- A SHIFT CORRECTION MADE ON A PHONE WAS THROWN AWAY, AND PAYROLL PAID THE
-- UNCORRECTED HOURS.
-- ---------------------------------------------------------------------------
-- TimeApprovalScreen's review dialog has editable Start and End fields. A
-- foreman -- FOREMAN holds APPROVE_TIME, and a foreman is a phone user, not an
-- office user -- fixes a clock left running overnight, 14 hours down to 8,
-- taps Approve and is told "Shift approved."
--
-- Nothing of the correction ever left the handset:
--
--   * Repository.approveTimeEntry writes the corrected times into Room.
--   * EntitySync.pushTimeEntries sends every finished shift TWICE. Pass 1 is
--     insert-only (ignoreDuplicates, i.e. ON CONFLICT DO NOTHING) and carries
--     started_at/ended_at -- but the cloud already holds this row, so it is a
--     no-op. Pass 2 is the update, and it deliberately omits started_at,
--     ended_at and the three break columns (toCloud(includeTimes = false),
--     dropped from the JSON entirely by explicitNulls = false).
--   * So the corrected clock cannot reach the cloud at all. That split is not
--     a bug -- it is what stops a phone re-asserting its ORIGINAL times over
--     an office correction. "The clock is written exactly once, by the phone
--     that recorded it."
--   * Then the next pull writes the cloud's uncorrected times back over the
--     local row (EntitySync's time-entries merge sets startedAt/endedAt
--     straight from the cloud row, with no `?: existing` fallback).
--
-- The office pays from the cloud row. So: correction applied, "Approved"
-- shown, correction silently reverted, 14 hours paid. Same shape as the
-- endpoint-passes-chain-broken class -- the call succeeded, the chain did not
-- carry the value.
--
-- ---------------------------------------------------------------------------
-- WHY AN RPC RATHER THAN A THIRD PUSH BATCH
-- ---------------------------------------------------------------------------
-- The other candidate fix was a third push batch carrying times only for rows
-- the phone has flagged as corrected. It is bigger, it adds a fourth state to
-- a sync path that already has three, and -- decisively -- it records nothing.
-- A bare UPDATE of started_at by a phone produces a shift whose hours changed
-- with no original to compare against and no reason given, which is exactly
-- the state dispute_my_shift assumes cannot happen.
--
-- This RPC instead makes the phone use the shape the office already uses: the
-- correction sheet's write, with preserve_original_shift() deriving
-- original_started_at / original_ended_at / corrected_at / corrected_by, plus
-- a reason in the corrector's own words. One correction path, one audit trail,
-- and the crew member's acknowledge_my_shift / dispute_my_shift door keeps
-- working against it unchanged.
--
-- ---------------------------------------------------------------------------
-- THE PERMISSION, AND WHY IT IS THIS ONE
-- ---------------------------------------------------------------------------
-- APPROVE_TIME, always -- not "unless it is your own shift".
--
-- supabase_sec_time_entries_write_permission.sql is the model and this file
-- deliberately agrees with it column for column:
--
--   started_at / ended_at on somebody else's shift  -> APPROVE_TIME
--   correction_reason, ALWAYS, even on your own     -> APPROVE_TIME
--
-- Because this function writes correction_reason on every correction it makes,
-- APPROVE_TIME is already the answer for every row it can touch, own shift or
-- not. Demanding it unconditionally is therefore not a new rule, it is that
-- rule stated once instead of twice. Held by OWNER, MANAGER and FOREMAN, and
-- by nobody else -- CREW, SALES and ACCOUNTANT are all refused, as is a
-- MANAGER whose permission_overrides take APPROVE_TIME away.
--
-- SECURITY DEFINER is what makes the check load-bearing rather than decorative.
-- Inside a definer function current_user is the owner, so
-- guard_time_entry_write_permission() returns early (that early return is
-- correct and is what lets acknowledge_my_shift keep working) and RLS is not
-- the boundary either. Everything this function is allowed to do, it has to
-- decide for itself. Hence: an explicit auth.uid() test, an explicit
-- has_permission('APPROVE_TIME') test, and an explicit company pin on the row
-- it looks up.
--
-- Deliberately NO "auth.uid() is null" escape hatch, and no service_role
-- bypass. auth.uid() is null for an anonymous caller too, so a hatch there
-- hands payroll editing to exactly the people it is meant to exclude. The
-- null test here REFUSES; it never waves anything through.
--
-- Deliberately NO is_platform_admin bypass. A platform admin correcting a
-- customer's payroll figure by hand is not a thing this product does, and
-- current_company_id() already scopes the lookup to the caller's own company,
-- so an admin of another company simply sees no such shift.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DELIBERATELY DOES NOT DO
-- ---------------------------------------------------------------------------
--   * It does not approve anything. approved_at / approved_by / rejected_at
--     stay with guard_time_entry_approval(), which already demands
--     APPROVE_TIME and already says so in its own sentence. Two guards on one
--     column would only make the error message a lottery, and the phone's
--     existing approve path is unchanged.
--   * It does not touch break_minutes, the worker, the job, hourly_rate or
--     the review note. A correction sheet that quietly moved the worker would
--     need SCHEDULE_AND_ASSIGN as well; this door is the clock only.
--   * It does not touch correction_seen_at / correction_disputed_at /
--     dispute_note. Those are the answer of the person being paid, and
--     bumping corrected_at (which preserve_original_shift does) is already
--     what makes acknowledge_my_shift treat the correction as unseen again.
--   * It refuses a running shift. There is no finish time to correct yet, and
--     preserve_original_shift has a specific carve-out for old.ended_at IS
--     NULL that a correction has no business tripping.
--   * It refuses a blank reason. The crew member reads this, and it is what
--     settles a dispute; dispute_my_shift refuses a wordless dispute for the
--     same reason.
--   * A correction that moves neither time writes NOTHING and says so. Writing
--     correction_reason on its own would stamp a shift as corrected while the
--     hours it was paid on never changed, which is a lie in the audit trail --
--     and because preserve_original_shift only stamps corrected_at when a time
--     actually moves, it would be a lie with no date on it.
--
-- ---------------------------------------------------------------------------
-- WHAT THE CALLER GETS BACK, AND WHY IT IS THE SAVED ROW
-- ---------------------------------------------------------------------------
-- jsonb, always, carrying `outcome` plus the values actually stored. The whole
-- defect being fixed here is a screen showing a figure the database does not
-- hold, so the phone does not get to assume what was saved -- it reads it back
-- and writes THAT into Room. `rows` is the affected-row count, returned rather
-- than inferred, because "no error" is not proof that anything changed.
--
--   outcome = 'corrected'  the row moved. started_at/ended_at/original_*/
--                          corrected_at/correction_reason are what is stored.
--   outcome = 'unchanged'  the times sent match what is already there.
--   outcome = 'not_found'  this company has no such shift (not yet synced, or
--                          soft-deleted). NOT an error: a shift the cloud has
--                          never seen will go up carrying the corrected times
--                          on the insert pass, which is the one pass that does
--                          send the clock. The phone says so on screen rather
--                          than claiming the correction landed.
--
-- A refusal is an exception, never a quiet outcome, so it cannot be mistaken
-- for success by a caller that only looks at `outcome`.
--
-- To undo:
--   drop function if exists public.correct_time_entry(text, timestamptz, timestamptz, text);

create or replace function public.correct_time_entry(
    shift_sync_id  text,
    new_started_at timestamptz,
    new_ended_at   timestamptz,
    reason         text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
    shift   time_entries%rowtype;
    saved   time_entries%rowtype;
    clean   text;
    touched int;
    new_minutes numeric;
begin
    -- ---- who is asking -------------------------------------------------
    -- A refusal, not a hatch. See the header.
    if auth.uid() is null then
        raise exception 'Sign in before correcting a shift.'
            using errcode = '42501';
    end if;

    if not coalesce(public.has_permission('APPROVE_TIME'), false) then
        raise exception
            'Correcting a shift''s hours needs APPROVE_TIME. What the clock says is payroll.'
            using errcode = '42501';
    end if;

    -- ---- what a correction has to say ----------------------------------
    -- Bounded the same way dispute_my_shift bounds its note: a payroll record
    -- is not a place to paste a novel into.
    clean := left(btrim(coalesce(reason, '')), 1000);
    if clean = '' then
        raise exception
            'Say why the hours are being changed. The crew member reads this, and it is what settles a dispute.'
            using errcode = '23514';
    end if;

    if new_started_at is null or new_ended_at is null then
        raise exception 'A correction needs both a start and a finish.'
            using errcode = '23514';
    end if;

    if new_ended_at <= new_started_at then
        raise exception 'The finish has to come after the start.'
            using errcode = '23514';
    end if;

    -- ---- the shift, pinned to the caller's own company -----------------
    -- This pin is the whole company boundary for this function: SECURITY
    -- DEFINER means RLS is not going to do it.
    select * into shift
      from public.time_entries t
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id()
       and t.deleted_at is null
     limit 1;

    if not found then
        return jsonb_build_object('outcome', 'not_found', 'rows', 0);
    end if;

    if shift.ended_at is null then
        raise exception 'A running shift has no finish time to correct. Clock it out first.'
            using errcode = '23514';
    end if;

    if new_started_at = shift.started_at and new_ended_at = shift.ended_at then
        return jsonb_build_object(
            'outcome',             'unchanged',
            'rows',                0,
            'started_at',          shift.started_at,
            'ended_at',            shift.ended_at,
            'original_started_at', shift.original_started_at,
            'original_ended_at',   shift.original_ended_at,
            'corrected_at',        shift.corrected_at,
            'correction_reason',   coalesce(shift.correction_reason, ''));
    end if;

    -- The break the crew member recorded is already on the row, and
    -- time_entries_break_not_longer_than_shift_chk will refuse a shift shorter
    -- than it. Caught here so the answer is a sentence a foreman can act on
    -- rather than a raw check-constraint name.
    new_minutes := extract(epoch from (new_ended_at - new_started_at)) / 60;
    if shift.break_minutes is not null and shift.break_minutes > new_minutes then
        raise exception
            'This shift has a % minute break recorded, which is longer than the % minutes you entered. Correct the break first.',
            shift.break_minutes, round(new_minutes)
            using errcode = '23514';
    end if;

    -- preserve_original_shift() fills original_started_at, original_ended_at,
    -- corrected_at and corrected_by off the back of this write -- the same
    -- trigger, on the same columns, as the office's correction sheet. Nothing
    -- here derives them by hand; a caller-supplied original_* is exactly the
    -- forgery that trigger exists to prevent.
    update public.time_entries t
       set started_at        = new_started_at,
           ended_at          = new_ended_at,
           correction_reason = clean
     where t.id = shift.id
    returning * into saved;
    get diagnostics touched = row_count;

    -- Belt and braces: an UPDATE that matched a row we had just selected and
    -- still changed nothing would mean a trigger silently swallowed it, and
    -- reporting that as saved is the defect this file exists to close.
    if touched <> 1 then
        raise exception 'The correction did not save. Nothing was changed.'
            using errcode = '25000';
    end if;

    return jsonb_build_object(
        'outcome',             'corrected',
        'rows',                touched,
        'started_at',          saved.started_at,
        'ended_at',            saved.ended_at,
        'original_started_at', saved.original_started_at,
        'original_ended_at',   saved.original_ended_at,
        'corrected_at',        saved.corrected_at,
        'corrected_by',        saved.corrected_by,
        'correction_reason',   coalesce(saved.correction_reason, ''));
end;
$fn$;

comment on function public.correct_time_entry(text, timestamptz, timestamptz, text) is
  'The phone''s door for correcting a shift''s recorded hours. Needs APPROVE_TIME, pinned to the caller''s own company, and records the correction the way the office does (preserve_original_shift keeps the original; corrected_at/corrected_by stamped; a reason is required). Returns the SAVED row so the screen can show what the database holds rather than what it hoped for. Exists because EntitySync''s update pass deliberately omits started_at/ended_at, so a correction typed on a phone was silently reverted by the next pull and payroll paid the uncorrected hours.';

-- Same door policy as acknowledge_my_shift / dispute_my_shift: signed-in users
-- only. anon has no business anywhere near a payroll figure, and the function
-- would refuse it anyway (auth.uid() is null), but a door that is shut is
-- better than a door that argues.
revoke execute on function public.correct_time_entry(text, timestamptz, timestamptz, text) from public, anon;
grant  execute on function public.correct_time_entry(text, timestamptz, timestamptz, text) to authenticated;

notify pgrst, 'reload schema';

select 'phone shift corrections now have a door that records them' as done;

-- CHANGING SOMEBODY ELSE'S RECORDED HOURS NEEDED NO PERMISSION AT ALL.
--
-- Proved live on 2026-09-18 inside a rolled-back transaction: a MANAGER whose
-- permission_overrides explicitly REMOVE both APPROVE_TIME and
-- SCHEDULE_AND_ASSIGN could still, through PostgREST, 1 row each time:
--
--   (a) attach a different worker to another person's ALREADY-APPROVED shift
--   (b) rewrite break_minutes / started_at / ended_at on that same shift
--
-- Why nothing stopped it:
--
--   * policy time_entries_update is PERMISSIVE, UPDATE, and its whole USING
--     clause is `company_id = current_company_id()`. No permission test
--     anywhere in it.
--   * the only RESTRICTIVE policy that mentions permissions,
--     time_entries_pay_needs_see_pay, is SELECT-side. It decides who may READ
--     a rate. It has nothing to say about an UPDATE.
--   * guard_time_entry_approval() returns early whenever approved_at,
--     approved_by and rejected_at are all unchanged. That early return is
--     correct and is kept -- crew clock out and the office corrects shifts
--     without touching the decision -- but it means the approval guard never
--     fires for an hours edit, which is the edit that moves the money.
--   * the office page's canEdit() is `OWNER || MANAGER`, role-based, in the
--     browser. A hidden button is not a rule.
--
-- This predates the assign-worker field added to the correction sheet today;
-- that field only made a hole that was already open reachable from a screen.
--
-- ---------------------------------------------------------------------------
-- THE RULE
-- ---------------------------------------------------------------------------
-- Editing a shift that is NOT your own -- its times, its break, who worked it,
-- its notes or its review/correction note -- needs a real permission:
--
--   APPROVE_TIME            correcting the recorded hours: started_at,
--                           ended_at, break_minutes, break_started_at,
--                           break_ended_at, notes, and the derived
--                           original_started_at / original_ended_at /
--                           corrected_at / corrected_by.
--                           Justification: these ARE the payroll figure. The
--                           permission whose whole subject is "may this person
--                           sign off hours" is the only honest gate on
--                           changing them. APPROVE_TIME is already the gate on
--                           saying the hours are right (guard_time_entry_
--                           approval); it is the same authority, applied one
--                           step earlier, to saying what the hours were.
--
--   APPROVE_TIME            the reviewer's own words: review_note,
--   (always, even on        correction_reason. These are what the person being
--    your own shift)        paid reads when their hours change and what
--                           settles a dispute. They are the corrector
--                           speaking, never the worker, so there is no
--                           own-shift exemption: a shift that says "checked,
--                           approved" in the crew member's own hand is worse
--                           than one that says nothing.
--
--   SCHEDULE_AND_ASSIGN     who worked it, and which job it is against:
--   or APPROVE_TIME         employee_sync_id, employee_id, job_sync_id.
--                           Justification: attaching or moving the worker is
--                           an assignment decision, which is exactly what
--                           SCHEDULE_AND_ASSIGN names (guard_job_assignment()
--                           already gates the same decision on jobs).
--                           APPROVE_TIME is accepted as well because the one
--                           screen that legitimately does this -- the office's
--                           "Correct this shift" sheet -- writes the worker and
--                           the times in a single PostgREST patch, so
--                           demanding the two permissions separately would
--                           refuse the correction path to the very people
--                           whose job it is. Neither permission is held by
--                           CREW, SALES or ACCOUNTANT, or by a MANAGER who has
--                           had them taken away, which is the hole.
--
--   nobody, over PostgREST  correction_seen_at, correction_disputed_at,
--                           dispute_note -- unless it is your own shift. These
--                           are the answer of the person being paid. Their
--                           door is acknowledge_my_shift() /
--                           dispute_my_shift(), which are SECURITY DEFINER and
--                           therefore exempt from this guard entirely (see the
--                           current_user test). Letting a corrector stamp
--                           "seen and accepted" on somebody else's behalf
--                           would make the dispute trail worthless, so
--                           APPROVE_TIME does NOT buy it.
--
-- YOUR OWN shift stays exactly as editable as it is today: times, break and
-- notes, no permission needed, so field work cannot break. "Your own" is
-- is_my_shift(OLD.employee_sync_id) -- the OLD value, so a shift cannot be
-- made yours by writing your own id into it.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
-- ---------------------------------------------------------------------------
-- hourly_rate is NOT in the protected set, on purpose. stamp_time_entry_rate()
-- already owns it: it overwrites whatever the caller sent with the employee's
-- real rate whenever an employee matches, and on an UPDATE with no matching
-- employee it puts old.hourly_rate back unless the caller can_see_pay(). So by
-- the time this trigger runs the value is the server's, not the caller's.
-- Protecting it here would also break a legitimate sync: a crew phone re-pushes
-- every shift it holds on every pass, and if the employee's rate has changed in
-- `employees` since the shift was stored, stamp_time_entry_rate legitimately
-- moves hourly_rate on a colleague's row. Refusing that would fail the phone's
-- sync for ever (see "the 403 consequence" below).
--
-- approved_at / approved_by / rejected_at are left to
-- guard_time_entry_approval(), which already requires APPROVE_TIME for them and
-- already says so in its own sentence. Two guards on one column would only make
-- the error message a lottery.
--
-- deleted_at / deleted_by belong to enforce_delete_permission(), updated_at to
-- touch_updated_at(). Untouched.
--
-- Nothing is dropped or weakened: time_entries_update, time_entries_insert,
-- time_entries_read, time_entries_pay_needs_see_pay, time_entries_not_suspended,
-- time_entry_needs_a_person, preserve_original_shift, stamp_time_entry_rate and
-- guard_time_entry_approval are all left exactly as they are. This file adds one
-- RESTRICTIVE policy and one BEFORE UPDATE trigger.
--
-- ---------------------------------------------------------------------------
-- WHY A TRIGGER RATHER THAN A POLICY DOES THE WORK
-- ---------------------------------------------------------------------------
-- Row-level security cannot say "you may edit this row but not these six
-- columns of it", and column-level GRANTs cannot say "except on your own
-- shift". Both are needed here, because the same table is written by a crew
-- handset syncing its own field work and by an office correcting payroll.
--
-- It also has to be a trigger for a blunter reason. EntitySync.pushTimeEntries
-- sends EVERY finished shift the phone holds, twice, on every sync -- and a
-- crew phone pulls every colleague's shift (time_entries_read is "same
-- company"; the crew door is the time_entries_crew view). So a crew member's
-- handset issues an UPDATE against other people's rows constantly. Those
-- updates carry the SAME values the server already holds, because the update
-- pass omits started_at/ended_at/break_* entirely (toCloud(includeTimes=false))
-- and the pull merge copies notes and the decision straight off the cloud row.
-- A policy cannot tell that apart from an attack; comparing OLD to NEW can.
-- Hence: this guard fires only when a protected column ACTUALLY changes, and a
-- write that moves none of them returns immediately.
--
-- The 403 consequence, stated because it is the cost of being wrong here:
-- errcode 42501 reaches PostgREST as HTTP 403, and isPermanentRejection() in
-- TimeEntrySyncRejection.kt deliberately treats 403 as retryable -- so a shift
-- this guard refuses on a phone would be retried, and reported as a sync
-- failure, on every sync. That is why the no-change early return above is not a
-- nicety, and why hourly_rate is out. 42501 is still the right code (it is what
-- guard_time_entry_approval raises for the same class of refusal, and what RLS
-- itself raises), and the paths that can reach it are the office's, where the
-- sentence is shown to a person.
--
-- ---------------------------------------------------------------------------
-- WHAT THE REAL CLIENTS WRITE (checked before writing the rule, not after)
-- ---------------------------------------------------------------------------
-- Phone, EntitySync.pushTimeEntries -> pushTimeEntryRows -> TimeEntry.toCloud:
--   pass 1  insert-only (ignoreDuplicates => ON CONFLICT DO NOTHING) carrying
--           company_id, sync_id, job_sync_id, employee_sync_id, started_at,
--           ended_at, hourly_rate, notes, approved_*, rejected_at, review_note,
--           break_minutes, break_started_at, break_ended_at. DO NOTHING never
--           reaches an UPDATE, and this trigger is BEFORE UPDATE only, so pass
--           1 is untouched by it.
--   pass 2  the merge pass, includeTimes=false, so started_at, ended_at and
--           all three break columns are dropped from the payload entirely
--           (explicitNulls=false). What is left is job_sync_id,
--           employee_sync_id, hourly_rate, notes, approved_*, rejected_at,
--           review_note -- and for a colleague's row every one of those is the
--           value that came down on the pull, so nothing this guard owns
--           changes and it returns early. A row whose employee this phone
--           cannot resolve is held back locally by needsWorkerAssignment()
--           and never sent at all, and TimeApprovalViewModel.fixAndRetry only
--           touches rows the server has never accepted, so the phone has no
--           path that changes employee_sync_id on a stored row.
--   A phone therefore never writes times, breaks or a worker over an existing
--   cloud row at all: the clock is written once, by INSERT. Own-shift edits are
--   still exempted below, because "the phone does not do it today" is not a
--   reason to make it impossible tomorrow.
-- Phone, TimeApprovalViewModel.approve/reject: carries approved_at/rejected_at
--   and review_note, so guard_time_entry_approval already demands APPROVE_TIME
--   first; this guard asks for the same permission and cannot disagree with it.
-- Office, website/dashboard.html saveFixTime: one patch with started_at,
--   ended_at, correction_reason, plus break_minutes when the box was filled and
--   employee_sync_id when the worker was changed. Every one of those is in the
--   APPROVE_TIME bucket or the worker bucket, which is the intended answer: a
--   correction sheet is a correction. Note the consequence, honestly: a MANAGER
--   with -APPROVE_TIME can no longer save that sheet even to attach a worker,
--   because the sheet always sends the times and the reason (and the times do
--   move -- the datetime-local inputs are minute-precision, so 5 of the 9 live
--   rows change their seconds on a round trip). dashboard.html is changed in the
--   same pass to stop offering the sheet to someone without APPROVE_TIME. The
--   server, not the button, is the boundary.
--
-- To undo:
--   drop trigger if exists time_entry_write_needs_permission on public.time_entries;
--   drop function if exists public.guard_time_entry_write_permission();
--   drop policy  if exists time_entries_update_stays_in_company on public.time_entries;

-- ---------------------------------------------------------------------------
-- 1. The company pin, made explicit rather than inherited.
-- ---------------------------------------------------------------------------
-- Stated carefully, because the first draft of this comment claimed a hole that
-- does not exist and the probe caught it: time_entries_update has a USING clause
-- and no WITH CHECK, and for UPDATE Postgres then uses the USING expression as
-- the WITH CHECK too. So moving a shift to another company is ALREADY refused
-- -- measured, pre-fix, as "new row violates row-level security policy" for the
-- stripped manager. This policy is not closing that.
--
-- What it does buy is that the pin cannot be lost by editing one policy. The
-- moment anybody gives time_entries_update a WITH CHECK -- the obvious way to
-- add a permission test to it later -- the implicit company check on the new row
-- silently disappears and a member of company A can hand a shift, its hours and
-- its rate to company B. Written out here as a RESTRICTIVE policy it survives
-- that edit. RESTRICTIVE can only ever narrow, and the expression is identical
-- on both sides, so it refuses nothing that stays put; no client sends
-- company_id on an update except the phone's upsert, which sends its own.
drop policy if exists time_entries_update_stays_in_company on public.time_entries;
create policy time_entries_update_stays_in_company on public.time_entries
    as restrictive for update to authenticated, anon
    using (company_id = public.current_company_id())
    with check (company_id = public.current_company_id());

-- ---------------------------------------------------------------------------
-- 2. The column rule.
-- ---------------------------------------------------------------------------
-- Deliberately NOT security definer, for the same reason
-- guard_time_entry_approval() is not: inside a definer function current_user is
-- the function owner, so the end-user test below would be false for everybody
-- and the guard would look installed while waving every write through.
-- As invoker, current_user is the role PostgREST set for the request.
--
-- And deliberately no "auth.uid() is null" escape hatch. auth.uid() is null for
-- an anonymous caller too, so that test hands the decision to exactly the people
-- it is meant to exclude.
create or replace function public.guard_time_entry_write_permission()
returns trigger language plpgsql set search_path to 'public' as $fn$
declare
    changed_hours  boolean;
    changed_worker boolean;
    changed_note   boolean;
    changed_answer boolean;
    mine           boolean;
    may_time       boolean;
    may_assign     boolean;
begin
    -- Server-side callers are not the subject. acknowledge_my_shift(),
    -- dispute_my_shift(), my_shift_answer() and every other SECURITY DEFINER
    -- function run as their owner, so they keep working untouched -- which is
    -- the requirement that the person being paid can still accept or dispute.
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;

    -- The recorded hours, and the four columns preserve_original_shift() derives
    -- from them. Those four are in this bucket rather than excluded because they
    -- move only when the times or the break move, which is already the thing
    -- being gated -- and because leaving them out would let a caller send a
    -- false original_started_at to hide a correction.
    changed_hours :=
           new.started_at         is distinct from old.started_at
        or new.ended_at           is distinct from old.ended_at
        or new.break_minutes      is distinct from old.break_minutes
        or new.break_started_at   is distinct from old.break_started_at
        or new.break_ended_at     is distinct from old.break_ended_at
        or new.notes              is distinct from old.notes
        or new.original_started_at is distinct from old.original_started_at
        or new.original_ended_at   is distinct from old.original_ended_at
        or new.corrected_at        is distinct from old.corrected_at
        or new.corrected_by        is distinct from old.corrected_by;

    changed_worker :=
           new.employee_sync_id is distinct from old.employee_sync_id
        or new.employee_id      is distinct from old.employee_id
        or new.job_sync_id      is distinct from old.job_sync_id;

    changed_note :=
           new.review_note       is distinct from old.review_note
        or new.correction_reason is distinct from old.correction_reason;

    changed_answer :=
           new.correction_seen_at     is distinct from old.correction_seen_at
        or new.correction_disputed_at is distinct from old.correction_disputed_at
        or new.dispute_note           is distinct from old.dispute_note;

    -- Nothing this guard owns moved. The crew phone's every-sync re-push of
    -- every colleague's shift lands here, and so does any write that only
    -- touches the approval decision (guard_time_entry_approval's business),
    -- the rate (stamp_time_entry_rate's) or a soft delete
    -- (enforce_delete_permission's).
    if not (changed_hours or changed_worker or changed_note or changed_answer) then
        return new;
    end if;

    -- OLD, never NEW: a shift is not made yours by writing your own id into it.
    mine       := coalesce(is_my_shift(old.employee_sync_id), false);
    may_time   := coalesce(has_permission('APPROVE_TIME'), false);
    may_assign := coalesce(has_permission('SCHEDULE_AND_ASSIGN'), false);

    if changed_worker and not (may_assign or may_time) then
        raise exception
            'Changing who worked a shift, or which job it is against, needs SCHEDULE_AND_ASSIGN. Whose hours these are is payroll.'
            using errcode = '42501';
    end if;

    if changed_hours and not mine and not may_time then
        raise exception
            'Correcting somebody else''s shift -- its hours, its break or its notes -- needs APPROVE_TIME. Your own shift stays yours to record.'
            using errcode = '42501';
    end if;

    if changed_note and not may_time then
        raise exception
            'The review note and the correction reason are the reviewer''s, and need APPROVE_TIME.'
            using errcode = '42501';
    end if;

    if changed_answer and not mine then
        raise exception
            'Only the person a shift belongs to can accept or dispute it. Use the app''s accept or dispute action.'
            using errcode = '42501';
    end if;

    return new;
end;
$fn$;

comment on function public.guard_time_entry_write_permission() is
  'Editing a shift that is not your own needs APPROVE_TIME (its hours, break, notes) or SCHEDULE_AND_ASSIGN (who worked it). Your own shift stays editable. Fires only when a protected column actually changes, so the phone''s re-push of unchanged colleague rows is untouched, and returns early for SECURITY DEFINER callers so acknowledge_my_shift/dispute_my_shift keep working.';

-- Named to sort LAST among the BEFORE ROW triggers on this table. Postgres
-- fires same-timing triggers in name order, and this one has to see the values
-- the others produce: stamp_time_entry_rate has already normalised
-- hourly_rate, and preserve_original_shift has already derived
-- original_*/corrected_* -- both of which this function compares.
--   enforce_delete_permission < preserve_original_shift_trg
--     < stamp_time_entry_rate < time_entries_touch
--     < time_entry_approval_needs_permission < time_entry_needs_a_person
--     < time_entry_write_needs_permission
-- UPDATE only. INSERT is a different question with a different answer
-- (time_entries_insert plus time_entry_needs_a_person), and adding INSERT here
-- would refuse a crew member their own clock-in.
drop trigger if exists time_entry_write_needs_permission on public.time_entries;
create trigger time_entry_write_needs_permission
    before update on public.time_entries
    for each row execute function public.guard_time_entry_write_permission();

notify pgrst, 'reload schema';

select 'editing somebody else''s hours now needs a permission' as done;

-- ---------------------------------------------------------------------------
-- A FOREMAN'S APPROVALS NEVER LEFT THE PHONE, AND THE PHONE RETRIED FOR EVER.
-- ---------------------------------------------------------------------------
-- FOREMAN holds APPROVE_TIME and does NOT hold SEE_PAY (read straight out of
-- has_permission(): FOREMAN => SCHEDULE_AND_ASSIGN, RECORD_FIELD_WORK,
-- SEE_CUSTOMER_CONTACT, APPROVE_TIME, APPROVE_PLAN_CHANGES). A foreman is the
-- phone user TimeApprovalScreen exists for: the person on site who signs off
-- their crew's hours.
--
-- time_entries_pay_needs_see_pay is RESTRICTIVE, SELECT, and reads
--
--     has_permission('SEE_PAY') or is_my_shift(employee_sync_id)
--
-- so a colleague's shift is INVISIBLE to a foreman in the base table. Postgres
-- applies SELECT policies to the row an UPDATE reads, and to the conflicting
-- row an INSERT ... ON CONFLICT touches. Measured live on 2026-09-20 inside a
-- rolled-back transaction, with a synthetic company and four synthetic people:
--
--   FOREMAN APPROVE_TIME/SEE_PAY ................................ true/false
--   FOREMAN sees a colleague's shift in time_entries ............. 0 rows
--   FOREMAN sees the same shift in time_entries_crew ............. 1 row
--   MANAGER sees it in time_entries (positive control) ........... 1 row
--
--   FOREMAN, plain UPDATE setting approved_at on a colleague ..... 0 rows,
--       and approved_at read back afterwards: STILL NULL. No error at all.
--   FOREMAN, the real push shape -- INSERT ... ON CONFLICT
--       (company_id, sync_id) DO UPDATE, which is what
--       EntitySync.pushTimeEntries sends ......................... 42501
--       'new row violates row-level security policy
--        "time_entries_pay_needs_see_pay" for table "time_entries"'
--   MANAGER, the same statement (positive control) ............... accepted
--
-- So the approval screen the foreman is given cannot reach the office, and
-- fails in the two worst ways a payroll write can: silently (0 rows, which
-- reads as success to anything that does not count rows) and permanently-
-- looking-temporary. errcode 42501 arrives at PostgREST as HTTP 403, and
-- isPermanentRejection() in TimeEntrySyncRejection.kt deliberately treats 403
-- as retryable -- correctly, for an expired token -- so the phone re-sends the
-- same doomed row on every single sync and reports a sync failure every time.
--
-- WIDER THAN APPROVALS, and this is worth stating because it changes the fix:
-- the refusal is not about the approval columns. The same rolled-back probe
-- sent the identical upsert with NO approval columns at all (job_sync_id,
-- employee_sync_id, hourly_rate, notes -- the ordinary sync of a colleague's
-- row), and it was refused 42501 by the same policy. So was the insert-only
-- pass (ON CONFLICT DO NOTHING). A phone without SEE_PAY cannot write ANY
-- colleague row, in either pass, whatever it sends. Dropping approved_at from
-- the payload therefore does not close the retry loop on its own; the phone
-- also has to stop sending rows it can neither see nor write, which is what
-- the EntitySync change in this same pass does.
--
-- ---------------------------------------------------------------------------
-- WHY AN RPC, AND NOT A CHANGE TO THE POLICY
-- ---------------------------------------------------------------------------
-- The obvious "fix" is to add `or has_permission('APPROVE_TIME')` to
-- time_entries_pay_needs_see_pay. That is the wrong answer and it is the one
-- thing this file must not do: that policy is the whole of crew financial
-- privacy on this table. Widening it would hand every foreman every
-- colleague's hourly_rate -- the exact leak supabase_sec_time_entries_pay.sql
-- was written to close (F2/P1: "hourly_rate was readable by CREW, FOREMAN and
-- SALES"). APPROVE_TIME is permission to say the hours are right, not
-- permission to see what they pay.
--
-- correct_time_entry (supabase_p2_correct_time_entry.sql) already solved this
-- exact class for the same screen: a phone that cannot write a column through
-- PostgREST gets a narrow SECURITY DEFINER door that writes it for them, and
-- decides for itself who is allowed through. This is that, for the decision
-- instead of the clock. One door, one permission test, one company pin, and
-- the row stays invisible to the caller from beginning to end.
--
-- ---------------------------------------------------------------------------
-- WHAT IT RETURNS -- decided deliberately, because a definer function is the
-- one place a money column could leak past the policy that hides it
-- ---------------------------------------------------------------------------
-- jsonb carrying, and only carrying:
--
--     outcome      'approved' | 'rejected' | 'not_found'
--     rows         the affected-row count, returned rather than inferred
--     sync_id      the shift this answers about
--     approved_at  approved_by  rejected_at  review_note
--
-- NOT hourly_rate. NOT started_at/ended_at/break_minutes (those are
-- correct_time_entry's subject and the phone already holds them). NOT the row.
-- `returning *` into a rowtype is used internally so the answer is the STORED
-- values rather than the ones that were sent, but the jsonb is built field by
-- field from a fixed list, so adding a money column to time_entries later
-- cannot widen this answer by accident.
--
-- approved_by is a PERSON'S NAME and is derived here, from the caller's own
-- profile -- never accepted as an argument. A sign-off that lets the signer
-- type whose name goes on it is not a sign-off. Falls back to the account's
-- email, then to the uid, so the column is never blank on an approval.
--
-- 'not_found' is an outcome, not an error: a shift the cloud has never seen
-- (recorded on this handset and not yet synced, or soft-deleted) is a real and
-- ordinary state. The phone stamps it locally and the insert-only push pass --
-- the one pass that does carry the decision for a brand new row -- takes it up.
-- Every refusal below is an exception, never a quiet outcome, so a caller that
-- only looks at `outcome` cannot mistake one for success.
--
-- ---------------------------------------------------------------------------
-- THE RULES, AND WHERE EACH ONE COMES FROM
-- ---------------------------------------------------------------------------
--   signed in            auth.uid() is null REFUSES. Deliberately not an
--                        escape hatch: auth.uid() is null for anon too, so a
--                        hatch there hands payroll sign-off to exactly the
--                        people it is meant to exclude (see
--                        memory/service-role-guard-trap.md). No service_role
--                        bypass and no is_platform_admin bypass either.
--
--   APPROVE_TIME         the permission whose whole subject is "may this
--                        person sign off hours". Held by OWNER, MANAGER and
--                        FOREMAN; refused to CREW, SALES, ACCOUNTANT, and to
--                        anyone whose permission_overrides take it away.
--                        Identical to what guard_time_entry_approval() demands
--                        on the base table, so the two cannot disagree.
--
--   your own company     current_company_id() pins the lookup. SECURITY
--                        DEFINER means RLS is not going to do it, and this is
--                        the whole company boundary for this function.
--
--   never your own shift is_my_shift(the STORED employee_sync_id) REFUSES.
--                        guard_time_entry_approval's message already states
--                        this rule -- "A shift cannot be signed off by the
--                        person being paid for it" -- and this function is
--                        the first place it is actually ENFORCED.
--
--                        Stated plainly, because a comment that overstates a
--                        guard is how the last bug in this area survived:
--                        guard_time_entry_approval() checks ONLY
--                        has_permission('APPROVE_TIME'). It has no own-shift
--                        test. Measured in the same rolled-back probe: the
--                        FOREMAN's plain UPDATE approving THEIR OWN shift
--                        landed 1 row and approved_at was a real timestamp
--                        afterwards. That hole is on the base table and is
--                        left exactly as it is by this file -- it belongs to
--                        supabase_approval_and_assignment_guard.sql, it would
--                        change behaviour nobody asked to change (an owner
--                        doing their own field work signs off their own day
--                        today), and closing it is its own change with its own
--                        probe. What this file guarantees is that the new door
--                        does not widen it: the RPC refuses, always.
--
--   a finished shift     a shift still running has no hours to sign off yet.
--                        correct_time_entry refuses one for the same reason.
--
--   a rejection needs    the crew member reads this, and it is what settles a
--   words                dispute. dispute_my_shift and correct_time_entry both
--                        refuse a wordless one; TimeApprovalScreen's Reject
--                        button is already disabled until the note is filled
--                        in, so this refuses nothing a person can currently
--                        send. An approval's note stays optional.
--
--   not suspended        company_is_suspended() REFUSES. On the base table
--                        time_entries_not_suspended is RESTRICTIVE FOR ALL and
--                        would stop this write; inside a definer function that
--                        policy is bypassed, so it is asked by hand rather
--                        than silently lost. A cancelled company does not get
--                        a payroll door the rest of the product denies it.
--
-- ---------------------------------------------------------------------------
-- WHAT IT DELIBERATELY DOES NOT DO
-- ---------------------------------------------------------------------------
--   * It does not touch started_at, ended_at, break_minutes, the worker, the
--     job or hourly_rate. Correcting the clock is correct_time_entry's door,
--     and the phone calls that one FIRST when the review dialog's times moved.
--     Two doors, each with its own audit trail, rather than one that does
--     everything and records half of it.
--   * It does not touch correction_seen_at / correction_disputed_at /
--     dispute_note. Those are the answer of the person being paid
--     (acknowledge_my_shift / dispute_my_shift), and a reviewer stamping them
--     is what would make the dispute trail worthless.
--   * It does not widen, narrow, drop or replace ANY policy or trigger.
--     time_entries_pay_needs_see_pay, time_entries_read, time_entries_update,
--     time_entries_insert, time_entries_update_stays_in_company,
--     time_entries_not_suspended, guard_time_entry_approval,
--     guard_time_entry_write_permission, preserve_original_shift,
--     stamp_time_entry_rate and time_entry_needs_a_person are all untouched.
--     A FOREMAN still cannot read hourly_rate, from the base table or from any
--     view, before or after this file -- which the probe measures both ways.
--
-- To undo:
--   drop function if exists public.approve_time_entry(text, boolean, text);

create or replace function public.approve_time_entry(
    shift_sync_id text,
    approve       boolean,
    note          text default ''
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
    shift    time_entries%rowtype;
    saved    time_entries%rowtype;
    clean    text;
    approver text;
    touched  int;
begin
    -- ---- who is asking -------------------------------------------------
    if auth.uid() is null then
        raise exception 'Sign in before signing off a shift.'
            using errcode = '42501';
    end if;

    if coalesce(public.company_is_suspended(), true) then
        raise exception 'This company''s subscription is not active. Hours cannot be signed off.'
            using errcode = '42501';
    end if;

    if not coalesce(public.has_permission('APPROVE_TIME'), false) then
        raise exception
            'Approving or rejecting hours needs APPROVE_TIME. What the clock says is payroll.'
            using errcode = '42501';
    end if;

    -- ---- what is being asked -------------------------------------------
    -- Null is not a decision. Defaulting it either way would turn a client
    -- bug into a payroll figure.
    if approve is null then
        raise exception 'Say whether this shift is approved or rejected.'
            using errcode = '23514';
    end if;

    -- Bounded the same way dispute_my_shift and correct_time_entry bound
    -- theirs: a payroll record is not a place to paste a novel into.
    clean := left(btrim(coalesce(note, '')), 1000);
    if not approve and clean = '' then
        raise exception
            'Say what is wrong with the hours. The crew member reads this, and it is what settles a dispute.'
            using errcode = '23514';
    end if;

    -- ---- the shift, pinned to the caller's own company -----------------
    select * into shift
      from public.time_entries t
     where t.sync_id::text = shift_sync_id
       and t.company_id = public.current_company_id()
       and t.deleted_at is null
     limit 1;

    if not found then
        return jsonb_build_object('outcome', 'not_found', 'rows', 0,
                                  'sync_id', shift_sync_id);
    end if;

    -- The STORED employee_sync_id, never one the caller sent: a shift is not
    -- made somebody else's by naming somebody else in the request.
    if coalesce(public.is_my_shift(shift.employee_sync_id), false) then
        raise exception
            'A shift cannot be signed off by the person being paid for it. Ask somebody else to review it.'
            using errcode = '42501';
    end if;

    if shift.ended_at is null then
        raise exception 'This shift is still running. Clock it out before signing it off.'
            using errcode = '23514';
    end if;

    -- ---- whose name goes on it -----------------------------------------
    -- Derived, never supplied. Written out as coalesce over three sources so
    -- approved_by is never blank on an approval, which is what the office
    -- timesheet shows in the "signed off by" column.
    select coalesce(
             nullif(btrim(p.full_name), ''),
             nullif(btrim(u.email), ''),
             auth.uid()::text)
      into approver
      from public.profiles p
      left join auth.users u on u.id = p.id
     where p.id = auth.uid();
    approver := coalesce(approver, auth.uid()::text);

    -- ---- the decision ---------------------------------------------------
    -- One statement, both directions, so approve and reject cannot drift into
    -- disagreeing about which columns a decision owns. A decision always
    -- clears the other one: a shift is approved OR rejected, never both, and
    -- the office's reports read exactly that pair (see dashboard.html's
    -- `t.rejected_at && !t.approved_at`).
    update public.time_entries t
       set approved_at = case when approve then now() else null end,
           approved_by = case when approve then approver else '' end,
           rejected_at = case when approve then null else now() end,
           review_note = clean
     where t.id = shift.id
    returning * into saved;
    get diagnostics touched = row_count;

    -- Belt and braces, and the whole reason this function exists: an UPDATE
    -- that matched a row we had just selected and still changed nothing would
    -- mean a trigger or a policy swallowed it, and reporting THAT as approved
    -- is the defect this file closes.
    if touched <> 1 then
        raise exception 'The sign-off did not save. Nothing was changed.'
            using errcode = '25000';
    end if;

    -- Field by field off the saved row. Never `to_jsonb(saved)`: that would
    -- put hourly_rate in the answer and hand a foreman the one number the
    -- policy above exists to keep from them.
    return jsonb_build_object(
        'outcome',     case when approve then 'approved' else 'rejected' end,
        'rows',        touched,
        'sync_id',     saved.sync_id,
        'approved_at', saved.approved_at,
        'approved_by', coalesce(saved.approved_by, ''),
        'rejected_at', saved.rejected_at,
        'review_note', coalesce(saved.review_note, ''));
end;
$fn$;

comment on function public.approve_time_entry(text, boolean, text) is
  'The phone''s door for signing off or rejecting a shift. Needs APPROVE_TIME, pinned to the caller''s own company, refuses the caller''s OWN shift and refuses a running one; a rejection must carry words. Returns only the decision columns -- never hourly_rate or any other money column -- plus the affected-row count, so the screen shows what the database holds rather than what it hoped for. Exists because time_entries_pay_needs_see_pay hides a colleague''s row from anyone without SEE_PAY, and Postgres applies SELECT policies to the row an UPDATE reads: a FOREMAN (APPROVE_TIME, no SEE_PAY) approving through PostgREST moved 0 rows on a plain UPDATE and was refused 42501 on the phone''s real upsert shape.';

-- Same door policy as correct_time_entry / acknowledge_my_shift /
-- dispute_my_shift: signed-in users only. anon has no business anywhere near a
-- payroll decision, and the function would refuse it anyway (auth.uid() is
-- null), but a door that is shut is better than a door that argues.
revoke execute on function public.approve_time_entry(text, boolean, text) from public, anon;
grant  execute on function public.approve_time_entry(text, boolean, text) to authenticated;

notify pgrst, 'reload schema';

select 'a foreman''s sign-off now has a door that reaches the office' as done;

-- A crew member must be able to see that their hours were changed.
--
-- The office can correct a shift, and the database keeps the original beside
-- the corrected times along with who changed it and why. None of that reaches
-- the phone: the crew view does not carry those columns, so a crew member's
-- app shows the corrected hours as though they were what the clock recorded.
--
-- That leaves the dispute feature half-delivered. dispute_my_shift exists and
-- works, and it assumes the person knows there is something to dispute.
--
-- None of these are money. They are two timestamps, a reason, and who made the
-- change -- the crew view already carries approved_by and review_note, which
-- are the same kind of thing. The rate stays off this view, as it always has.
--
-- The view is recreated from its own live definition with four columns added.
-- Every original column is still present and in the same order.
create or replace view public.time_entries_crew as
 SELECT id,
    company_id,
    sync_id,
    job_sync_id,
    employee_id,
    started_at,
    ended_at,
    notes,
    updated_at,
    approved_at,
    approved_by,
    rejected_at,
    review_note,
    deleted_at,
    deleted_by,
    employee_sync_id,
    original_started_at,
    original_ended_at,
    corrected_at,
    correction_reason
   FROM time_entries
  WHERE company_id = current_company_id() AND NOT company_is_suspended();

select 'crew view carries corrections' as done;

-- THE FIFTH FOLLOW-UP KIND HAS TO BE A KIND THE LOG ACCEPTS.
--
-- follow_up_log.kind carries a CHECK listing the four sales nudges. The
-- review request is a fifth, and without this patch it fails in the quietest
-- possible way:
--
--   send-follow-ups claims the log row BEFORE sending (that claim is what
--   stops a double send). The insert would be refused with 23514, which is
--   not the 23505 the code treats as "already sent", so it logs to the
--   console and moves on to the next job. No email, no error to the caller,
--   HTTP 200, an empty `results` array -- a run that looks exactly like
--   "nothing was due". The feature would have been dead on arrival and the
--   scheduler would have reported success every night.
--
-- Found by reading the constraint before deploying the sender, not by
-- watching for an email that never came.

alter table public.follow_up_log drop constraint if exists follow_up_log_kind_check;

alter table public.follow_up_log
  add constraint follow_up_log_kind_check
  check (kind = any (array[
    'new_lead_not_contacted',
    'quote_sent_no_view',
    'quote_viewed_not_approved',
    'approved_no_deposit',
    -- r49: the review request, 2-3 days after the job is marked COMPLETED.
    'job_done_review'
  ]));

-- ---------------------------------------------------------------------------
-- Self-test: the new kind is accepted AND a made-up one is still refused.
--
-- Both halves matter. Widening a CHECK by hand is one typo away from
-- `check (true)`, which would pass an "it was accepted" test and quietly
-- stop guarding the column -- so the second half is the real assertion.
-- ---------------------------------------------------------------------------
do $$
declare
  cid uuid; js uuid := gen_random_uuid(); refused boolean := false;
begin
  select id into cid from public.companies order by created_at limit 1;
  if cid is null then raise notice 'r49: no company to probe with; skipped'; return; end if;

  insert into public.follow_up_log (company_id, job_sync_id, kind, stage_key, channel)
  values (cid, js, 'job_done_review', 'r49-probe', 'email');
  if not exists (select 1 from public.follow_up_log
                  where job_sync_id = js and kind = 'job_done_review') then
      raise exception 'r49 FAILED: the review kind was not accepted';
  end if;

  -- THE CONTROL: the column must still refuse anything else.
  begin
      insert into public.follow_up_log (company_id, job_sync_id, kind, stage_key, channel)
      values (cid, js, 'not_a_real_kind', 'r49-probe', 'email');
  exception when check_violation then
      refused := true;
  end;
  if not refused then
      raise exception 'r49 FAILED: an unknown kind was accepted -- the CHECK is '
        'no longer guarding the column, so the pass above means nothing';
  end if;

  delete from public.follow_up_log where job_sync_id = js;
  raise notice 'r49 ok: job_done_review accepted, unknown kinds still refused';
end $$;

select 'job_done_review is a known kind' as check,
       pg_get_constraintdef(oid) like '%job_done_review%' as pass
from pg_constraint
where conrelid = 'public.follow_up_log'::regclass and conname = 'follow_up_log_kind_check';

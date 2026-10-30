-- THE JOB IS DONE WHEN THE CUSTOMER SAYS IT IS.
--
-- r47 made the review request count from the moment a job's status becomes
-- COMPLETED. Read against the live data afterwards, that turns out to be a
-- status this company has never used: of 13 real jobs the statuses are
-- 5 ACCEPTED, 5 SENT, 2 DRAFT and 1 DECLINED. Not one COMPLETED, ever. So the
-- feature was live and could never fire -- the kind of thing discovered three
-- weeks later by nobody receiving anything.
--
-- What the jobs DO record is the final sign-off: the customer confirming the
-- finished work (not the price -- that is the acceptance signature). One job
-- carries final_sign_off_at today. That is a better answer to "when was the
-- job done" than a status nobody sets, and it comes from the customer rather
-- than from an office habit.
--
-- So completed_at is now stamped by EITHER:
--   - the status first becoming COMPLETED (r47, unchanged), or
--   - final_sign_off_at first being set.
--
-- Whichever happens first wins and nothing moves it afterwards, exactly as
-- r47 argued: the review request is tied to the first completion, and
-- re-stamping would chase a customer twice for the same fence.
--
-- IT DOES NOT TOUCH status. Changing a job's status from under the owner
-- because a signature arrived would be this patch deciding how he runs his
-- board. It stamps the date the review clock counts from, and nothing else.
--
-- STILL NO BACKFILL. The one job that already has a sign-off keeps a null
-- completed_at: it was finished before any of this existed, and stamping it
-- now would ask that customer for a review about work that may be months old.
-- The feature starts from here, the same as r47.

create or replace function public.jobs_set_completed_at()
returns trigger
language plpgsql
as $$
begin
    -- FIRST time it becomes COMPLETED, and only then.
    --
    -- Not re-stamped if it is completed, reopened and completed again: the
    -- review request is tied to the first completion, and re-stamping would
    -- chase a customer twice for the same fence. Not cleared on reopen either,
    -- for the same reason -- the clearing is a deliberate act, not a side
    -- effect of fixing a status somebody set by mistake.
    if new.status = 'COMPLETED' and coalesce(old.status, '') is distinct from 'COMPLETED'
       and new.completed_at is null then
        new.completed_at := now();
    end if;

    -- r55: or the first time the customer signs the work off. The same
    -- never-moves rule, and it only ever fills a null.
    if new.final_sign_off_at is not null and old.final_sign_off_at is null
       and new.completed_at is null then
        new.completed_at := new.final_sign_off_at;
    end if;

    return new;
end
$$;

-- The insert door agrees, for a job entered after the fact.
create or replace function public.jobs_set_completed_at_insert()
returns trigger
language plpgsql
as $$
begin
    if new.completed_at is null then
        if new.status = 'COMPLETED' then
            new.completed_at := now();
        elsif new.final_sign_off_at is not null then
            new.completed_at := new.final_sign_off_at;
        end if;
    end if;
    return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Self-test. Rolled back whatever happens.
-- ---------------------------------------------------------------------------
do $$
declare
  cid uuid; js uuid := gen_random_uuid(); js2 uuid := gen_random_uuid();
  signed constant timestamptz := now() - interval '4 days';
  stamped timestamptz; again timestamptz;
begin
  select id into cid from public.companies order by created_at limit 1;
  if cid is null then raise notice 'r55: no company to probe with; skipped'; return; end if;

  -- 1. A sign-off on an ACCEPTED job stamps the completion with the sign-off's
  --    own date, not now(): the review is due three days after the work was
  --    finished, not three days after somebody got round to syncing.
  insert into public.jobs (company_id, sync_id, customer_name, status, is_test_fixture)
  values (cid, js, 'ZZ R55 PROBE', 'ACCEPTED', true);
  if (select completed_at from public.jobs where sync_id = js) is not null then
      raise exception 'r55 FAILED: an unfinished job was stamped';
  end if;

  update public.jobs set final_sign_off_at = signed where sync_id = js;
  select completed_at into stamped from public.jobs where sync_id = js;
  if stamped is null then
      raise exception 'r55 FAILED: a signed-off job was not stamped';
  end if;
  if stamped <> signed then
      raise exception 'r55 FAILED: stamped % instead of the sign-off date %', stamped, signed;
  end if;

  -- 2. Re-signing does not move it.
  update public.jobs set final_sign_off_at = now() where sync_id = js;
  select completed_at into again from public.jobs where sync_id = js;
  if again is distinct from stamped then
      raise exception 'r55 FAILED: re-signing moved the completion date';
  end if;

  -- 3. And COMPLETED still works on its own, with no sign-off anywhere.
  insert into public.jobs (company_id, sync_id, customer_name, status, is_test_fixture)
  values (cid, js2, 'ZZ R55 PROBE 2', 'ACCEPTED', true);
  update public.jobs set status = 'COMPLETED' where sync_id = js2;
  if (select completed_at from public.jobs where sync_id = js2) is null then
      raise exception 'r55 FAILED: r47 behaviour was broken -- COMPLETED no longer stamps';
  end if;

  -- 4. THE CANARY. An ordinary edit must still stamp NOTHING, or the three
  --    passes above only prove that this trigger writes a date on any update.
  delete from public.jobs where sync_id = js2;
  insert into public.jobs (company_id, sync_id, customer_name, status, is_test_fixture)
  values (cid, js2, 'ZZ R55 PROBE 3', 'ACCEPTED', true);
  update public.jobs set customer_name = 'ZZ R55 PROBE 4' where sync_id = js2;
  if (select completed_at from public.jobs where sync_id = js2) is not null then
      raise exception 'r55 FAILED: an ordinary edit stamped a completion date';
  end if;

  delete from public.jobs where sync_id in (js, js2);
  raise notice 'r55 ok: sign-off completes a job, COMPLETED still does, ordinary edits do not';
end $$;

-- What this changes for the jobs that exist right now: nothing is stamped,
-- and that is the expected answer.
select 'no job was backfilled by r55' as check,
       (select count(*) = 0 from public.jobs
         where completed_at is not null
           and coalesce(is_test_fixture, false) = false) as pass,
       (select count(*) from public.jobs
         where final_sign_off_at is not null
           and coalesce(is_test_fixture, false) = false) as signed_off_jobs_waiting;

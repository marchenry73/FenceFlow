-- WHEN THE JOB WAS DONE, AND THE REVIEW EMAIL THAT FOLLOWS IT.
--
-- "When the job is done, I want an automatic email to be sent in 2 or 3 days
-- afterwards, so you can remove the review side in the job, but still leave
-- something so I know the email was sent for the review."
--
-- THE PREREQUISITE NOBODY HAD: there is a COMPLETED status and nothing that
-- records WHEN. "Two days after the job is done" had nothing to count from.
--
-- A TRIGGER, NOT A FIELD THE APPS REMEMBER TO SET. Three surfaces can move a
-- job to COMPLETED -- the phone's status selector, the office, and the crew
-- flow -- and a stamp that each has to remember is a stamp one of them will
-- forget. The trigger writes it where the status actually changes, so the
-- answer is the same whichever door was used.
--
-- NO BACKFILL, and this one would have been expensive. Setting completed_at =
-- now() on the jobs already marked COMPLETED would send a review request to
-- every customer from every finished job at once, months after the work. Old
-- jobs keep a null and are never chased; the feature starts from here.
--
-- review_email_sent_at is the marker he asked for: the manual review section
-- comes off the job screen and this is what replaces it, so the question
-- "did that go out?" has an answer on the job rather than in a log.

alter table public.jobs
  add column if not exists completed_at          timestamptz,
  add column if not exists review_email_sent_at  timestamptz;

comment on column public.jobs.completed_at is
  'When the status first became COMPLETED, written by trg_jobs_completed_at. '
  'Null on every job completed before 2026-10-29: nobody recorded it, and '
  'inventing a date would have emailed every past customer at once.';

comment on column public.jobs.review_email_sent_at is
  'When the automatic review request went out. The marker on the job screen, '
  'and the guard that stops a second one being sent.';

-- ---------------------------------------------------------------------------
-- The stamp.
-- ---------------------------------------------------------------------------
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
    return new;
end
$$;

drop trigger if exists trg_jobs_completed_at on public.jobs;
create trigger trg_jobs_completed_at
    before update on public.jobs
    for each row
    execute function public.jobs_set_completed_at();

-- An INSERT that arrives already COMPLETED -- a job entered after the fact --
-- gets the same treatment, so the two doors agree.
create or replace function public.jobs_set_completed_at_insert()
returns trigger
language plpgsql
as $$
begin
    if new.status = 'COMPLETED' and new.completed_at is null then
        new.completed_at := now();
    end if;
    return new;
end
$$;

drop trigger if exists trg_jobs_completed_at_ins on public.jobs;
create trigger trg_jobs_completed_at_ins
    before insert on public.jobs
    for each row
    execute function public.jobs_set_completed_at_insert();

-- ---------------------------------------------------------------------------
-- The setting, beside the four follow-ups that already exist.
-- ---------------------------------------------------------------------------
alter table public.follow_up_settings
  add column if not exists job_done_review_enabled boolean not null default false,
  add column if not exists job_done_review_days    integer not null default 3,
  add column if not exists review_url              text    not null default '';

comment on column public.follow_up_settings.job_done_review_enabled is
  'Off by default, like every other follow-up here: a company that has not '
  'asked for automatic email does not start sending it because of an upgrade.';
comment on column public.follow_up_settings.job_done_review_days is
  'Days after completed_at before the review request is due. The owner asked '
  'for two or three; three is the default.';
comment on column public.follow_up_settings.review_url is
  'Where the review is left. Blank means the request cannot be sent -- there '
  'is nothing to ask them to click -- and send-follow-ups skips the company.';

-- ---------------------------------------------------------------------------
-- Self-test. Rolled back whatever happens.
-- ---------------------------------------------------------------------------
do $$
declare cid uuid; js uuid := gen_random_uuid(); stamped timestamptz; again timestamptz;
begin
  select id into cid from public.companies order by created_at limit 1;
  if cid is null then raise notice 'r47: no company to probe with; skipped'; return; end if;

  insert into public.jobs (company_id, sync_id, customer_name, status, is_test_fixture)
  values (cid, js, 'ZZ R47 PROBE', 'ACCEPTED', true);
  if (select completed_at from public.jobs where sync_id = js) is not null then
      raise exception 'r47 FAILED: a job that is not complete was stamped';
  end if;

  update public.jobs set status = 'COMPLETED' where sync_id = js;
  select completed_at into stamped from public.jobs where sync_id = js;
  if stamped is null then
      raise exception 'r47 FAILED: completing a job did not stamp it';
  end if;

  -- Reopened and completed again: the FIRST completion stands.
  update public.jobs set status = 'ACCEPTED'  where sync_id = js;
  update public.jobs set status = 'COMPLETED' where sync_id = js;
  select completed_at into again from public.jobs where sync_id = js;
  if again is distinct from stamped then
      raise exception 'r47 FAILED: re-completing moved the date from % to %', stamped, again;
  end if;

  -- An unrelated edit must not touch it either.
  update public.jobs set customer_name = 'ZZ R47 PROBE 2' where sync_id = js;
  if (select completed_at from public.jobs where sync_id = js) is distinct from stamped then
      raise exception 'r47 FAILED: an ordinary edit moved the completion date';
  end if;

  delete from public.jobs where sync_id = js;
  raise notice 'r47 ok: stamped on first completion, never moved after';
end $$;

select 'no past job was backfilled' as check,
       (select count(*) = 0 from public.jobs
         where status = 'COMPLETED' and completed_at is not null
           and coalesce(is_test_fixture, false) = false) as pass;

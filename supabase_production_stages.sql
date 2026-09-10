-- Where a sold job actually is: materials, dig, set, build, punch, done.
--
-- March's stages, 10 September, in his words: "Materials, dig, set, build,
-- punch, done." Until now a job that was sold had a status and a scheduled
-- date and nothing in between, so "where is the Beaunissant job" was a phone
-- call rather than a screen.
--
-- Two pieces, deliberately:
--
--   jobs.production_stage   -- where it is now, for every list and board
--   job_stage_events        -- every move, append only, so how long a job sat
--                              at "waiting on materials" is a fact rather than
--                              a memory
--
-- The second is the one that earns its place later. A single column knows the
-- present and forgets the past, and the first question anybody asks of a
-- pipeline after a month is where jobs get stuck. That cannot be answered
-- afterwards from a column that only ever held the latest value.
--
-- Purely additive: one nullable column, one new table, no policy replaced.

do $$
begin
    if not exists (select 1 from pg_type where typname = 'production_stage') then
        create type production_stage as enum
            ('MATERIALS', 'DIG', 'SET', 'BUILD', 'PUNCH', 'DONE');
    end if;
end $$;

alter table jobs
  add column if not exists production_stage production_stage;

comment on column jobs.production_stage is
  'Where a sold job is on the ground. Null means production has not started -- a quote is not "waiting on materials".';

create table if not exists job_stage_events (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references companies(id),
    job_sync_id  uuid not null,
    stage        production_stage not null,
    entered_at   timestamptz not null default now(),
    entered_by   uuid references profiles(id),
    -- What the job moved FROM, so a report can read a single row and know the
    -- span it closes without having to hold the whole history in order.
    left_stage   production_stage
);

create index if not exists job_stage_events_job on job_stage_events(company_id, job_sync_id, entered_at);

alter table job_stage_events enable row level security;

-- Read: anyone in the company. There is no money on this table -- it is a
-- stage name and a timestamp -- and the crew are the people who move it, so
-- hiding it from them would make the feature useless to its main users.
drop policy if exists job_stage_events_read on public.job_stage_events;
create policy job_stage_events_read on public.job_stage_events
    for select using (company_id = public.current_company_id());

-- No insert, update or delete policy at all. The only way a row lands here is
-- set_production_stage() below, which is SECURITY DEFINER. An append-only log
-- that any client can write is not a log, it is a suggestion.

-- ---------------------------------------------------------------------------
-- Moving a job.
-- ---------------------------------------------------------------------------
create or replace function public.set_production_stage(job_sid text, next_stage text)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare
    co uuid := public.current_company_id();
    current_stage production_stage;
    wanted production_stage;
    job_status text;
begin
    if co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    -- The crew move jobs through the build; the office schedules them. Both
    -- are legitimate here, and nobody else is.
    if not (coalesce(public.has_permission('RECORD_FIELD_WORK'), false)
            or coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false)) then
        raise exception 'You cannot move jobs through the build.' using errcode = '42501';
    end if;

    begin
        wanted := next_stage::production_stage;
    exception when others then
        raise exception 'There is no build stage called %.', next_stage using errcode = '22023';
    end;

    select j.production_stage, j.status::text into current_stage, job_status
      from jobs j
     where j.company_id = co and j.sync_id::text = job_sid and j.deleted_at is null;

    if job_status is null then
        raise exception 'That job is not on this company.' using errcode = '23503';
    end if;

    -- A quote is not a build. Starting production on something nobody has
    -- agreed to buy is how a company ends up with materials on a job that was
    -- never sold.
    if job_status not in ('ACCEPTED', 'COMPLETED') then
        raise exception 'This job has not been approved yet, so the build cannot start.'
            using errcode = '23514';
    end if;

    -- Moving it to where it already is changes nothing and must not write a
    -- second event: a report counting time per stage would read the gap
    -- between two identical entries as the job having gone round again.
    if current_stage is not distinct from wanted then
        return false;
    end if;

    update jobs set production_stage = wanted
     where company_id = co and sync_id::text = job_sid;

    insert into job_stage_events (company_id, job_sync_id, stage, entered_by, left_stage)
    values (co, job_sid::uuid, wanted, auth.uid(), current_stage);

    return true;
end;
$$;

revoke execute on function public.set_production_stage(text, text) from public, anon;
grant  execute on function public.set_production_stage(text, text) to authenticated;

comment on function public.set_production_stage(text, text) is
  'Moves a sold job through materials, dig, set, build, punch, done, and records the move. Refuses a job that has not been approved.';

select 'production stages installed' as done;

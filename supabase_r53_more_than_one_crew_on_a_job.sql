-- MORE THAN ONE PERSON ON A JOB.
--
-- "I want to be able to add multiple crew members to a job."
--
-- jobs.assigned_employee_sync_id holds ONE person. Everything already built
-- reads it: the crew screens, the schedule, the assignment guard, the time
-- entries. Replacing it would mean touching all of that at once, so it stays
-- exactly as it is and keeps its meaning -- THE LEAD, the one name on the
-- job -- and this table holds the rest of the crew beside them.
--
-- NO TRIGGER MIRRORS THE TWO, deliberately. The tempting version keeps
-- jobs.assigned_employee_sync_id in step with a row in here flagged as lead.
-- That needs a trigger in each direction, because either side can be written
-- first, and two triggers that write each other's tables is a loop waiting
-- for the one path nobody tested. Instead: one funnel in the app writes both,
-- and the report at the bottom of this file finds any job where they
-- disagree, so drift is visible rather than assumed away.
--
-- REMOVAL IS EXPLICIT. removed_at, never a hard delete and never inferred
-- from a device not having the row -- the same rule as r51's photos, for the
-- same reason: a half-loaded client once tombstoned 64 priced line items by
-- treating local absence as deletion.
--
-- ASSIGNING IS A PERMISSION, and it is the same one as before. Changing
-- jobs.assigned_employee_sync_id raises an error without
-- SCHEDULE_AND_ASSIGN (guard_job_assignment). If adding crew here needed
-- only company membership, that permission would be trivially routed around:
-- a crew member could put themselves on any job in the company. So the
-- policies below carry the check, not just a company match.

create table if not exists public.job_assignments (
    id               uuid primary key default gen_random_uuid(),
    company_id       uuid not null references public.companies(id) on delete cascade,
    -- By sync_id, like every other child here: the phone knows jobs and
    -- employees by sync_id, and may assign on a job the cloud has not seen.
    job_sync_id      uuid not null,
    employee_sync_id uuid not null,
    -- A label only (LEAD, HELPER, DRIVER, or blank). No rule reads it, and
    -- it is NOT how the lead is decided -- jobs.assigned_employee_sync_id is.
    crew_role        text not null default '',
    note             text not null default '',
    added_at         timestamptz not null default now(),
    added_by         uuid,
    removed_at       timestamptz,
    removed_by       text not null default '',
    is_test_fixture  boolean not null default false,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now(),
    unique (company_id, job_sync_id, employee_sync_id)
);

comment on table public.job_assignments is
  'The crew on a job BESIDE the lead. jobs.assigned_employee_sync_id is still '
  'the lead and still what existing screens read; this table does not '
  'duplicate it. Soft-removed via removed_at, never by absence (see r53).';

comment on column public.job_assignments.crew_role is
  'LEAD | HELPER | DRIVER | blank -- a label. The lead is '
  'jobs.assigned_employee_sync_id, NOT a row with crew_role = LEAD, so that '
  'two places can never disagree about who is running the job.';

create index if not exists job_assignments_company_job_idx
    on public.job_assignments (company_id, job_sync_id);
create index if not exists job_assignments_company_employee_idx
    on public.job_assignments (company_id, employee_sync_id);
create index if not exists job_assignments_company_updated_idx
    on public.job_assignments (company_id, updated_at);

drop trigger if exists job_assignments_touch_updated_at on public.job_assignments;
create trigger job_assignments_touch_updated_at
    before update on public.job_assignments
    for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS. Read is company-wide (the crew need to see who else is on a job).
-- Writing carries the assignment permission.
-- ---------------------------------------------------------------------------
alter table public.job_assignments enable row level security;

drop policy if exists job_assignments_read on public.job_assignments;
create policy job_assignments_read on public.job_assignments
    for select using (company_id = public.current_company_id());

drop policy if exists job_assignments_insert on public.job_assignments;
create policy job_assignments_insert on public.job_assignments
    for insert with check (
        company_id = public.current_company_id()
        and coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false)
    );

drop policy if exists job_assignments_update on public.job_assignments;
create policy job_assignments_update on public.job_assignments
    for update using (
        company_id = public.current_company_id()
        and coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false)
    );

drop policy if exists job_assignments_not_suspended on public.job_assignments;
create policy job_assignments_not_suspended on public.job_assignments
    as restrictive for all
    using (not public.company_is_suspended())
    with check (not public.company_is_suspended());

-- No DELETE policy: removal sets removed_at.

grant select, insert, update on public.job_assignments to authenticated;
grant select, insert, update, delete on public.job_assignments to service_role;
-- New tables arrive granted to anon through Supabase's default privileges
-- (r51 found this out the hard way), so this revoke is the line that counts.
revoke all on public.job_assignments from anon;

-- ---------------------------------------------------------------------------
-- Self-test.
-- ---------------------------------------------------------------------------
do $$
declare p text; n int; rls boolean;
begin
  select relrowsecurity into rls from pg_class where oid='public.job_assignments'::regclass;
  if not rls then raise exception 'r53 FAILED: row security is not enabled'; end if;

  -- Writing must require the permission, not merely the company.
  foreach p in array array['job_assignments_insert','job_assignments_update'] loop
      if not exists (
          select 1 from pg_policies
           where schemaname='public' and tablename='job_assignments' and policyname=p
             and coalesce(qual,'') || coalesce(with_check,'') like '%SCHEDULE_AND_ASSIGN%'
      ) then
          raise exception 'r53 FAILED: % does not require SCHEDULE_AND_ASSIGN, so any '
            'crew member could assign themselves to any job', p;
      end if;
  end loop;

  -- Reading must NOT require it -- the crew have to see who else is on a job.
  if exists (
      select 1 from pg_policies
       where schemaname='public' and tablename='job_assignments'
         and policyname='job_assignments_read'
         and coalesce(qual,'') like '%SCHEDULE_AND_ASSIGN%'
  ) then
      raise exception 'r53 FAILED: reading the crew list needs the assign permission';
  end if;

  -- CANARY for both lookups above: an invented policy name must not match.
  if exists (
      select 1 from pg_policies
       where schemaname='public' and tablename='job_assignments'
         and policyname='job_assignments_nonexistent'
  ) then
      raise exception 'r53 FAILED: the policy lookup matches invented names';
  end if;

  select count(*) into n from pg_policies
   where schemaname='public' and tablename='job_assignments' and cmd='DELETE';
  if n <> 0 then raise exception 'r53 FAILED: a DELETE policy exists'; end if;

  if not exists (
      select 1 from pg_policies
       where schemaname='public' and tablename='job_assignments'
         and policyname='job_assignments_not_suspended' and permissive='RESTRICTIVE'
  ) then raise exception 'r53 FAILED: the suspension policy is not restrictive'; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema='public' and table_name='job_assignments' and grantee='anon';
  if n <> 0 then raise exception 'r53 FAILED: anon still holds % privileges', n; end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema='public' and table_name='job_assignments' and grantee='authenticated'
     and privilege_type in ('SELECT','INSERT','UPDATE');
  if n < 3 then raise exception 'r53 FAILED: authenticated is missing grants (% of 3)', n; end if;

  raise notice 'r53 ok: rls on, writes need the permission, reads do not, anon out';
end $$;

do $$
declare cid uuid; js uuid := gen_random_uuid(); es uuid := gen_random_uuid();
begin
  select id into cid from public.companies order by created_at limit 1;
  if cid is null then raise notice 'r53: no company to probe with; skipped'; return; end if;

  insert into public.job_assignments (company_id, job_sync_id, employee_sync_id, crew_role, is_test_fixture)
  values (cid, js, es, 'HELPER', true);

  -- The same person added twice to the same job must not double. Two phones
  -- adding the same helper offline is the ordinary case, not the odd one.
  begin
      insert into public.job_assignments (company_id, job_sync_id, employee_sync_id, is_test_fixture)
      values (cid, js, es, true);
      raise exception 'r53 FAILED: the same person was added to one job twice';
  exception when unique_violation then null;
  end;

  -- Removal is a stamp, and the row stays so other devices learn about it.
  update public.job_assignments set removed_at = now() where job_sync_id = js;
  if not exists (select 1 from public.job_assignments
                  where job_sync_id = js and removed_at is not null) then
      raise exception 'r53 FAILED: removal did not stick';
  end if;

  delete from public.job_assignments where job_sync_id = js;
  raise notice 'r53 ok: one row per person per job, removal is a stamp';
end $$;

-- The drift report the header promises: any job where the lead is ALSO listed
-- here as extra crew. Expected to be empty; it is a report, not a constraint,
-- because the fix is to remove a row, not to refuse a sync.
select 'leads double-listed as extra crew' as check,
       count(*) = 0 as pass,
       count(*) as how_many
from public.job_assignments a
join public.jobs j
  on j.sync_id = a.job_sync_id and j.company_id = a.company_id
where a.removed_at is null
  and j.assigned_employee_sync_id is not null
  and j.assigned_employee_sync_id = a.employee_sync_id::text;

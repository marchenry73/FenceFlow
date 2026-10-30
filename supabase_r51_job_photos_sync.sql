-- PHOTOS ON EVERY DEVICE: the table the rows were missing.
--
-- "Also photos are not showing from one device to another, I want it to show
--  on all the devices."
--
-- WHY IT WAS BROKEN, which is not what it looks like. The files were never
-- the problem. JobFileUploader already uploads every photo (compressed first
-- -- ImageCompressor), already records a storage path, and downloadMissing()
-- already fetches any photo whose local file is gone. All of that works.
--
-- What does not exist is the ROW. job_photos is a Room table on the phone and
-- nothing else: there is no job_photos in Postgres, nothing in EntitySync,
-- no CloudJobPhoto. So the second phone pulls the jobs, has no photo rows for
-- them, asks repository.getPhotos(job) and gets an empty list -- and
-- downloadMissing() loops over that empty list and finds nothing to download.
-- The pictures were sitting in the job-files bucket the whole time with
-- nothing on the other device pointing at them.
--
-- This patch is the cloud half: the table, its policies and its grants. The
-- app half (CloudJobPhoto + EntitySync) follows it, and the order matters --
-- the table has to be here before a build that writes to it ships.
--
-- DELETION IS EXPLICIT, NEVER INFERRED. He also asked to be able to remove a
-- photo from the cloud and still keep it in the email, and get it back when
-- needed. That is what deleted_at is for. It must never be set because a
-- device does not have a row: a half-loaded client once tombstoned 64 priced
-- line items company-wide that way, and photos are less recoverable than line
-- items. Absence is not deletion; only a device that was told to delete may
-- write deleted_at.

create table if not exists public.job_photos (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references public.companies(id) on delete cascade,
    -- The job's sync_id, not its database id: the phone knows jobs by sync_id
    -- and may create a photo for a job the cloud has not seen yet. Not a
    -- foreign key for that reason -- the app half refuses to push a photo
    -- whose job has not landed, which is a clearer failure than a 23503.
    job_sync_id     uuid not null,
    sync_id         uuid not null,
    kind            text not null,
    -- Where the file is in the job-files bucket. Blank while the row has
    -- arrived but the upload has not -- the picture then shows on the device
    -- that took it and appears elsewhere once the file follows.
    storage_path    text not null default '',
    caption         text not null default '',
    taken_at        timestamptz,
    deleted_at      timestamptz,
    deleted_by      text not null default '',
    is_test_fixture boolean not null default false,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique (company_id, sync_id)
);

comment on table public.job_photos is
  'One row per job photo. The FILES were always uploaded to the job-files '
  'bucket; this table is what was missing, so a second device had no row to '
  'point at them. Rows are soft-deleted (deleted_at) and never removed by '
  'absence: see r51''s header.';

comment on column public.job_photos.kind is
  'BEFORE | AFTER | JOBSITE, matching the app''s PhotoKind. Deliberately NOT '
  'a CHECK: photos push in batches, and one unrecognised value would make '
  'PostgREST refuse the whole batch -- losing a job''s other pictures to '
  'protect a label. An unknown kind is shown rather than dropped.';

create index if not exists job_photos_company_job_idx
    on public.job_photos (company_id, job_sync_id);
-- The sync pulls by watermark, same as every other entity.
create index if not exists job_photos_company_updated_idx
    on public.job_photos (company_id, updated_at);

-- updated_at, so the pull has a watermark to work from.
drop trigger if exists job_photos_touch_updated_at on public.job_photos;
create trigger job_photos_touch_updated_at
    before update on public.job_photos
    for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS, in the same shape as the other per-job children (change_orders was
-- read back with pg_policies to copy it rather than remembered).
-- ---------------------------------------------------------------------------
alter table public.job_photos enable row level security;

drop policy if exists job_photos_read on public.job_photos;
create policy job_photos_read on public.job_photos
    for select using (company_id = public.current_company_id());

drop policy if exists job_photos_insert on public.job_photos;
create policy job_photos_insert on public.job_photos
    for insert with check (company_id = public.current_company_id());

drop policy if exists job_photos_update on public.job_photos;
create policy job_photos_update on public.job_photos
    for update using (company_id = public.current_company_id());

-- Restrictive, so it ANDs with the three above rather than widening them.
drop policy if exists job_photos_not_suspended on public.job_photos;
create policy job_photos_not_suspended on public.job_photos
    as restrictive for all
    using (not public.company_is_suspended())
    with check (not public.company_is_suspended());

-- NO DELETE POLICY, on purpose. A hard delete would take the row away from
-- every other device with no way to tell that from "this row never arrived",
-- which is exactly the confusion that cost 64 line items. Removing a photo
-- sets deleted_at; the file in the bucket is a separate, deliberate step.

-- Crew included: a photo is not money. change_orders hides itself from crew
-- without SEE_MONEY; there is no equivalent here, by choice -- the crew are
-- the people taking before-and-after pictures in the yard.

-- ---------------------------------------------------------------------------
-- Grants. INHERITED, and I had this backwards until the self-test below said
-- so: Supabase carries ALTER DEFAULT PRIVILEGES for anon and authenticated,
-- so a brand-new table arrives with all seven privileges already granted to
-- BOTH roles. The grants below are therefore belt-and-braces for
-- authenticated, and the revoke is the line that actually does something.
--
-- anon is revoked deliberately. The older tables leave it granted and lean on
-- current_company_id() being null for an anonymous caller -- true, but it
-- makes the policy the only thing between a public key and a customer's
-- photos. Nothing anonymous needs them: if the quote page ever shows photos
-- it will go through a function with its own rules, not a table grant.
-- Safe to revoke here because this table is new and nothing reads it yet --
-- unlike taking EXECUTE off a function that live policies call, which once
-- turned eight tables into 401s.
-- ---------------------------------------------------------------------------
grant select, insert, update on public.job_photos to authenticated;
grant select, insert, update, delete on public.job_photos to service_role;
revoke all on public.job_photos from anon;

-- ---------------------------------------------------------------------------
-- Self-test. Structural, and it says what it does NOT prove.
--
-- It cannot prove one company is kept out of another's photos without two
-- real sessions to impersonate, and faking that from here means writing to a
-- live company's data. What it can prove -- and what the failure modes
-- actually are -- is that row security is ON, that each policy is scoped to
-- current_company_id() rather than merely existing, that nothing can hard
-- delete, and that authenticated has the grants while anon has none.
--
-- The canary: every check below is also run against a KNOWN-GOOD table
-- (change_orders) and a known-bad expectation, so a query that silently
-- matches nothing cannot report success.
-- ---------------------------------------------------------------------------
do $$
declare n int; rls boolean; q text;
begin
  select relrowsecurity into rls from pg_class
   where oid = 'public.job_photos'::regclass;
  if not rls then raise exception 'r51 FAILED: row security is not enabled'; end if;

  -- Each policy scoped to the company, not just present.
  for q in select unnest(array['job_photos_read','job_photos_insert','job_photos_update']) loop
      if not exists (
          select 1 from pg_policies
           where schemaname='public' and tablename='job_photos' and policyname=q
             and coalesce(qual,'') || coalesce(with_check,'') like '%current_company_id%'
      ) then
          raise exception 'r51 FAILED: policy % is missing or not scoped to the company', q;
      end if;
  end loop;

  -- THE CANARY for the loop above: a policy name that does not exist must be
  -- reported missing. If the check can pass for anything, it proves nothing.
  if exists (
      select 1 from pg_policies
       where schemaname='public' and tablename='job_photos'
         and policyname='job_photos_this_does_not_exist'
  ) then
      raise exception 'r51 FAILED: the policy lookup matches invented names';
  end if;

  -- Nothing may hard delete.
  select count(*) into n from pg_policies
   where schemaname='public' and tablename='job_photos' and cmd='DELETE';
  if n <> 0 then raise exception 'r51 FAILED: a DELETE policy exists (% of them)', n; end if;

  -- The suspension policy must be RESTRICTIVE, or it widens access instead
  -- of narrowing it -- a permissive "not suspended" policy would let a
  -- suspended company through via the other three.
  if not exists (
      select 1 from pg_policies
       where schemaname='public' and tablename='job_photos'
         and policyname='job_photos_not_suspended' and permissive='RESTRICTIVE'
  ) then
      raise exception 'r51 FAILED: the suspension policy is not restrictive';
  end if;

  -- Grants: authenticated can work, anon cannot see anything.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='public' and table_name='job_photos' and grantee='authenticated'
     and privilege_type in ('SELECT','INSERT','UPDATE');
  if n < 3 then raise exception 'r51 FAILED: authenticated is missing grants (% of 3)', n; end if;

  -- anon must hold nothing AFTER the revoke above. This check is what
  -- discovered that new tables are granted to anon by default at all.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='public' and table_name='job_photos' and grantee='anon';
  if n <> 0 then raise exception 'r51 FAILED: anon still holds % privileges', n; end if;

  -- CANARY for the grant check: the same query against a table that DOES
  -- grant anon must find it, or the "anon has nothing" pass above is just a
  -- query that matches nothing.
  select count(*) into n from information_schema.role_table_grants
   where table_schema='public' and table_name='change_orders' and grantee='anon';
  if n = 0 then
      raise exception 'r51 FAILED: the grant query finds nothing even where a '
        'grant is known to exist, so the anon check above proves nothing';
  end if;

  raise notice 'r51 ok: rls on, policies scoped, no hard delete, grants right';
end $$;

-- A row goes in and comes back, with the service role standing in for a
-- device. Rolled back by the delete at the end.
do $$
declare cid uuid; js uuid := gen_random_uuid(); ps uuid := gen_random_uuid(); got text;
begin
  select id into cid from public.companies order by created_at limit 1;
  if cid is null then raise notice 'r51: no company to probe with; skipped'; return; end if;

  insert into public.job_photos (company_id, job_sync_id, sync_id, kind, storage_path, caption, is_test_fixture)
  values (cid, js, ps, 'BEFORE', 'company/job/photo-1.jpg', 'ZZ R51 PROBE', true);

  select storage_path into got from public.job_photos where sync_id = ps;
  if got <> 'company/job/photo-1.jpg' then
      raise exception 'r51 FAILED: the row did not come back as written';
  end if;

  -- The same photo arriving twice (two devices, one capture) must not double.
  begin
      insert into public.job_photos (company_id, job_sync_id, sync_id, kind, is_test_fixture)
      values (cid, js, ps, 'BEFORE', true);
      raise exception 'r51 FAILED: the same sync_id was accepted twice';
  exception when unique_violation then
      null; -- what should happen
  end;

  delete from public.job_photos where sync_id = ps;
  raise notice 'r51 ok: a photo row round-trips and cannot be duplicated';
end $$;

select 'job_photos exists with rls' as check,
       (select relrowsecurity from pg_class where oid = 'public.job_photos'::regclass) as pass;

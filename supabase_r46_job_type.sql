-- WHAT KIND OF JOB THIS IS: residential, commercial, or something else.
--
-- "I want the pricing to show whether it's residential, or commercial etc...
-- plus the other stuff that are already on there."
--
-- A LABEL, NOT A RATE. Asked whether it should drive different pricing or just
-- say which it is, the owner chose the label. So nothing in either engine reads
-- this column: it is carried, shown on the pricing screen, the office and the
-- quote, and changes no figure. That is why there is no PRICING_ENGINE_VERSION
-- bump and no fixture regeneration with it -- and why, if it ever does start
-- driving rates, that will be a formula change with all of that attached.
--
-- BLANK BY DEFAULT, and that is deliberate. Every job that already exists was
-- quoted without anybody being asked this question, and writing 'RESIDENTIAL'
-- across all of them would be the app inventing a fact about 70-odd real jobs.
-- Blank reads as "not said", which is the truth.
--
-- A COLUMN RATHER THAN AN ENUM TYPE, for the same reason r45 used columns: an
-- older phone's cloudJson sets ignoreUnknownKeys, so it ignores this entirely
-- and corrupts nothing, while a new value in an existing enum would be read by
-- an old build as the enum's fallback and pushed back wrong.

alter table public.jobs
  add column if not exists job_type text not null default '';

comment on column public.jobs.job_type is
  'RESIDENTIAL | COMMERCIAL | OTHER, or blank for not said. A label only: no '
  'pricing rule reads it. Blank on every job that existed before 2026-10-29, '
  'because nobody was asked.';

-- Anything the app does not recognise reads as blank rather than being
-- refused: a constraint here would fail a whole fence_runs-style batch upsert
-- for one bad value, and the readers judge instead. Kept as a CHECK that
-- allows blank so a typo still cannot reach a quote as a category.
do $$
begin
  if not exists (
      select 1 from pg_constraint where conname = 'jobs_job_type_known'
  ) then
      alter table public.jobs
        add constraint jobs_job_type_known
        check (job_type in ('', 'RESIDENTIAL', 'COMMERCIAL', 'OTHER'))
        not valid;
  end if;
end $$;

-- NOT VALID above, then validated separately: every existing row is '' so the
-- validation passes immediately, but doing it in two steps means a table scan
-- that takes a lock for as short a time as possible, and a row that somehow
-- failed would leave the constraint un-validated rather than the migration
-- half-applied.
alter table public.jobs validate constraint jobs_job_type_known;

-- ---------------------------------------------------------------------------
-- Self-test: the column exists, blank is allowed, a known value is allowed,
-- and a made-up one is refused. Rolled back whatever happens.
-- ---------------------------------------------------------------------------
do $$
declare cid uuid; js uuid := gen_random_uuid(); refused boolean := false;
begin
  select id into cid from public.companies order by created_at limit 1;
  if cid is null then raise notice 'r46: no company to probe with; skipped'; return; end if;

  insert into public.jobs (company_id, sync_id, customer_name, status, is_test_fixture)
  values (cid, js, 'ZZ R46 PROBE', 'DRAFT', true);

  update public.jobs set job_type = 'COMMERCIAL' where sync_id = js;
  if (select job_type from public.jobs where sync_id = js) <> 'COMMERCIAL' then
      raise exception 'r46 FAILED: a known value did not stick';
  end if;

  update public.jobs set job_type = '' where sync_id = js;
  if (select job_type from public.jobs where sync_id = js) <> '' then
      raise exception 'r46 FAILED: blank was not allowed';
  end if;

  begin
      update public.jobs set job_type = 'SOMETHING ELSE' where sync_id = js;
  exception when check_violation then
      refused := true;
  end;
  if not refused then
      raise exception 'r46 FAILED: an unknown category reached the row';
  end if;

  delete from public.jobs where sync_id = js;
  raise notice 'r46 ok: blank and the three known values allowed, anything else refused';
end $$;

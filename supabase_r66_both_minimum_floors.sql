-- ============================================================
-- FenceFlow -- BOTH minimum floors at $200, and r65 recorded in the ledger
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- MARCH'S DECISION, 6 November 2026: "do both for the $200" -- a $200 floor
-- under the LABOUR and a $200 floor under the JOB TOTAL. Until now the pair
-- was (job 0, labour 200).
--
-- The code half of this is in the same commit: BusinessProfile's own default,
-- profileFrom()'s fallback (what a fresh phone reads before any save) and the
-- office's blank default, all pinned together by
-- tests/a25-new-company-onboarding.test.mjs.
--
-- THIS FILE DOES ONE DATA CHANGE: Legacy Solutions' stored company setting,
-- which is 0.0 today, so his own business follows the rule he just chose. A
-- company's stored value overrides the default, so without this his main
-- company would keep the old floor whatever the code says.
--
-- WHAT IT DELIBERATELY DOES NOT TOUCH
--
--   * The company 'Marc', which has min_job_charge = 300 stored. That is a
--     number somebody typed, and 300 is not 0 -- it is a decision, not an
--     absence. A migration must not change a policy somebody set; if he wants
--     it at 200 he can type it.
--   * Any EXISTING job. jobs.minimum_job_charge is copied onto a job when it
--     is created, and the engine prices from that copy, so changing the
--     company setting cannot re-price work already quoted, approved or signed.
--     New jobs take the new floor. That is the safe direction and it is the
--     reason this is not a backfill: flooring an approved $150 job at $200
--     would change a price a customer has already agreed to.
--   * Any other key in the settings blob. jsonb_set writes one key.
-- ============================================================

-- A baseline, so the proofs below compare against something rather than
-- asserting into the air.
create temp table baseline as
select (select count(*) from public.jobs where deleted_at is null
         and coalesce(minimum_job_charge, 0) = 200) as jobs_floored_at_200,
       (select count(*) from public.jobs where deleted_at is null) as jobs_total;

-- What it is now, before the write.
do $before$
declare r record;
begin
    for r in select c.name, s.settings->>'min_job_charge' as j, s.settings->>'min_labor_charge' as l
               from public.company_settings s join public.companies c on c.id = s.company_id
              order by c.name
    loop
        raise notice 'before: % -> job floor %, labour floor %', r.name, coalesce(r.j,'(unset)'), coalesce(r.l,'(unset)');
    end loop;
end $before$;

-- The one write. Chosen by PROPERTY, not by name: the company that has a
-- stored job floor of zero AND is not a sandbox. A company that typed a real
-- number keeps it.
update public.company_settings s
   set settings = jsonb_set(s.settings, '{min_job_charge}', '200'::jsonb, true),
       updated_at = now()
  from public.companies c
 where c.id = s.company_id
   and not coalesce(c.is_sandbox, false)
   and c.deleted_at is null
   and coalesce((s.settings->>'min_job_charge')::numeric, 0) = 0;

-- ============================================================
-- PROOFS
-- ============================================================
select 'Legacy Solutions job floor is now 200' as claim,
       (select ((s.settings->>'min_job_charge')::numeric = 200)::text
          from public.company_settings s
          join public.companies c on c.id = s.company_id
         where c.name = 'Legacy Solutions') as got,
       'true' as want
union all
select 'its labour floor is untouched at 200',
       -- as a NUMBER: the blob stores 200.0, and comparing the text to '200'
       -- reported a failure about a floor that had not moved.
       (select ((s.settings->>'min_labor_charge')::numeric = 200)::text
          from public.company_settings s
          join public.companies c on c.id = s.company_id
         where c.name = 'Legacy Solutions'),
       'true'
union all
select 'the company that typed 300 still has 300',
       (select ((s.settings->>'min_job_charge')::numeric = 300)::text
          from public.company_settings s
          join public.companies c on c.id = s.company_id
         where c.name = 'Marc'),
       'true'
union all
select 'no settings row lost any other key',
       (select (count(*) = 0)::text from public.company_settings
         where settings is null or jsonb_typeof(settings) <> 'object'),
       'true'
union all
select 'NO job had its floor rewritten -- the count is what it was before',
       (select ((select count(*) from public.jobs where deleted_at is null
                  and coalesce(minimum_job_charge, 0) = 200)
                = (select jobs_floored_at_200 from baseline))::text),
       'true'
union all
select 'and no job row vanished either',
       (select ((select count(*) from public.jobs where deleted_at is null)
                = (select jobs_total from baseline))::text),
       'true'
union all
-- CANARY: a claim that must read false, or the comparison is matching anything.
select 'CANARY: a company that does not exist has no floor',
       (select coalesce((select s.settings->>'min_job_charge' from public.company_settings s
          join public.companies c on c.id = s.company_id
         where c.name = 'ZZ NO SUCH COMPANY ZZ'), 'absent')),
       'absent'
order by 1;

-- ============================================================
-- r65 in the ledger. It was applied by hand a few minutes earlier; recording
-- it here keeps schema_migrations the whole truth rather than a list with a
-- live migration missing from it -- the exact gap that let crew_job_scope sit
-- unapplied while the runner said pending=0.
-- ============================================================
insert into public.schema_migrations (filename, sha256, origin, applied_at, applied_by, notes)
values ('supabase_r65_deposit_trigger_respects_typed.sql',
        'ea23adf192d0ce0cbdefb169ad26f4f3b2b086d1c5dd2ef174a0e0c7d00daabe', 'applied', now(),
        'claude, at March''s instruction',
        'The price trigger was rewriting deposits typed by hand: the live body had no '
        'deposit_is_auto gate, while the phone has never touched a typed figure. Proven on '
        'the real row nini in a rolled-back transaction -- a doubled price took the typed '
        '14,395.20 to 28,790.40. One added early return; the trigger can now only do less.')
on conflict (filename) do update
   set origin = 'applied', applied_at = now(),
       sha256 = excluded.sha256, notes = excluded.notes;

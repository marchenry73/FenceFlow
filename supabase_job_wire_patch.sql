-- Job wire expansion: the app synced only part of the job row, and a
-- cloud-newer merge stamped wire defaults over the phone's real values.
-- That is how a job's minimum charge became 0 and a gate-only estimate
-- skipped the minimum entirely.
--
-- Everything here is additive. The new value columns default to 0 / ''
-- on purpose: the app's merge treats those as "the cloud has nothing"
-- and keeps the phone's value, so an old row can never overwrite real
-- pricing with a default that merely looks plausible.

alter table public.jobs
  add column if not exists gate_rate_per_ft double precision not null default 0,
  add column if not exists trash_haul_fee double precision not null default 0,
  add column if not exists pricing_tier_name text not null default '',
  add column if not exists tip_amount double precision not null default 0,
  add column if not exists grid_feet_per_square double precision not null default 0,
  add column if not exists calibration_pixels_per_foot double precision,
  add column if not exists calibration_known_feet double precision,
  add column if not exists blocked_at timestamptz,
  add column if not exists customer_notified_at timestamptz,
  add column if not exists payment_link_url text not null default '',
  add column if not exists payment_link_amount double precision not null default 0;

-- Repair: restore the company's $200 minimum on rows the old merge had
-- zeroed. Bumping updated_at makes every phone pull the corrected value;
-- the merge guard lets 200 replace a local 0 but never the reverse.
update public.jobs
   set minimum_job_charge = 200,
       updated_at = now()
 where minimum_job_charge = 0
   and company_id = (
     select company_id from public.profiles
      where id = '7bf38947-24cf-4e79-9af0-6100d04b166b'
   );

select count(*) as repaired_minimums,
       (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'jobs'
           and column_name in ('gate_rate_per_ft','trash_haul_fee','pricing_tier_name',
             'tip_amount','grid_feet_per_square','calibration_pixels_per_foot',
             'calibration_known_feet','blocked_at','customer_notified_at',
             'payment_link_url','payment_link_amount')) as new_columns
  from public.jobs
 where minimum_job_charge = 200;

-- Tell "nobody has ever set this" apart from "this really is zero".
--
-- These columns were NOT NULL defaulting to 0, so a row written before the
-- column existed looked exactly like a job whose trash haul really is zero.
-- The app guarded against that by refusing to accept a zero from the cloud --
-- which stopped an old row wiping real pricing, but also meant a price
-- genuinely changed to zero on one phone could never reach another. Setting a
-- trash haul fee back to 0, or clearing a tip, simply did not travel.
--
-- Nullable makes the two cases different values. The app always writes a real
-- number, so NULL can only mean no app has ever set it. Nothing is deleted:
-- every existing 0 stays 0.
alter table public.jobs
  alter column minimum_job_charge drop not null,
  alter column gate_rate_per_ft   drop not null,
  alter column trash_haul_fee     drop not null,
  alter column tip_amount         drop not null;

select column_name, is_nullable from information_schema.columns
 where table_schema='public' and table_name='jobs'
   and column_name in ('minimum_job_charge','gate_rate_per_ft','trash_haul_fee','tip_amount')
 order by column_name;

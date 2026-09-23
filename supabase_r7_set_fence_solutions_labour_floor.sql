-- ============================================================
-- FenceFlow -- turn the $200 labour floor on for Fence solutions
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   DATA. One key added to one company's settings JSON. No schema change, no
--   function replaced, no existing key overwritten, nothing deleted.
--
-- WHAT IT DOES
--   Sets the COMPANY DEFAULT only: company_settings.settings -> min_labor_charge.
--   A job created from here on starts with a $200 labour floor, on the phone and
--   in the office both (SettingsStore.defaultMinimumLaborCharge on one side, the
--   s_min_labor field on the other, kept in step by CloudSettings.min_labor_charge).
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   It does not touch jobs.minimum_labor_charge on any EXISTING job. Every job
--   carries its own copy of the pricing it was quoted under -- that is the whole
--   reason the columns live on jobs and not only in settings -- and rewriting
--   them here would silently re-price work already drawn up. On 2026-09-23 that
--   is four live drafts (James, Woody, and two unnamed), each of which would move.
--   A signed job would not move at all, because jobs.accepted_total anchors it
--   (supabase_r7_reports_accepted_price.sql), but a draft the owner is about to
--   send would.
--
--   If he wants the existing drafts lifted too, that is a separate, deliberate
--   statement and it should name them:
--     update jobs set minimum_labor_charge = 200
--      where company_id = '<id>' and status = 'DRAFT' and deleted_at is null;
--   Left commented out, and for him to ask for, because it changes the price of
--   a quote that may already have been spoken about.
--
-- The whole-job minimum (minimum_job_charge, $200) is untouched and stays --
-- the owner asked for both floors, one under labour and one under the quote.
-- ============================================================

insert into public.company_settings (company_id, settings)
select c.id, jsonb_build_object('min_labor_charge', 200)
  from companies c
 where c.id = (select p.company_id from profiles p
                join auth.users u on u.id = p.id
               where u.email = 'marchenry73@gmail.com')
on conflict (company_id) do update
   set settings = public.company_settings.settings || jsonb_build_object('min_labor_charge', 200),
       updated_at = now();

-- Prove it, and prove what was NOT touched.
select 'the company default is $200' as check,
       (select settings ->> 'min_labor_charge' = '200' from company_settings s
         where s.company_id = (select p.company_id from profiles p
                                join auth.users u on u.id = p.id
                               where u.email = 'marchenry73@gmail.com')) as ok
union all
select 'the other settings keys survived the merge',
       (select count(*) >= 1 from company_settings s
         where s.company_id = (select p.company_id from profiles p
                                join auth.users u on u.id = p.id
                               where u.email = 'marchenry73@gmail.com')
           and s.settings ? 'min_labor_charge')
union all
select 'no existing job was re-priced by this file',
       (select count(*) = 0 from jobs j
         where j.company_id = (select p.company_id from profiles p
                                join auth.users u on u.id = p.id
                               where u.email = 'marchenry73@gmail.com')
           and j.deleted_at is null
           and coalesce(j.minimum_labor_charge, 0) <> 0)
union all
select 'the whole-job minimum is untouched',
       (select count(*) > 0 from jobs j
         where j.company_id = (select p.company_id from profiles p
                                join auth.users u on u.id = p.id
                               where u.email = 'marchenry73@gmail.com')
           and j.minimum_job_charge = 200);

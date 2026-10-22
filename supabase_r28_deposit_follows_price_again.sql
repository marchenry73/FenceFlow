-- ============================================================
-- FenceFlow -- the deposit follows the price again, but only while it is
-- still the app's own figure.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- WHAT HE SAW. "On the estimate, the deposit asked is not automatically
-- updating. I want this to work even when the price changes." He is right.
-- The deposit was written ONCE, the first time a job had a price, and never
-- again, because the only thing that wrote it refused outright whenever a
-- deposit was already there.
--
-- WHY IT REFUSED, AND WHY THAT STILL MATTERS. Two incidents paid for that
-- refusal: an older auto-fill overwrote a deposit a PERSON had typed (John
-- Beaunissant's moved from $9,910 to $5,730 ten seconds after he signed), and
-- a trigger on THIS TABLE called deposit_follows_price rescaled stored
-- deposits in proportion to every re-price, behind his back. That trigger was
-- dropped on 1 October 2026 and two jobs still carry the figures it left. So
-- "always follow the price" is the bug that was fixed, not the fix.
--
-- THE ROOT CAUSE IS THAT A STORED DEPOSIT HAS NO PROVENANCE. deposit_amount is
-- one number and nothing says whether the app worked it out or a person chose
-- it, so one rule had to cover both. This adds the missing bit.
--
--     deposit_is_auto = true   the app's own suggestion. It follows the price.
--     deposit_is_auto = false  a person's figure. It never moves.
--
-- And unchanged on top of both: once the customer has approved, signed or
-- paid, nothing moves it at all.
--
-- NOT A TRIGGER. The dropped one did this work in the database, where the
-- owner could not see it and could not stop it. This is a column; the phone
-- and price-job decide, in code that is read and tested, and the write is an
-- ordinary update somebody can look at in the audit log.
-- ============================================================

alter table public.jobs
  add column if not exists deposit_is_auto boolean not null default false;

comment on column public.jobs.deposit_is_auto is
  'deposit_amount is the app''s own suggestion and may follow the price. False means a person chose that figure and it must never be moved. See supabase_r28_deposit_follows_price_again.sql.';

-- ---- the grants, which do NOT come for free ------------------------------
-- companies-style per-column grants are a standing hazard on this project: a
-- new column is ungranted, and the first read of it fails for everyone. jobs
-- is granted table-wide today, and this re-states it so the column is covered
-- whichever way that goes.
grant select, insert, update on public.jobs to authenticated;

-- ---- the backfill, which is a judgement, not a formality -----------------
-- A job nobody has approved, signed or paid anything on is still a draft: its
-- deposit came from the app the first time the job was priced, and following
-- the price is exactly what was asked for. A job the customer IS in keeps
-- false -- not because the bit would change anything there (the freeze applies
-- regardless) but because calling a figure they agreed to "the app's" is a
-- claim that is not true.
--
-- THE HONEST LIMIT: a deposit typed by hand on a job that is not yet approved
-- is swept in here and will start following the price. Nothing anywhere
-- distinguishes it -- that absence is the bug -- and of the two wrong answers,
-- a draft deposit that tracks the price beats a draft deposit frozen at a
-- price that no longer exists. Every job from here on records the truth.
update public.jobs
   set deposit_is_auto = true
 where deposit_amount > 0
   and quote_approved_at is null
   and signed_at is null
   and coalesce(amount_paid, 0) = 0
   and deleted_at is null
   and deposit_is_auto is false;

-- ------------------------------------------------------------------------
-- PROOF.
-- ------------------------------------------------------------------------
select 'the column exists' as check,
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'jobs'
                            and column_name = 'deposit_is_auto')
            then 'PASS' else 'FAIL' end as result
union all
select 'the app can read it',
       case when has_column_privilege('authenticated', 'public.jobs', 'deposit_is_auto', 'select')
            then 'PASS' else 'FAIL -- every job read will fail for every phone' end
union all
select 'and write it',
       case when has_column_privilege('authenticated', 'public.jobs', 'deposit_is_auto', 'update')
            then 'PASS' else 'FAIL -- the deposit can never be marked automatic' end
union all
-- POSITIVE CONTROL: the backfill did something. Without this the two refusal
-- checks below would both pass against a table where nothing was touched.
select 'drafts now follow the price',
       case when (select count(*) from jobs
                   where deposit_is_auto and deleted_at is null) > 0
            then 'PASS (' || (select count(*)::text from jobs where deposit_is_auto and deleted_at is null)
                 || ' jobs)'
            else 'FAIL -- nothing was backfilled, so nothing will follow' end
union all
select 'nothing the customer is in was marked automatic',
       case when (select count(*) from jobs
                   where deposit_is_auto and deleted_at is null
                     and (quote_approved_at is not null or signed_at is not null
                          or coalesce(amount_paid, 0) > 0)) = 0
            then 'PASS'
            else 'FAIL -- an agreed deposit is marked as the app''s to move' end
union all
select 'a job with no deposit was not marked',
       case when (select count(*) from jobs
                   where deposit_is_auto and coalesce(deposit_amount, 0) = 0) = 0
            then 'PASS' else 'FAIL -- a zero deposit claims to be a suggestion' end
union all
-- The trigger that did this badly must still be gone. If it ever comes back,
-- two things move the same figure and neither knows about the other.
select 'the old rescaling trigger is still dropped',
       case when (select count(*) from pg_trigger t
                   join pg_class c on c.oid = t.tgrelid
                   join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'jobs'
                    and not t.tgisinternal and t.tgname ilike '%deposit%') = 0
            then 'PASS' else 'FAIL -- deposit_follows_price is back, and now there are two of them' end
union all
select 'how it stands now',
       (select count(*) filter (where deposit_is_auto)::text || ' follow, ' ||
               count(*) filter (where not deposit_is_auto and deposit_amount > 0)::text || ' fixed by hand or agreed'
          from jobs where deleted_at is null);

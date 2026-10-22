-- ============================================================
-- FenceFlow -- deposit_is_auto joins the money columns.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- FOUND BY A TEST, which is the only reason it is here. The app's own
-- ScrubMoneyCoverageTest reads JobDao.scrubMoney's SQL out of Daos.kt and
-- fails for any MONEY_KEYS column the scrub forgets. deposit_is_auto was
-- added to MONEY_KEYS this afternoon and to neither of the two places that
-- have to agree with it: the phone's scrub, and this function.
--
-- THE TWO LISTS ARE KEPT SIDE BY SIDE BY HAND and they have drifted before --
-- accepted_total joined MONEY_KEYS with the price-stability change and the
-- scrub was never told, so a phone demoted to crew kept every customer's
-- accepted price on disk, and the crew adoption merge then held it for good.
-- This is the same shape, caught a few hours in rather than weeks.
--
-- WHAT WAS ACTUALLY EXPOSED: nothing a crew phone could READ. jobs_crew, the
-- view that is a crew phone's whole window onto a job, does not carry the
-- column, and it was checked rather than assumed. What a crew phone COULD do
-- is WRITE it: crew_save_job and the hold_money_columns trigger both drop
-- money columns by this list, so a column missing from it is a column a crew
-- write is allowed to set. A crew phone could have flipped a job's deposit to
-- "the app's figure", and the next time the owner opened that estimate the
-- deposit would have moved on its own.
--
-- WHY IT IS A MONEY COLUMN AT ALL. It is not an amount, but it decides whether
-- an amount may change -- and the rule this whole list exists for is that crew
-- never read or write anything that moves a price.
-- ============================================================

create or replace function public.job_money_columns()
returns text[]
language sql
immutable
as $$
    select array[
        'tax_rate_percent', 'markup_percent', 'discount_percent',
        'labor_rate_per_ft', 'labor_flat_fee', 'minimum_job_charge',
        'teardown_flat_fee', 'teardown_rate_per_ft', 'gate_rate_per_ft', 'trash_haul_fee',
        'deposit_amount', 'amount_paid', 'refunded_amount', 'refunded_at', 'refund_reason',
        'payment_status', 'is_invoiced', 'payments_from_processor',
        'contract_total', 'signed_contract_total', 'tip_amount',
        'payment_link_url', 'payment_link_amount',
        'pricing_tier_name', 'supplier_quote_reference',
        'quote_token', 'quote_sent_at', 'quote_viewed_at',
        'accepted_total',
        -- Floor under labour alone, before markup (r7_minimum_labour_charge). A
        -- price, so crew never read it and never write it -- same reason
        -- minimum_job_charge is on this list.
        'minimum_labor_charge',
        -- Whether deposit_amount is the app's own suggestion and may follow the
        -- price (r28). Not an amount; it decides whether an amount moves, which
        -- is the same thing as far as this list is concerned.
        'deposit_is_auto'
    ]
$$;

-- ------------------------------------------------------------------------
-- PROOF.
-- ------------------------------------------------------------------------
select 'deposit_is_auto is a money column' as check,
       case when 'deposit_is_auto' = any(public.job_money_columns())
            then 'PASS' else 'FAIL' end as result
union all
-- POSITIVE CONTROL: the list did not lose anything on the way past. 31 now,
-- which is the 30 that were there plus the one added.
select 'the list is still all of itself',
       case when array_length(public.job_money_columns(), 1) = 31
            then 'PASS'
            else 'FAIL -- ' || array_length(public.job_money_columns(), 1)::text || ' columns, expected 31' end
union all
select 'accepted_total is still on it',
       case when 'accepted_total' = any(public.job_money_columns()) then 'PASS' else 'FAIL' end
union all
select 'deposit_amount is still on it',
       case when 'deposit_amount' = any(public.job_money_columns()) then 'PASS' else 'FAIL' end
union all
-- CANARY: a name that must NOT be on it, so "is any() working" is answered
-- rather than assumed.
select 'CANARY: a column that is not money is not on it',
       case when 'customer_name' = any(public.job_money_columns())
            then 'FAIL -- the membership test is not discriminating' else 'PASS' end
union all
-- The two callers still resolve it. Both read it at call time, so this is
-- really asking whether they still exist and still reference it.
select 'both callers still use the list',
       case when (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname in ('crew_save_job', 'hold_money_columns')
                     and pg_get_functiondef(p.oid) ilike '%job_money_columns%') = 2
            then 'PASS' else 'FAIL -- a caller stopped reading the list' end
union all
-- And the thing that was never exposed, stated as a fact rather than a claim.
select 'a crew phone still cannot READ it',
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'jobs_crew'
                            and column_name = 'deposit_is_auto')
            then 'FAIL -- the crew view carries it' else 'PASS' end;

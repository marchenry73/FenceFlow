-- ============================================================
-- FenceFlow -- a floor under labour alone, applied before markup
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   ADDITIVE           jobs.minimum_labor_charge (a new column, default 0).
--   FUNCTION-REPLACING job_money_columns(). The body is the LIVE one
--                      (supabase_r6_price_stability.sql, 2026-09-21, with
--                      accepted_total appended) with one more element
--                      appended, guarded the same way that file guarded its
--                      own append: if the live list has grown since this was
--                      written, replacing it blind would silently drop a
--                      money column from the crew shield, so it stops instead.
--   No row is written, no policy changes, nothing is dropped.
--
-- WHAT IT IS FOR
--   labourCost = max(laborFlatFee + laborRatePerFt * feet, minimumLaborCharge),
--   applied BEFORE markup, tax and discount -- it replaces the labour figure
--   that feeds the pre-markup subtotal, so markup earns on the floored labour
--   exactly as it would on real labour. This is a per-job floor under LABOUR
--   ALONE; it does not touch jobs.minimum_job_charge, the existing floor under
--   the whole quote after markup/tax/discount
--   (grandTotal = ceil(max(afterDiscount, minimum_job_charge) / 10) * 10),
--   which stays exactly as it is. A company that leaves this at its default
--   of 0 is unaffected -- but NOT because max(x, 0) is x. It is not: laborFeet
--   is clamped at zero, laborFlatFee is not, and a negative flat fee is how an
--   estimator knocks money off a quote. max(-150, 0) is 0, so a bare max would
--   have swallowed the credit and put an untouched company's quote UP. Both
--   engines therefore apply the floor only when it is above zero, which is what
--   makes "0 means off" literally true rather than nearly true.
--
-- WHY A NEW COLUMN AND NOT A CHANGED MEANING
--   minimum_job_charge already means "floor under the whole job." Redefining
--   it to also floor labour first would have silently re-priced every company
--   on this database that already sets one. This column defaults to 0 so
--   every company that never sets it prices exactly as it does today.
--
-- CREW PROTECTION -- the door and the pens are GENERATED from
-- job_money_columns(), not typed per-column (see supabase_crew_money_shield_patch.sql
-- and supabase_r6_price_stability.sql PART 2):
--   * public.jobs_crew's column list is `information_schema.columns` for jobs
--     minus job_money_columns() -- appending here is what hides the new column;
--   * hold_money_columns(), run with no arguments on the jobs trigger, defaults
--     its `cols` to job_money_columns() -- appending here is what puts a crew
--     phone's write to this column back to what it was;
--   * crew_save_job()'s drop_keys is job_money_columns() plus the row-identity
--     columns -- appending here is what strips this key before the RPC ever
--     looks at it.
--   All three need nothing touched but the one list below.
--
-- Proof: PART 3 below. No probe file -- this file makes no behavioural change
-- until an owner sets minimum_labor_charge above 0 on a job, which is a
-- decision for the pricing UI and calculation code, not this migration.
-- ============================================================


-- ------------------------------------------------------------------------
-- PART 1 -- jobs.minimum_labor_charge
-- ------------------------------------------------------------------------
-- double precision like labor_rate_per_ft and labor_flat_fee, the two figures
-- it floors. NOT NULL DEFAULT 0 (not nullable like accepted_total): a batch
-- upsert names the UNION of its rows' columns and writes NULL into that
-- column for any row that omits it, so a nullable floor here would let one
-- job's write blank another job's floor. 0 means off.
alter table public.jobs
    add column if not exists minimum_labor_charge double precision not null default 0;

comment on column public.jobs.minimum_labor_charge is
    'Floor under LABOUR ALONE, applied before markup/tax/discount: '
    'labourCost = max(laborFlatFee + laborRatePerFt * feet, minimumLaborCharge). '
    'Does not touch minimum_job_charge (the existing floor under the whole job, applied '
    'after markup/tax/discount). 0 = off. A money column (job_money_columns) and never quiet '
    '-- touch_updated_at is untouched, so a change bumps the edit clock exactly as any other '
    'pricing field does.';


-- ------------------------------------------------------------------------
-- PART 2 -- job_money_columns() gains minimum_labor_charge
-- ------------------------------------------------------------------------
do $guard$
declare
    missing text[];
begin
    select array_agg(c) into missing
      from unnest(public.job_money_columns()) c
     where c <> all (array[
        'tax_rate_percent', 'markup_percent', 'discount_percent',
        'labor_rate_per_ft', 'labor_flat_fee', 'minimum_job_charge',
        'teardown_flat_fee', 'teardown_rate_per_ft', 'gate_rate_per_ft', 'trash_haul_fee',
        'deposit_amount', 'amount_paid', 'refunded_amount', 'refunded_at', 'refund_reason',
        'payment_status', 'is_invoiced', 'payments_from_processor',
        'contract_total', 'signed_contract_total', 'tip_amount',
        'payment_link_url', 'payment_link_amount',
        'pricing_tier_name', 'supplier_quote_reference',
        'quote_token', 'quote_sent_at', 'quote_viewed_at',
        'accepted_total']);
    if missing is not null then
        raise exception 'job_money_columns() now also lists %, which this file would drop. '
                        'Add them to PART 2 before running it.', missing;
    end if;
end $guard$;

create or replace function public.job_money_columns()
 returns text[]
 language sql
 immutable
as $function$
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
        'minimum_labor_charge'
    ]
$function$;


-- ------------------------------------------------------------------------
-- PART 3 -- prove what landed
--
-- Every row must read true.
-- ------------------------------------------------------------------------

select 'jobs.minimum_labor_charge exists, double precision, not null, default 0' as check,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'jobs'
                  and column_name = 'minimum_labor_charge'
                  and data_type = 'double precision'
                  and is_nullable = 'NO'
                  and column_default = '0'::text) as ok
union all
select 'job_money_columns() lists minimum_labor_charge',
       'minimum_labor_charge' = any (public.job_money_columns())
union all
select 'jobs_crew, if it already exists, hides minimum_labor_charge',
       not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'jobs_crew'
                      and column_name = 'minimum_labor_charge')
union all
select 'hold_money_columns() reads job_money_columns() with no hardcoded list',
       (select position('job_money_columns()' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'hold_money_columns')
union all
select 'crew_save_job() drops job_money_columns() from what it accepts',
       (select position('job_money_columns()' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'crew_save_job');

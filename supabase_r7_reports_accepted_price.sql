-- ============================================================
-- FenceFlow -- the reports measure a job against the price it was ACCEPTED at
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   ADDITIVE           public.job_anchored_total(public.jobs) -- a new function.
--   FUNCTION-REPLACING job_costing(timestamptz, timestamptz) and ar_aging().
--                      Both bodies are the LIVE ones (pg_get_functiondef,
--                      2026-09-22) with one expression changed in each, so the
--                      plan gate and money_scope_company_id() added by
--                      supabase_r6_money_rpc_plan_gate.sql and the
--                      quoted_material column added by
--                      supabase_job_costing_material_budget.sql all survive.
--                      Do NOT rebuild either from an older file in this repo:
--                      supabase_job_costing_v2.sql and supabase_ar_aging_fix.sql
--                      are both behind the live bodies.
--   No row is written, no policy changes, nothing is deleted. Signatures and
--   output columns are identical, so every caller keeps working -- only the
--   figure in `quoted` / `contract_total` moves, and only for a job that has an
--   accepted price recorded.
--
-- WHAT WAS WRONG
--   supabase_r6_price_stability.sql gave a job an accepted price
--   (jobs.accepted_total) and taught the phone, the quote page, the payment
--   link and the office job sheet to bill against it. The two money REPORTS
--   were left behind: both still read jobs.contract_total, the live recompute
--   the app sends, which keeps moving after acceptance (Woody signed at $3,620
--   and read $200; job 4598 signed at $9,710 and read $13,410).
--
--   website/dashboard.html has been re-basing their rows in the browser since
--   then (anchorCostingRow / anchorArRows / anchorAgingBuckets), which is why
--   the numbers on screen have been right. But that only covers a job the page
--   is holding: the first paint is a bounded slice, so a job outside it passed
--   through with the drifted figure, and business_report()'s aging tiles could
--   only be corrected by the difference for the rows the page could see. Any
--   other caller -- a direct RPC, the Outstanding export before the page has
--   finished loading, anything added later -- got the moving figure.
--
--   Fixing it here makes the server the single answer. The page's re-basing is
--   left in place deliberately and becomes a no-op: anchorCostingRow returns
--   the row untouched when it already agrees to within half a cent,
--   anchorArRows recomputes owed from the same anchored figure, and
--   anchorAgingBuckets adds a difference that is now zero. An old browser tab
--   left open on the previous page therefore keeps showing correct numbers.
--
-- THE RULE, in one place
--   public.job_anchored_total(j) is the fourth copy of billableTotal, and it is
--   held to the other three line for line:
--     * app     JobMoney.anchoredTotal
--     * server  billableTotal() in supabase/functions/_shared/quote-deposit.ts
--     * office  anchoredTotalOf() in website/dashboard.html
--   An accepted price stands when accepted_total is recorded, is above zero, an
--   acceptance is stamped (signed_at or quote_approved_at), and no re-approval
--   is pending -- a drawing change withdrew the approval, so the live estimate
--   is what the customer is being asked to agree to again and must be free to
--   move. On top of it go only the change orders SIGNED AFTER the acceptance
--   that the acceptance did not already cover (in_accepted_total): an order
--   that existed at acceptance is already inside the figure, and adding it
--   again bills it twice ($9,710 with a $900 order in it became $10,610). An
--   unsigned order does not move the price until the customer signs it.
--   Nothing stands -> null, and each report falls back exactly as it did
--   before: contract_total, then its own sum of line items and change orders.
--
-- NOT SECURITY DEFINER, on purpose. It is called from inside two definer
-- functions, where it already runs as their owner. Called directly it reads
-- change_orders as the CALLER, so RLS decides -- a hand-built jobs composite
-- naming another company cannot be used to total that company's orders.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  the rule
-- ------------------------------------------------------------------------

create or replace function public.job_anchored_total(j public.jobs)
 returns numeric
 language sql
 stable
 set search_path to 'public'
as $function$
    select case
        when j.accepted_total is null                then null
        when j.reapproval_required_at is not null    then null
        when j.accepted_total <= 0.005               then null
        when greatest(coalesce(j.signed_at,          '-infinity'::timestamptz),
                      coalesce(j.quote_approved_at,  '-infinity'::timestamptz))
             = '-infinity'::timestamptz              then null
        else greatest(0, j.accepted_total + coalesce((
                 select sum(co.additional_cost)
                   from public.change_orders co
                  where co.company_id  = j.company_id
                    and co.job_sync_id = j.sync_id
                    and co.deleted_at is null
                    and co.in_accepted_total is not true
                    and co.signed_at is not null
                    and co.signed_at > greatest(coalesce(j.signed_at,         '-infinity'::timestamptz),
                                                coalesce(j.quote_approved_at, '-infinity'::timestamptz))
             ), 0)::numeric)
    end;
$function$;

comment on function public.job_anchored_total(public.jobs) is
    'The price a job was accepted at, plus change orders signed after the acceptance that it did not already '
    'cover; null when no accepted price stands (not accepted, none recorded, zero, or a re-approval pending). '
    'The SQL copy of billableTotal (quote-deposit.ts) / anchoredTotalOf (dashboard.html) / JobMoney.anchoredTotal. '
    'Not definer: reads change_orders as the caller. See supabase_r7_reports_accepted_price.sql.';

revoke all     on function public.job_anchored_total(public.jobs) from public;
revoke all     on function public.job_anchored_total(public.jobs) from anon;
grant  execute on function public.job_anchored_total(public.jobs) to authenticated;
grant  execute on function public.job_anchored_total(public.jobs) to service_role;


-- ------------------------------------------------------------------------
-- PART 2  job_costing() -- `quoted` prefers the accepted price
--
-- The live body, with two changes and nothing else:
--   * scope carries public.job_anchored_total(j) as ff_anchored_total (named
--     so a future jobs.anchored_total column could not collide with it);
--   * figured.quoted coalesces that first.
-- projected_profit, margin_percent and total_cost are worked out from `quoted`
-- further down and follow it with no edit. cash_position is collected minus
-- cost and does not involve the quote at all.
-- ------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.job_costing(from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, to_date timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(job_sync_id text, customer_name text, status text, quoted numeric, collected numeric, material_cost numeric, labour_cost numeric, other_cost numeric, total_cost numeric, projected_profit numeric, margin_percent numeric, cash_position numeric, costs_are_sell_prices boolean, hours_worked numeric, unapproved_hours numeric, quoted_material numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    with scope as (
        select j.sync_id, j.customer_name, j.status::text, j.contract_total,
               public.job_anchored_total(j) as ff_anchored_total
        from jobs j
        where j.company_id = money_scope_company_id()
          and public.advanced_reports_company_id() is not null   -- the plan gate (supabase_r6_money_rpc_plan_gate.sql)
          and j.deleted_at is null
          and (from_date is null or j.created_at >= from_date)
          and (to_date   is null or j.created_at <= to_date)
    ),
    money as (
        select p.job_sync_id, sum(p.amount) as collected
        from payment_records p
        where p.company_id = money_scope_company_id() and p.deleted_at is null
        group by p.job_sync_id
    ),
    materials as (
        select i.job_sync_id,
               sum(i.quantity * coalesce(i.supplier_unit_price, i.unit_price)) as cost,
               sum(i.quantity * i.unit_price) as sell,
               -- Flagged so the page can say "these costs are your sell
               -- prices" instead of quietly showing a margin of zero-ish.
               bool_and(i.supplier_unit_price is null) as all_fallback
        from estimate_line_items i
        where i.company_id = money_scope_company_id() and i.deleted_at is null
        group by i.job_sync_id
    ),
    labour as (
        select t.job_sync_id,
               sum(case when t.approved_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0 * t.hourly_rate
                        else 0 end) as cost,
               sum(case when t.approved_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0
                        else 0 end) as hours,
               sum(case when t.approved_at is null and t.ended_at is not null
                        then extract(epoch from (t.ended_at - t.started_at)) / 3600.0
                        else 0 end) as pending_hours
        from time_entries t
        where t.company_id = money_scope_company_id() and t.deleted_at is null
          and t.ended_at is not null
        group by t.job_sync_id
    ),
    extras as (
        select c.job_sync_id, sum(c.additional_cost) as total
        from change_orders c
        where c.company_id = money_scope_company_id() and c.deleted_at is null
        group by c.job_sync_id
    ),
    other as (
        select e.job_sync_id, sum(e.amount) as cost
        from expenses e
        where e.company_id = money_scope_company_id() and e.deleted_at is null
        group by e.job_sync_id
    ),
    figured as (
        select s.sync_id, s.customer_name, s.status,
               -- The accepted price while one stands, then the app's live
               -- recompute, then the old sum. See PART 1.
               coalesce(s.ff_anchored_total,
                        s.contract_total,
                        coalesce(m.sell, 0) + coalesce(x.total, 0)) as quoted,
               coalesce(mo.collected, 0) as collected,
               coalesce(m.cost, 0)  as material_cost,
               coalesce(l.cost, 0)  as labour_cost,
               coalesce(o.cost, 0)  as other_cost,
               coalesce(m.all_fallback, false) as all_fallback,
               coalesce(l.hours, 0) as hours,
               coalesce(l.pending_hours, 0) as pending,
               coalesce(m.sell, 0) as quoted_material
        from scope s
        left join money     mo on mo.job_sync_id = s.sync_id
        left join materials m  on m.job_sync_id  = s.sync_id
        left join labour    l  on l.job_sync_id  = s.sync_id
        left join extras    x  on x.job_sync_id  = s.sync_id
        left join other     o  on o.job_sync_id  = s.sync_id
    )
    select f.sync_id, f.customer_name, f.status,
           round(f.quoted::numeric, 2),
           round(f.collected::numeric, 2),
           round(f.material_cost::numeric, 2),
           round(f.labour_cost::numeric, 2),
           round(f.other_cost::numeric, 2),
           round((f.material_cost + f.labour_cost + f.other_cost)::numeric, 2),
           round((f.quoted - f.material_cost - f.labour_cost - f.other_cost)::numeric, 2),
           case when f.quoted > 0
                then round(((f.quoted - f.material_cost - f.labour_cost - f.other_cost)
                            / f.quoted * 100)::numeric, 1) end,
           round((f.collected - f.material_cost - f.labour_cost - f.other_cost)::numeric, 2),
           f.all_fallback,
           round(f.hours::numeric, 2),
           round(f.pending::numeric, 2),
           round(f.quoted_material::numeric, 2)
    from figured f
    order by f.quoted desc;
$function$;


-- ------------------------------------------------------------------------
-- PART 3  ar_aging() -- `contract_total` and `owed` prefer the accepted price
--
-- The live body, with the same two changes. `owed` repeats the contract
-- expression rather than referring to it (a select-list alias cannot be used by
-- a sibling in the same select list), so BOTH copies have to move -- the reason
-- this edit is done by hand and counted below rather than by a blind
-- substitution. A job whose accepted price is BELOW its drifted live figure can
-- now drop out of the answer (owed <= 0.005), and one the accepted price leaves
-- owing can now appear: that is the point.
-- ------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ar_aging()
 RETURNS TABLE(job_sync_id text, customer_name text, phone text, email text, status text, contract_total numeric, paid numeric, owed numeric, since timestamp with time zone, days_out integer, bucket text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    with jobs_in_scope as (
        select j.*, public.job_anchored_total(j) as ff_anchored_total from jobs j
        where j.company_id = money_scope_company_id() and j.deleted_at is null
          and public.advanced_reports_company_id() is not null   -- the plan gate (supabase_r6_money_rpc_plan_gate.sql)
          and j.status in ('ACCEPTED','COMPLETED')
    ),
    materials as (
        select i.job_sync_id, sum(i.quantity * i.unit_price) as total
        from estimate_line_items i
        where i.company_id = money_scope_company_id() and i.deleted_at is null
        group by i.job_sync_id
    ),
    extras as (
        select c.job_sync_id, sum(c.additional_cost) as total from change_orders c
        where c.company_id = money_scope_company_id() and c.deleted_at is null
        group by c.job_sync_id
    ),
    money as (
        select p.job_sync_id, sum(p.amount) as paid from payment_records p
        where p.company_id = money_scope_company_id() and p.deleted_at is null
        group by p.job_sync_id
    ),
    figured as (
        select j.sync_id, j.customer_name, j.phone, j.email, j.status::text,
               -- The accepted price while one stands, then contract_total, then
               -- the old sum. See PART 1. Repeated in `owed` below.
               coalesce(j.ff_anchored_total, j.contract_total, coalesce(m.total,0) + coalesce(x.total,0)) as contract_total,
               coalesce(mo.paid, 0) as paid,
               coalesce(j.ff_anchored_total, j.contract_total, coalesce(m.total,0) + coalesce(x.total,0)) - coalesce(mo.paid,0) as owed,
               coalesce(j.final_sign_off_at, j.scheduled_date, j.created_at) as since
        from jobs_in_scope j
        left join materials m on m.job_sync_id = j.sync_id
        left join extras x on x.job_sync_id = j.sync_id
        left join money mo on mo.job_sync_id = j.sync_id
    )
    select f.sync_id, f.customer_name, f.phone, f.email, f.status,
           round(f.contract_total::numeric,2), round(f.paid::numeric,2), round(f.owed::numeric,2),
           f.since, greatest(0, extract(day from now() - f.since)::int),
           case when extract(day from now() - f.since) >= 90 then '90'
                when extract(day from now() - f.since) >= 60 then '60'
                when extract(day from now() - f.since) >= 30 then '30'
                else 'current' end
    from figured f
    where f.owed > 0.005
    order by f.since asc;
$function$;


-- ------------------------------------------------------------------------
-- PART 4  the grants, re-stated
--
-- CREATE OR REPLACE keeps an existing ACL, so nothing above changes these.
-- They are re-stated because a plain CREATE resets a function's ACL to the
-- default -- which is how job_costing() silently got PUBLIC and anon EXECUTE
-- back once already (supabase_job_costing_material_budget.sql), and the next
-- person to rebuild one of these from a file may not use OR REPLACE.
-- ------------------------------------------------------------------------

revoke execute on function public.job_costing(timestamptz, timestamptz) from public, anon;
grant  execute on function public.job_costing(timestamptz, timestamptz) to authenticated;
revoke execute on function public.ar_aging() from public, anon;
grant  execute on function public.ar_aging() to authenticated;


-- ------------------------------------------------------------------------
-- PART 5  prove what landed
--
-- Every row must read true. A false here means the edit did not take -- read it
-- before trusting any figure on screen.
-- ------------------------------------------------------------------------

select 'job_anchored_total exists, stable, not definer' as check,
       count(*) = 1 as ok
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname = 'job_anchored_total'
   and provolatile = 's' and not prosecdef
union all
select 'job_anchored_total not executable by anon or PUBLIC',
       not exists (select 1 from pg_proc p, unnest(p.proacl::text[]) a
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname = 'job_anchored_total'
                      and (a like '=%' or a like 'anon=%'))
union all
select 'job_costing reads the accepted price',
       (select position('ff_anchored_total' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'job_costing')
union all
select 'job_costing kept its plan gate and money scope',
       (select position('advanced_reports_company_id' in prosrc) > 0
           and position('money_scope_company_id' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'job_costing')
union all
select 'job_costing kept quoted_material',
       (select position('quoted_material' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'job_costing')
union all
select 'ar_aging names the accepted price 3 times (scope, contract, owed)',
       (select (length(prosrc) - length(replace(prosrc, 'ff_anchored_total', ''))) / length('ff_anchored_total') = 3
          from pg_proc where pronamespace = 'public'::regnamespace and proname = 'ar_aging')
union all
select 'ar_aging kept its plan gate and money scope',
       (select position('advanced_reports_company_id' in prosrc) > 0
           and position('money_scope_company_id' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'ar_aging')
union all
select 'neither report is executable by anon or PUBLIC',
       not exists (select 1 from pg_proc p, unnest(p.proacl::text[]) a
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname in ('job_costing','ar_aging')
                      and (a like '=%' or a like 'anon=%'));

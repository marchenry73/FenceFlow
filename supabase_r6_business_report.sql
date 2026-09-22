-- supabase_r6_business_report.sql
--
-- One guarded read for the Pro half of Reports -> Business report
-- (website/dashboard.html, bizRender / bizProfitData). Idempotent: create or
-- replace, same signature every time.
--
-- WHY A NEW FUNCTION rather than calling job_costing() and ar_aging() from the
-- page, as the rest of the Reports tab does:
--   * Neither of those checks the plan. The page hides per-job profit from Solo
--     and Crew, but a Crew-plan user with SEE_MONEY can call job_costing()
--     directly and get Pro's per-job profit. This refuses with reason 'plan'.
--   * Neither filters jobs.is_test_fixture. Checked on live data 2026-09-21:
--     three test jobs appeared in "Did each job make money?" and one test job's
--     $4,200 sat in "Who owes you" ($65,850 shown against $61,650 real). This
--     excludes fixtures, and honours p_include_test only for the OWNER -- the
--     same rule as visibleJobs() in the page (Settings > Show test data).
--   * The report needs a few things they do not carry: approved hours with no
--     pay rate (so labour reads "unknown", not $0) -- kept apart from hours
--     worked by PER_FOOT crew, whose by-the-foot pay job_costing() does not
--     count at all -- change orders per job, and card fees / online deposits
--     from LIVE payments only (test-mode job_payments rows are ignored, as the Stripe
--     webhook ignores them for the ledger).
-- It COMPOSES job_costing() and ar_aging() instead of re-deriving profit and
-- aging, so its numbers can never disagree with those two panels.
--
-- The reply carries only what the page reads (tests/business-report.test.mjs
-- checks every key against bizRender): an unread figure in a definer
-- function's answer is data sent for nothing, and a reader takes it as used.
--
-- Every per-job figure is LIFETIME (job_costing() takes no window here), so
-- "collected" beside a job is everything that job has ever been paid -- the
-- same basis as its materials, labour and profit. Only the card fees and
-- online deposits are cut to p_from/p_to. Money collected inside the window
-- is the page's own ledger sum (section G), not a field of this reply.
--
-- GATES (mirrors the page):
--   money  money_scope_company_id() -- null without has_permission('SEE_MONEY'),
--          which honours permission_overrides. Refused with reason 'see_money'.
--   plan   companies.subscription_plan lower-cased; 'solo' and 'crew' are
--          refused with reason 'plan'. Blank = a hand-granted company with full
--          access, exactly as hasAdvancedReports() treats it.
--   rows   deleted jobs excluded; fixtures excluded unless p_include_test AND the
--          caller's profile role is OWNER.
--
-- ALSO HERE: job_costing() loses the PUBLIC and anon EXECUTE it regained when
-- supabase_job_costing_material_budget.sql dropped and re-created it (a fresh
-- CREATE resets the ACL to the default, which undid the revoke in
-- supabase_release_guard_patch.sql). Live on 2026-09-21 its acl still read
-- "=X/postgres ... anon=X/postgres". Anon got an empty result (no SEE_MONEY),
-- so nothing leaked, but the grant should say what the guard means. ar_aging()
-- was never re-created and is already authenticated-only; it is re-stated too.
--
-- NOT CHANGED HERE (flagged for the main session): job_costing() and ar_aging()
-- themselves still have no plan check and no fixture filter. Any OWNER has
-- SEE_MONEY whatever the plan, so a Solo or Crew owner can call either RPC by
-- hand and read Pro's per-job profit and aging. The page never fetches them on
-- those plans and cuts their rows to visible jobs (onlyVisibleRows), but a
-- direct RPC call is not stopped. See supabase_r6_money_rpc_plan_gate.sql.
--
-- Labour hours here are raw clock time (ended_at - started_at), the same as
-- job_costing(), so they do NOT deduct break_minutes; the page says so beside
-- the table. The page's own hour figures elsewhere use paidHoursOf(), which does.

create or replace function public.business_report(
    p_from         timestamptz default null,
    p_to           timestamptz default null,
    p_include_test boolean     default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
    co        uuid := public.money_scope_company_id();   -- null without SEE_MONEY
    v_plan    text;
    show_test boolean;
    result    jsonb;
begin
    if co is null then
        return jsonb_build_object('allowed', false, 'reason', 'see_money');
    end if;

    -- Same test as the page: planName = (subscription_plan || '').toLowerCase().
    select lower(coalesce(c.subscription_plan, '')) into v_plan
      from companies c where c.id = co;
    if v_plan in ('solo', 'crew') then
        return jsonb_build_object('allowed', false, 'reason', 'plan');
    end if;

    show_test := coalesce(p_include_test, false) and exists (
        select 1 from profiles pr where pr.id = auth.uid() and pr.role::text = 'OWNER');

    with scope as (
        select j.sync_id
          from jobs j
         where j.company_id = co
           and j.deleted_at is null
           and (show_test or coalesce(j.is_test_fixture, false) = false)
    ),
    jc as (
        select c.* from public.job_costing(null, null) c
         where c.job_sync_id in (select s.sync_id::text from scope s)
    ),
    -- Approved hours job_costing() prices at nothing (no hourly_rate on the
    -- shift). Split by who worked them: a PER_FOOT crew member is paid by the
    -- foot, which job_costing() does not count at all, so those hours are
    -- "paid another way, missing from labour" -- not "no rate on file". The
    -- page's own labourByWorker() draws the same line (isPerFootShift).
    unrated as (
        -- exists(), not a join, so a duplicated employee row cannot double a shift.
        select t.job_sync_id::text as job_sync_id,
               sum(greatest(0, extract(epoch from (t.ended_at - t.started_at)) / 3600.0))
                 filter (where not pf.is_pf) as hours,
               sum(greatest(0, extract(epoch from (t.ended_at - t.started_at)) / 3600.0))
                 filter (where pf.is_pf)     as per_foot_hours
          from time_entries t
          cross join lateral (select exists (
                   select 1 from employees e
                    where e.company_id = co and e.sync_id::text = t.employee_sync_id::text
                      and e.pay_type = 'PER_FOOT') as is_pf) pf
         where t.company_id = co and t.deleted_at is null and t.ended_at is not null
           and t.approved_at is not null and coalesce(t.hourly_rate, 0) = 0
           and t.job_sync_id in (select s.sync_id from scope s)
         group by 1
    ),
    cos as (
        select c.job_sync_id::text as job_sync_id, count(*) as n,
               sum(c.additional_cost) as cost
          from change_orders c
         where c.company_id = co and c.deleted_at is null
           and c.job_sync_id in (select s.sync_id from scope s)
         group by 1
    ),
    fees as (
        select jp.job_sync_id::text as job_sync_id,
               sum(coalesce(jp.fee_cents, 0)) / 100.0 as fees,
               coalesce(sum(jp.amount_cents) filter (where jp.kind = 'deposit'), 0) / 100.0 as online_deposits
          from job_payments jp
         where jp.company_id = co and jp.status = 'paid' and jp.livemode is true
           and (p_from is null or jp.paid_at >= p_from)
           and (p_to   is null or jp.paid_at <= p_to)
           and jp.job_sync_id in (select s.sync_id from scope s)
         group by 1
    )
    select jsonb_build_object(
        'allowed', true,
        'plan', v_plan,
        'include_test', show_test,
        'jobs', coalesce((
            select jsonb_agg(jsonb_build_object(
                'job_sync_id', jc.job_sync_id,
                'quoted', jc.quoted, 'collected', jc.collected,
                'material_cost', jc.material_cost, 'quoted_material', jc.quoted_material,
                'costs_are_sell_prices', jc.costs_are_sell_prices,
                'labour_cost', jc.labour_cost, 'hours_worked', jc.hours_worked,
                'unrated_hours', round(coalesce(u.hours, 0)::numeric, 2),
                'per_foot_hours', round(coalesce(u.per_foot_hours, 0)::numeric, 2),
                'other_cost', jc.other_cost,
                'projected_profit', jc.projected_profit, 'margin_percent', jc.margin_percent,
                'cash_position', jc.cash_position,
                'change_order_count', coalesce(x.n, 0),
                'change_order_total', round(coalesce(x.cost, 0)::numeric, 2),
                'processing_fees', round(coalesce(f.fees, 0)::numeric, 2),
                'online_deposits', round(coalesce(f.online_deposits, 0)::numeric, 2)))
              from jc
              left join unrated u on u.job_sync_id = jc.job_sync_id
              left join cos     x on x.job_sync_id = jc.job_sync_id
              left join fees    f on f.job_sync_id = jc.job_sync_id), '[]'::jsonb),
        'aging', coalesce((
            select jsonb_object_agg(a.bucket, jsonb_build_object('owed', a.owed, 'n', a.n))
              from (select ag.bucket, round(sum(ag.owed)::numeric, 2) as owed, count(*) as n
                      from public.ar_aging() ag
                     where ag.job_sync_id in (select s.sync_id::text from scope s)
                     group by ag.bucket) a), '{}'::jsonb)
    ) into result;
    return result;
end;
$fn$;

comment on function public.business_report(timestamptz, timestamptz, boolean) is
  'Reports > Business report, Pro half. SEE_MONEY (money_scope_company_id) and a plan other than solo/crew, '
  'else {allowed:false, reason}. Test fixtures excluded unless p_include_test and the caller is OWNER. '
  'Composes job_costing() and ar_aging(). See supabase_r6_business_report.sql.';

revoke all on function public.business_report(timestamptz, timestamptz, boolean) from public;
revoke all on function public.business_report(timestamptz, timestamptz, boolean) from anon;
grant execute on function public.business_report(timestamptz, timestamptz, boolean) to authenticated;

-- The two RPCs composed above: signed-in callers only. business_report() runs as
-- its owner, so it reaches both whatever these grants say.
revoke execute on function public.job_costing(timestamptz, timestamptz) from public, anon;
grant  execute on function public.job_costing(timestamptz, timestamptz) to authenticated;
revoke execute on function public.ar_aging() from public, anon;
grant  execute on function public.ar_aging() to authenticated;

-- Prove what landed: definer, guarded, fixture-aware, plan-checked, and not
-- executable by anon or PUBLIC. no_anon_or_public must be true on all three
-- rows (a leading "=X/" in an acl is PUBLIC). plan_checked and
-- excludes_fixtures are expected true for business_report only.
select proname, prosecdef,
       position('money_scope_company_id' in prosrc) > 0 as money_guarded,
       position('is_test_fixture' in prosrc) > 0          as excludes_fixtures,
       position('subscription_plan' in prosrc) > 0        as plan_checked,
       not exists (select 1 from unnest(proacl::text[]) a
                    where a like '=%' or a like 'anon=%')       as no_anon_or_public,
       array_to_string(proacl::text[], ' ')                as acl
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in ('business_report', 'job_costing', 'ar_aging')
 order by proname;

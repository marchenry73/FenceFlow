-- Repairing a meaning I changed underneath three callers.
--
-- can_see_pay() used to answer "may this account see money at all", because
-- one permission covered job money and payroll together. Splitting payroll out
-- gave that function a narrower meaning -- it now answers "may this account see
-- what people are PAID" -- and three places that were asking the older, wider
-- question inherited the narrower one without being changed.
--
-- Two of them are about JOB money and must not have tightened:
--   money_scope_company_id()      -- feeds ar_aging() and job_costing()
--   recalculate_my_job_totals()   -- rebuilds job totals
-- Left as they were, a salesperson would have quietly lost the aging report,
-- the cost report and the ability to rebuild a total -- with no error, just an
-- empty report, which is the failure mode that hides longest.
--
-- The third, in supabase_time_entry_rate_patch.sql, gates who may state an
-- unverified rate on a shift. That one IS payroll and is deliberately left
-- pointing at can_see_pay().
--
-- Everything here restores access that existed before the split. Nothing
-- gains anything new.

create or replace function public.money_scope_company_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select case when public.has_permission('SEE_MONEY') then public.current_company_id() else null end;
$$;
revoke all on function public.money_scope_company_id() from public;
grant execute on function public.money_scope_company_id() to authenticated;

create or replace function public.recalculate_my_job_totals()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    co uuid := public.current_company_id();
    j record;
    n integer := 0;
begin
    if not coalesce(public.has_permission('SEE_MONEY'), false) then return 0; end if;
    if co is null then return 0; end if;
    for j in select sync_id from jobs where company_id = co and deleted_at is null loop
        perform recompute_job_totals(co, j.sync_id);
        n := n + 1;
    end loop;
    return n;
end;
$$;

select 'money scope points at SEE_MONEY again' as done;

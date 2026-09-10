-- What a colleague earns is not the same secret as what a job earns.
--
-- Until now both were guarded by one permission, SEE_MONEY. That is the right
-- rule for job money -- price, cost, margin, payments -- and the wrong rule for
-- payroll, because SEE_MONEY is also held by SALES. A salesperson needs the
-- price of the fence and the margin on the deal. A salesperson has no business
-- reading the hourly rate of every installer in the company, and on a small
-- crew that is a personal fact about a named colleague sitting at the next desk.
--
-- So payroll gets its own permission, SEE_PAY, held by OWNER, MANAGER and
-- ACCOUNTANT -- the three roles that actually run payroll -- and by nobody else
-- unless the owner grants it by hand.
--
-- Nothing about job money changes. SEE_MONEY keeps every job-money job it
-- already had; this file does not touch a single one of those policies.
--
-- Purely additive in effect: SEE_PAY is a strict subset of who held SEE_MONEY,
-- so no account gains anything it did not already have. SALES loses payroll,
-- which is the point.

-- ---------------------------------------------------------------------------
-- The permission itself.
-- ---------------------------------------------------------------------------
-- This replaces has_permission rather than adding beside it, because there is
-- only one of it. The role table below is the existing one with SEE_PAY added
-- to three roles; every other entry is copied unchanged from
-- supabase_assignment_and_foreman_patch.sql, which is the newest version in
-- the repo (it is the one carrying APPROVE_TIME and APPROVE_PLAN_CHANGES on
-- FOREMAN). Losing those two would silently take approval away from every
-- foreman, so they are the line to check first if anything looks wrong.
create or replace function public.has_permission(perm text)
returns boolean language sql stable security definer set search_path = public as $$
  with me as (
    select role::text as role_text, coalesce(permission_overrides, '') as overrides
    from profiles where id = auth.uid()
  )
  select case
    when position('-' || perm in (select overrides from me)) > 0 then false
    when position('+' || perm in (select overrides from me)) > 0 then true
    else case (select role_text from me)
      when 'OWNER' then true
      when 'MANAGER' then perm in (
        'SEE_MONEY','SEE_PAY','EDIT_JOBS','EDIT_CATALOG_AND_SETTINGS','SCHEDULE_AND_ASSIGN',
        'REQUEST_PAYMENT','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT','SEE_REPORTS',
        'APPROVE_TIME','APPROVE_PLAN_CHANGES')
      when 'SALES' then perm in ('SEE_MONEY','EDIT_JOBS','SEE_CUSTOMER_CONTACT')
      when 'ACCOUNTANT' then perm in (
        'SEE_MONEY','SEE_PAY','REQUEST_PAYMENT','RECORD_REFUNDS','SEE_CUSTOMER_CONTACT','SEE_REPORTS')
      when 'FOREMAN' then perm in (
        'SCHEDULE_AND_ASSIGN','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT',
        'APPROVE_TIME','APPROVE_PLAN_CHANGES')
      when 'CREW' then perm in ('RECORD_FIELD_WORK')
      else false
    end
  end;
$$;
revoke all on function public.has_permission(text) from public;
grant execute on function public.has_permission(text) to authenticated;

-- ---------------------------------------------------------------------------
-- The employee record, which is where the four pay columns live.
-- ---------------------------------------------------------------------------
-- Row Level Security cannot hide a column, so the row is still the unit and
-- the only change is which permission opens it. Reading your own record
-- survives untouched -- an installer must be able to see their own rate.
drop policy if exists employees_read on public.employees;
create policy employees_read on public.employees
    for select using (
        company_id = public.current_company_id()
        and (public.has_permission('SEE_PAY') or profile_id = auth.uid())
    );

-- ---------------------------------------------------------------------------
-- The question the phone asks before it trusts a rate.
-- ---------------------------------------------------------------------------
-- The phone must ASK, never infer from an empty result -- inferring is how a
-- real rate of 25 was once overwritten with 0. That contract is unchanged;
-- only the permission behind the answer moves.
create or replace function public.can_see_pay()
returns boolean
language sql stable security definer set search_path to 'public'
as $$
    select coalesce(public.has_permission('SEE_PAY'), false);
$$;
revoke execute on function public.can_see_pay() from public, anon;
grant  execute on function public.can_see_pay() to authenticated;

select 'pay visibility split from job money' as done;

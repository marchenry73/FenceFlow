-- Undoing a change I made three hours ago that would have taken every
-- salesperson's phone dark.
--
-- Splitting payroll onto its own permission was right. Doing it by narrowing
-- can_see_pay() was not, because that function's name has never matched its
-- job: the Android client asks it ONCE per sync pass and uses the answer as
-- the money scope for everything -- job pricing, tax, markup, deposits,
-- payments, line item costs, catalog prices, pricing tiers. A repair file
-- earlier today found three server-side callers that were asking the older,
-- wider question and fixed two of them. It missed the biggest caller of all,
-- which is not on the server at all: askMoneyScope() in SyncScope.kt.
--
-- What would have happened, on the next sync of any SALES phone: SEE_MONEY
-- yes, SEE_PAY no, so can_see_pay() answers false, so MoneyScope is DENIED,
-- so AutoSync calls forgetMoney() and resets that phone's cached job money to
-- defaults -- while the pricing screen, gated on the LOCAL SEE_MONEY check,
-- carries on showing it. Not an error message. A zero markup and a zero
-- deposit that look like real figures.
--
-- So can_see_pay() goes back to exactly what it was and what every caller
-- means by it, and payroll gets a function of its own with a name that says
-- what it is. The employees table's policy already asks for SEE_PAY directly
-- and is untouched by this, so the split itself survives.
create or replace function public.can_see_pay()
returns boolean
language sql stable security definer set search_path to 'public'
as $$
    select coalesce(public.has_permission('SEE_MONEY'), false);
$$;
revoke execute on function public.can_see_pay() from public, anon;
grant  execute on function public.can_see_pay() to authenticated;

comment on function public.can_see_pay() is
  'Job money: price, cost, margin, payments. Badly named for historical reasons -- the phone asks it once per sync as its whole money scope. For payroll ask can_see_employee_pay().';

-- Payroll, under a name that cannot be mistaken for the other question.
create or replace function public.can_see_employee_pay()
returns boolean
language sql stable security definer set search_path to 'public'
as $$
    select coalesce(public.has_permission('SEE_PAY'), false);
$$;
revoke execute on function public.can_see_employee_pay() from public, anon;
grant  execute on function public.can_see_employee_pay() to authenticated;

comment on function public.can_see_employee_pay() is
  'What a person is paid: the four pay columns on employees. Owner, manager and accountant only.';

select 'can_see_pay restored to job money; payroll moved to can_see_employee_pay' as done;

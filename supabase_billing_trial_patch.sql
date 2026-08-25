-- A company on a free trial could not be told when the trial ends.
--
-- dashboard.html's Billing tab writes "Free trial until <date>" from
-- subscription_ends_at -- which is the RENEWAL date of a paid subscription,
-- not the trial end, and is null throughout a trial by definition. So the one
-- line a trialing customer most wants to read has always rendered as a bare
-- "Free trial." with no date. And my_billing_status did not return
-- trial_ends_at at all, so the page could not have shown it even if it asked.
--
-- Everything else is deliberately left exactly as it was: has_subscription
-- still keys on stripe_customer_id (not the subscription id), and the company
-- is still resolved by the same inline profiles lookup. This adds one column
-- and changes nothing else.
drop function if exists public.my_billing_status();
create function public.my_billing_status()
returns table(subscription_status text, subscription_plan text,
              subscription_ends_at timestamptz, trial_ends_at timestamptz,
              stripe_account_id text, has_subscription boolean)
language sql security definer set search_path to 'public'
as $$
    select c.subscription_status, c.subscription_plan, c.subscription_ends_at,
           c.trial_ends_at,
           c.stripe_account_id,
           c.stripe_customer_id is not null as has_subscription
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;
revoke execute on function public.my_billing_status() from public, anon;
grant  execute on function public.my_billing_status() to authenticated;

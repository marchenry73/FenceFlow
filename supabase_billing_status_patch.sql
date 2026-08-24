-- The billing tab needs to tell two look-alike states apart: a company granted
-- access by hand (no plan, nothing to sell it) and one that IS subscribed but
-- whose plan label has not been written yet. They rendered identically, so a
-- paying company could be shown no plan cards at all -- no way to pick a plan
-- and no way to upgrade until its access was cut off.
drop function if exists public.my_billing_status();
create function public.my_billing_status()
returns table(subscription_status text, subscription_plan text,
              subscription_ends_at timestamptz, stripe_account_id text,
              has_subscription boolean)
language sql security definer set search_path to 'public'
as $$
    select c.subscription_status, c.subscription_plan, c.subscription_ends_at,
           c.stripe_account_id,
           c.stripe_customer_id is not null as has_subscription
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;
grant execute on function public.my_billing_status() to authenticated;
select 'billing status extended' as done;

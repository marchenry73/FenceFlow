-- Billing columns stop being self-service.
--
-- The RLS policy on companies let any OWNER update their own row, and the
-- subscription lives on that row. So a paying customer could send one request
-- and set suspended = false, subscription_plan = 'Pro', subscription_status =
-- 'active' -- verified against the live database, it worked. Every plan limit
-- in the app and the website reads those columns, so the entire subscription
-- was honour-based for anyone who opened the network tab.
--
-- The columns are now writable only by the service role (the Stripe webhook
-- and the checkout function, which authenticate as the platform) and by the
-- platform admin. An owner editing their company name still works: the
-- trigger quietly restores just the billing fields rather than failing the
-- whole update, so legitimate edits are never punished for touching the same
-- row.
create or replace function public.protect_billing_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
    -- The service role carries no auth.uid(): Stripe's webhook and the
    -- checkout function are the only things meant to move these.
    if auth.uid() is null then
        return new;
    end if;

    if exists (
        select 1 from profiles
         where id = auth.uid() and is_platform_admin
    ) then
        return new;
    end if;

    new.suspended              := old.suspended;
    new.subscription_status    := old.subscription_status;
    new.subscription_plan      := old.subscription_plan;
    new.subscription_ends_at   := old.subscription_ends_at;
    new.trial_ends_at          := old.trial_ends_at;
    new.grace_ends_at          := old.grace_ends_at;
    new.stripe_customer_id     := old.stripe_customer_id;
    new.stripe_subscription_id := old.stripe_subscription_id;
    new.stripe_account_id      := old.stripe_account_id;
    new.monthly_price          := old.monthly_price;
    return new;
end;
$$;

drop trigger if exists protect_billing_columns on public.companies;
create trigger protect_billing_columns
    before update on public.companies
    for each row execute function public.protect_billing_columns();

-- A trial date in the future was an OR branch of its own, so it outranked
-- everything: a company that cancelled kept full access while the very same
-- function told it "Your subscription has ended." A trial only means anything
-- while the subscription has not been cancelled or suspended.
create or replace function public.my_service_status()
returns table(allowed boolean, subscription_status text, subscription_plan text,
              reason text, grace_ends_at timestamptz, trial_days_left int)
language sql security definer set search_path to 'public'
as $$
    select
        (not c.suspended)
        and c.subscription_status is distinct from 'canceled'
        and (
            c.subscription_status in ('active', 'trialing')
            or (c.trial_ends_at is not null and c.trial_ends_at > now())
            or (c.subscription_status = 'past_due'
                and coalesce(c.grace_ends_at, now() + interval '2 days') > now())
        ) as allowed,
        c.subscription_status::text,
        coalesce(c.subscription_plan, '') as subscription_plan,
        case
            when c.suspended then 'Your FenceFlow account has been suspended. Please get in touch.'
            when c.subscription_status = 'past_due' then 'Your payment did not go through. Please update your card.'
            when c.subscription_status = 'canceled' then 'Your subscription has ended.'
            when c.trial_ends_at is not null and c.trial_ends_at <= now()
                then 'Your trial has ended. Get in touch to keep going.'
            else 'This company does not have access to FenceFlow yet.'
        end as reason,
        c.grace_ends_at,
        case
            when c.subscription_status = 'trialing'
                 and c.trial_ends_at is not null and c.trial_ends_at > now()
            then ceil(extract(epoch from c.trial_ends_at - now()) / 86400.0)::int
        end as trial_days_left
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;
grant execute on function public.my_service_status() to authenticated;

-- Seats are a count of live members, so a seat must be returnable. Nothing
-- freed one: a company that hired and let go five people over a season hit
-- its cap with two people working. This releases the seat without deleting
-- anybody -- the profile keeps its name and history, it simply stops
-- belonging to the company.
create or replace function public.release_seat(member_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
    caller_company uuid;
begin
    select company_id into caller_company from profiles where id = auth.uid();
    if caller_company is null then
        raise exception 'You are not part of a business.';
    end if;
    if not exists (
        select 1 from profiles
         where id = auth.uid() and company_id = caller_company and role = 'OWNER'
    ) then
        raise exception 'Only the owner can remove someone from the business.';
    end if;
    if member_id = auth.uid() then
        raise exception 'You cannot remove yourself.';
    end if;
    if not exists (select 1 from profiles where id = member_id and company_id = caller_company) then
        raise exception 'That person is not in your business.';
    end if;

    update profiles
       set company_id = null, requested_role = ''
     where id = member_id;
end;
$$;
grant execute on function public.release_seat(uuid) to authenticated;

select 'billing integrity installed' as done;

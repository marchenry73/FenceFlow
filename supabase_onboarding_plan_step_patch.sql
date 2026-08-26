-- "Start trial" in the admin made the customer skip the plan step entirely,
-- so no card was ever collected.
--
-- A company March creates shows subscription_status 'pending', so admin.html
-- offers "Start trial" as the primary button on the row -- the obvious thing
-- to press. admin_start_trial sets subscription_status='trialing' and a
-- trial_ends_at, with no Stripe fields at all, because it is a courtesy trial
-- March is granting by hand.
--
-- my_onboarding then computed plan_done as
--     c.subscription_status in ('active', 'trialing')
-- so that courtesy trial read as "they have chosen a plan". The customer
-- filled in their details, signed the agreement, and welcome.html jumped
-- straight past "Choose your plan" to "You're all set". No plan, no card, no
-- subscription -- and in fourteen days the trial simply ends and they are
-- locked out of a product they thought they had bought.
--
-- plan_done now means what the step is actually for: they have a real
-- subscription with Stripe. A courtesy trial keeps them working -- the access
-- gate honours trial_ends_at either way -- but the plan step stays in front of
-- them, which is the whole point of it.
create or replace function public.my_onboarding()
returns table(details_done boolean, agreement_done boolean, plan_done boolean,
              agreement_name text, agreement_at timestamptz)
language sql security definer set search_path to 'public'
as $$
    select c.details_completed_at is not null,
           c.agreement_signed_at is not null,
           (c.stripe_subscription_id is not null
            or c.subscription_status = 'active'),
           c.agreement_signed_name,
           c.agreement_signed_at
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;
revoke execute on function public.my_onboarding() from public, anon;
grant  execute on function public.my_onboarding() to authenticated;

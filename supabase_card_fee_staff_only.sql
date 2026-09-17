-- companies.pass_card_fee now means: this company's FenceFlow subscription
-- price includes the Stripe fee. Staff set it in the admin portal; the company
-- itself must not be able to switch it off. Same guard as the other billing
-- columns: the function body is unchanged except for the one added line.
create or replace function public.protect_billing_columns()
returns trigger
language plpgsql security definer set search_path to 'public'
as $f$
begin
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
    new.pass_card_fee          := old.pass_card_fee;
    return new;
end;
$f$;
comment on column companies.pass_card_fee is
  'Staff only: the FenceFlow subscription price for this company includes the Stripe fee.';
select 'card fee is staff only' as done;

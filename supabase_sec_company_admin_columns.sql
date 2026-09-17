-- F6 (P2): protect_billing_columns() pinned the billing columns but not the
-- admin-side ones. An owner could UPDATE companies and:
--   * turn an admin HOLD into 'UNPAID' (suspended_reason) -- release_for_payment()
--     only refuses a literal HOLD, so the next payment webhook lifts the hold,
--   * rewrite the platform admin's private admin_notes,
--   * forge agreement_signed_at / _name / _version and invited_at / invited_email,
--   * rotate leads_token and back-date details_completed_at.
--
-- Same trigger, same signature, more columns pinned. The two legitimate
-- owner-facing writers (sign_service_agreement, complete_company_details) are
-- SECURITY DEFINER and run with auth.uid() still set, so they announce
-- themselves with a transaction-local GUC the trigger checks. Nothing else can
-- set it: it is set inside those definer functions only, and a caller setting
-- it by hand would have to get a SET through PostgREST, which it does not offer.

create or replace function public.protect_billing_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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

    -- The admin's own side of the row. suspended was already held; the REASON
    -- was not, and the reason is what decides whether a payment lifts the hold.
    new.suspended_reason       := old.suspended_reason;
    new.admin_notes            := old.admin_notes;
    new.invited_at             := old.invited_at;
    new.invited_email          := old.invited_email;
    new.leads_token            := old.leads_token;

    -- Onboarding evidence: written by sign_service_agreement() and
    -- complete_company_details(), which flag themselves below.
    if coalesce(current_setting('fenceflow.trusted_write', true), '') <> 'on' then
        new.agreement_signed_at   := old.agreement_signed_at;
        new.agreement_signed_name := old.agreement_signed_name;
        new.agreement_version     := old.agreement_version;
        new.details_completed_at  := old.details_completed_at;
    end if;

    return new;
end;
$function$;

create or replace function public.sign_service_agreement(typed_name text, version text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    mine uuid;
begin
    select company_id into mine from profiles where id = auth.uid();
    if mine is null then
        raise exception 'You are not part of a business yet.';
    end if;
    if not exists (select 1 from profiles where id = auth.uid() and role = 'OWNER') then
        raise exception 'Only the owner can sign for the business.';
    end if;
    if coalesce(trim(typed_name), '') = '' then
        raise exception 'Type your name to sign.';
    end if;

    -- Transaction-local, and set only here: protect_billing_columns() lets the
    -- agreement columns through for exactly this write.
    perform set_config('fenceflow.trusted_write', 'on', true);

    update companies
       set agreement_signed_at = now(),
           agreement_signed_name = trim(typed_name),
           agreement_version = version,
           joined_at = coalesce(joined_at, now())
     where id = mine;

    perform set_config('fenceflow.trusted_write', 'off', true);
end;
$function$;

create or replace function public.complete_company_details(biz_name text, biz_phone text, biz_email text, license_no text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    mine uuid;
begin
    select company_id into mine from profiles where id = auth.uid();
    if mine is null then
        raise exception 'You are not part of a business yet.';
    end if;
    if not exists (select 1 from profiles where id = auth.uid() and role = 'OWNER') then
        raise exception 'Only the owner can set up the business.';
    end if;
    if coalesce(trim(biz_name), '') = '' then
        raise exception 'Your business needs a name.';
    end if;

    perform set_config('fenceflow.trusted_write', 'on', true);

    update companies c
       set name       = trim(biz_name),
           phone      = trim(coalesce(complete_company_details.biz_phone, '')),
           email      = trim(coalesce(complete_company_details.biz_email, '')),
           license_no = trim(coalesce(complete_company_details.license_no, '')),
           joined_at  = coalesce(c.joined_at, now()),
           details_completed_at = now()
     where c.id = mine;

    perform set_config('fenceflow.trusted_write', 'off', true);
end;
$function$;

-- Bringing a new fencing company on, as a process you can watch.
--
-- Until now a company was created and a setup code read out over the phone,
-- with nothing recording whether they ever got in, filled anything in, agreed
-- to anything, or picked a plan. This makes each of those a step with a date
-- on it, so the admin list can show how far along somebody is instead of
-- looking identical from the first minute to the last.

-- 1. gen_random_bytes lives in the extensions schema, and this function pins
--    search_path to public -- so creating a company failed outright with
--    "function gen_random_bytes(integer) does not exist". Schema-qualified.
--    The invite email is sent separately, by an edge function, because SQL
--    cannot send mail.
create or replace function public.admin_create_company(company_name text, contact_email text default null)
returns table(company_id uuid, setup_code text)
language plpgsql security definer set search_path to 'public'
as $$
declare
    new_id uuid;
    code text;
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may create a company.';
    end if;
    if coalesce(trim(company_name), '') = '' then
        raise exception 'A company needs a name.';
    end if;

    insert into companies (name, email, subscription_status, suspended)
    values (trim(company_name), nullif(trim(coalesce(contact_email, '')), ''), 'pending', false)
    returning id into new_id;

    -- Readable over the phone: no look-alike characters, grouped in fours.
    -- Somebody is going to read this out loud to a contractor in a truck.
    code := upper(
        substr(translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/=OI01l', 'XYZABCDEF'), 1, 4)
        || '-' ||
        substr(translate(encode(extensions.gen_random_bytes(9), 'base64'), '+/=OI01l', 'XYZABCDEF'), 1, 4)
    );

    insert into company_setup_codes (code, company_id) values (code, new_id);

    return query select new_id, code;
end;
$$;

-- 2. The steps a new company goes through, each with the moment it happened.
alter table public.companies
  add column if not exists invited_at timestamptz,
  add column if not exists invited_email text,
  add column if not exists joined_at timestamptz,
  add column if not exists details_completed_at timestamptz,
  add column if not exists agreement_signed_at timestamptz,
  add column if not exists agreement_signed_name text,
  add column if not exists agreement_version text;

-- Anyone already using the app is plainly past all of it; backfilling avoids
-- showing existing customers as though they had never started.
update public.companies
   set joined_at = coalesce(joined_at, created_at),
       details_completed_at = coalesce(details_completed_at, created_at),
       agreement_signed_at = coalesce(agreement_signed_at, created_at),
       agreement_signed_name = coalesce(agreement_signed_name, name)
 where subscription_status in ('active', 'trialing')
    or exists (select 1 from public.profiles p where p.company_id = companies.id);

-- 3. What the new owner fills in for themselves. Runs as the caller, so it can
--    only ever touch their own company, and only the fields onboarding owns --
--    never the billing columns the trigger protects.
create or replace function public.complete_company_details(
    biz_name text, biz_phone text, biz_email text, license_no text
) returns void
language plpgsql security definer set search_path to 'public'
as $$
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

    update companies
       set name = trim(biz_name),
           phone = nullif(trim(coalesce(biz_phone, '')), ''),
           email = nullif(trim(coalesce(biz_email, '')), ''),
           license_no = nullif(trim(coalesce(license_no, '')), ''),
           joined_at = coalesce(joined_at, now()),
           details_completed_at = now()
     where id = mine;
end;
$$;
grant execute on function public.complete_company_details(text, text, text, text) to authenticated;

-- 4. Signing the service agreement. The typed name and the moment are kept:
--    that IS the signature, and it has to be recoverable later.
create or replace function public.sign_service_agreement(typed_name text, version text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
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

    update companies
       set agreement_signed_at = now(),
           agreement_signed_name = trim(typed_name),
           agreement_version = version,
           joined_at = coalesce(joined_at, now())
     where id = mine;
end;
$$;
grant execute on function public.sign_service_agreement(text, text) to authenticated;

-- 5. Where a company has got to, for the person who let them in. One row per
--    company, ordered so the ones needing a nudge are obvious.
create or replace function public.my_onboarding()
returns table(details_done boolean, agreement_done boolean, plan_done boolean,
              agreement_name text, agreement_at timestamptz)
language sql security definer set search_path to 'public'
as $$
    select c.details_completed_at is not null,
           c.agreement_signed_at is not null,
           c.subscription_status in ('active', 'trialing'),
           c.agreement_signed_name,
           c.agreement_signed_at
    from companies c
    where c.id = (select company_id from profiles where id = auth.uid());
$$;
grant execute on function public.my_onboarding() to authenticated;

select 'onboarding installed' as done;

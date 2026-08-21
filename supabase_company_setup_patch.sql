-- Handing a new company the keys, without ever handling their password.
--
-- Creating their auth account for them would need the service_role key in a
-- browser, which is not a thing to do. Instead: you create the company here,
-- send them a one-time code, they sign up themselves and claim it. You never
-- see or set a password, and the code works exactly once.

create table if not exists public.company_setup_codes (
    code        text primary key,
    company_id  uuid not null references public.companies(id) on delete cascade,
    created_at  timestamptz not null default now(),
    -- Single use. A code that still works after somebody has claimed it is a
    -- way into a company that has already started keeping records.
    used_at     timestamptz,
    used_by     uuid references public.profiles(id)
);

alter table public.company_setup_codes enable row level security;

-- Nobody reads these from a client. The claim below is SECURITY DEFINER and
-- looks the code up itself, so there is no need for anyone to be able to list
-- them -- and every reason not to.
drop policy if exists setup_codes_admin_read on public.company_setup_codes;
create policy setup_codes_admin_read on public.company_setup_codes
    for select using (is_platform_admin());

/**
 * Creates a company in the pending state and returns the code to send them.
 *
 * Pending on purpose: the trial clock does not start until you switch them on,
 * so setting somebody up on a Tuesday and getting them on the phone on Friday
 * does not cost them three days.
 */
create or replace function public.admin_create_company(
    company_name text,
    contact_email text default null
)
returns table (company_id uuid, setup_code text)
language plpgsql security definer set search_path = public as $$
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
        substr(translate(encode(gen_random_bytes(9), 'base64'), '+/=OI01l', 'XYZABCDEF'), 1, 4)
        || '-' ||
        substr(translate(encode(gen_random_bytes(9), 'base64'), '+/=OI01l', 'XYZABCDEF'), 1, 4)
    );

    insert into company_setup_codes (code, company_id) values (code, new_id);

    return query select new_id, code;
end;
$$;

/**
 * Turns whoever calls this into the owner of the company the code belongs to.
 *
 * Callable by any signed-in user, which is the point -- they have just made
 * their own account and are not an admin. It is safe because the code is a
 * secret, works once, and grants ownership of one specific brand-new company
 * and nothing else.
 */
create or replace function public.claim_company_setup(setup_code text, owner_name text default '')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
    target uuid;
begin
    select company_id into target
    from company_setup_codes
    where code = upper(trim(setup_code)) and used_at is null;

    if target is null then
        raise exception 'That setup code is not valid, or has already been used.';
    end if;

    update profiles
    set company_id = target,
        role = 'OWNER',
        full_name = coalesce(nullif(trim(owner_name), ''), full_name),
        requested_role = ''
    where id = auth.uid();

    update company_setup_codes
    set used_at = now(), used_by = auth.uid()
    where code = upper(trim(setup_code));

    return target;
end;
$$;

select 'company setup flow installed' as done;

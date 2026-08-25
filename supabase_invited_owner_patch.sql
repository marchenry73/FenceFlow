-- An invited company could not finish setting up. At all.
--
-- welcome.html called join_company asking for OWNER, and join_company pins
-- everyone to CREW on purpose -- letting a joiner name their own role would
-- mean anyone with a company id could make themselves the owner. So the
-- invited person arrived as CREW, pressed "Save and continue", and was told
-- "Only the owner can set up the business" every single time, with no owner
-- anywhere to promote them. Going to the dashboard instead was worse: the
-- company is still 'pending', so they were shown the paused screen with the
-- plan buttons hidden behind an OWNER check. Locked out with no way to pay
-- their way in.
--
-- Claiming is its own thing, and it is safe for two reasons checked here
-- rather than trusted from the caller: the invitation put the company id in
-- the user's own token, and a company that already has an owner cannot be
-- claimed again.
create or replace function public.claim_invited_company(member_name text default '')
returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare
    invited uuid;
    existing_owner uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in.';
    end if;

    -- Straight from the token the invitation minted. A caller cannot forge
    -- this: it is signed, and only the invite put it there.
    invited := nullif(auth.jwt() -> 'user_metadata' ->> 'company_id', '')::uuid;
    if invited is null then
        raise exception 'This account was not invited to a business.';
    end if;

    select id into existing_owner
      from profiles
     where company_id = invited and role = 'OWNER'
     limit 1;

    if existing_owner is not null and existing_owner <> auth.uid() then
        raise exception 'That business already has an owner.';
    end if;

    insert into profiles (id, company_id, full_name, role)
    values (auth.uid(), invited, nullif(trim(member_name), ''), 'OWNER')
    on conflict (id) do update
        set company_id = excluded.company_id,
            full_name  = coalesce(excluded.full_name, profiles.full_name),
            role       = 'OWNER';

    update companies set joined_at = coalesce(joined_at, now()) where id = invited;
    return invited;
end;
$$;
grant execute on function public.claim_invited_company(text) to authenticated;

-- The edge function that sends the invitation runs as the service role, which
-- has no auth.uid() -- so is_platform_admin() was false and this raised every
-- time. The invitation went out and nothing recorded it, which is why the
-- onboarding column never moved off "not started".
create or replace function public.admin_mark_invited(target uuid, to_email text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
    -- auth.uid() is null for the service role: that IS the platform, calling
    -- from a function only the platform admin can reach.
    if auth.uid() is not null and not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may invite a company.';
    end if;
    update companies
       set invited_at = now(),
           invited_email = nullif(trim(coalesce(to_email, '')), ''),
           email = coalesce(nullif(trim(coalesce(to_email, '')), ''), email)
     where id = target;
end;
$$;
grant execute on function public.admin_mark_invited(uuid, text) to authenticated, service_role;

select 'invited owner + invite recording fixed' as done;

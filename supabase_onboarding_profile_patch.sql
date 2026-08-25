-- Nobody except a person creating their own company could actually get in.
--
-- There is no trigger on auth.users, so signing up creates an auth user and
-- nothing else. A profiles row is created by exactly two functions:
-- create_company_with_owner and claim_invited_company. Every other way in --
-- a setup code, or a crew member joining -- assumed the row was already there
-- and ran a bare UPDATE against it.
--
-- A zero-row UPDATE is not an error in plpgsql. So join_company returned
-- perfectly happily having done nothing at all: the crew member was told they
-- had joined, and had not. Proved against the live database.
--
-- And claim_invited_company, the one path that does insert, wrote
-- nullif(trim(member_name), '') into profiles.full_name -- which is NOT NULL.
-- An invitation sent to an address with no name attached (the ordinary case:
-- the admin creates the company with just an email) carries no full_name in
-- its metadata, so member_name arrives blank, nullif turns it into NULL, and
-- the insert dies on the constraint. Proved: "null value in column full_name
-- of relation profiles violates not-null constraint".
--
-- All three now insert-or-update, and none of them can write a null name.

-- 1. The invited owner. Blank name is a blank name, not a null.
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
    values (auth.uid(), invited, coalesce(nullif(trim(member_name), ''), ''), 'OWNER')
    on conflict (id) do update
        set company_id = excluded.company_id,
            full_name  = coalesce(nullif(excluded.full_name, ''), profiles.full_name),
            role       = 'OWNER';

    update companies set joined_at = coalesce(joined_at, now()) where id = invited;
    return invited;
end;
$$;

-- 2. The setup code. Creates the row rather than assuming it.
create or replace function public.claim_company_setup(setup_code text, owner_name text default '')
returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare
    target uuid;
    who uuid := auth.uid();
begin
    if who is null then
        raise exception 'Sign in first, then enter your setup code.';
    end if;

    select company_id into target
      from company_setup_codes
     where code = upper(trim(setup_code)) and used_at is null;

    if target is null then
        raise exception 'That setup code is not valid, or has already been used.';
    end if;

    insert into profiles (id, company_id, full_name, role, requested_role)
    values (who, target, coalesce(nullif(trim(owner_name), ''), ''), 'OWNER', '')
    on conflict (id) do update
        set company_id     = excluded.company_id,
            full_name      = coalesce(nullif(excluded.full_name, ''), profiles.full_name),
            role           = 'OWNER',
            requested_role = '';

    -- Only now, and only by the person who actually claimed it.
    update company_setup_codes
       set used_at = now(), used_by = who
     where code = upper(trim(setup_code));

    update companies set joined_at = coalesce(joined_at, now()) where id = target;
    return target;
end;
$$;

-- 3. A crew member joining. Same fix, and the seat cap still applies.
create or replace function public.join_company(target_company_id uuid, member_name text, requested_role_in text default '')
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
    seat_cap int;
    seats_used int;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to join a business.';
    end if;

    select case lower(coalesce(subscription_plan, ''))
             when 'solo' then 1
             when 'crew' then 6
             else null
           end
      into seat_cap
      from companies where id = target_company_id;

    if not found then
        raise exception 'That business code is not valid.';
    end if;

    if seat_cap is not null then
        select count(*) into seats_used
          from profiles
         where company_id = target_company_id
           and id <> auth.uid();   -- re-joining your own company is not a new seat
        if seats_used >= seat_cap then
            raise exception 'Your plan is full — upgrade to add more crew.';
        end if;
    end if;

    insert into profiles (id, company_id, full_name, role, requested_role)
    values (auth.uid(), target_company_id,
            coalesce(nullif(trim(member_name), ''), ''),
            -- Always the lowest role, whatever they asked for. The request is
            -- recorded next to it for the owner to act on. Letting the joiner
            -- name their own role would let anyone holding a company id make
            -- themselves its owner and read the money.
            'CREW',
            coalesce(nullif(requested_role_in, ''), ''))
    on conflict (id) do update
        set company_id     = excluded.company_id,
            full_name      = coalesce(nullif(excluded.full_name, ''), profiles.full_name),
            role           = 'CREW',
            requested_role = excluded.requested_role;
end;
$$;

revoke execute on function public.claim_invited_company(text) from public, anon;
revoke execute on function public.claim_company_setup(text, text) from public, anon;
revoke execute on function public.join_company(uuid, text, text) from public, anon;
grant  execute on function public.claim_invited_company(text) to authenticated;
grant  execute on function public.claim_company_setup(text, text) to authenticated;
grant  execute on function public.join_company(uuid, text, text) to authenticated;

-- 4. The one path that already worked, hardened the same way. full_name was
-- written straight from the argument, so a caller passing SQL NULL rather than
-- an empty string would hit the same NOT NULL constraint. The website happens
-- to send '' today; that is not a reason to leave it able to fail.
create or replace function public.create_company_with_owner(company_name text, owner_name text)
returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare new_company_id uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to create a business.';
    end if;
    if exists (select 1 from profiles where id = auth.uid() and company_id is not null) then
        raise exception 'You already belong to a business.';
    end if;
    insert into companies (name) values (company_name) returning id into new_company_id;
    insert into profiles (id, company_id, full_name, role)
        values (auth.uid(), new_company_id, coalesce(nullif(trim(owner_name), ''), ''), 'OWNER')
    on conflict (id) do update
        set company_id = excluded.company_id,
            full_name  = coalesce(nullif(excluded.full_name, ''), profiles.full_name),
            role       = 'OWNER';
    return new_company_id;
end $$;
revoke execute on function public.create_company_with_owner(text, text) from public, anon;
grant  execute on function public.create_company_with_owner(text, text) to authenticated;

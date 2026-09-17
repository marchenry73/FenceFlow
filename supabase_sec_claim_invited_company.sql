-- F1 (P1): claim_invited_company() trusted auth.jwt()->'user_metadata'->>'company_id'.
-- user_metadata is writable by any signed-in user (supabase.auth.updateUser({data:...})),
-- so anyone who knew a UUID could make themselves OWNER of an unclaimed company.
--
-- Fix: the company id may still arrive in the token, but it is now only honoured
-- when it is backed by server-controlled state:
--   * app_metadata.company_id  -- only the service role can write this, or
--   * companies.invited_email  -- written by admin_mark_invited() from the
--     invite-company edge function, matched against the caller's VERIFIED
--     address in auth.users.
-- Everything else (owner check, upsert, joined_at) is unchanged. Same signature.

create or replace function public.claim_invited_company(member_name text default ''::text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    invited        uuid;
    server_claim   uuid;
    user_claim     uuid;
    existing_owner uuid;
    mine           uuid;
    my_email       text;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in.';
    end if;

    -- Only the service role can write app_metadata, so this one is trusted outright.
    server_claim := nullif(auth.jwt() -> 'app_metadata' ->> 'company_id', '')::uuid;
    -- user_metadata is caller-writable: a hint only, never proof.
    user_claim   := nullif(auth.jwt() -> 'user_metadata' ->> 'company_id', '')::uuid;

    select email into my_email from auth.users where id = auth.uid();

    if server_claim is not null then
        invited := server_claim;
    elsif user_claim is not null then
        -- The hint is honoured only if the invitation on record was addressed
        -- to this account's own verified email.
        if exists (
            select 1 from companies c
             where c.id = user_claim
               and nullif(trim(coalesce(c.invited_email, '')), '') is not null
               and lower(trim(c.invited_email)) = lower(trim(coalesce(my_email, '')))
        ) then
            invited := user_claim;
        else
            raise exception 'This account was not invited to that business.';
        end if;
    end if;

    if invited is null then
        raise exception 'This account was not invited to a business.';
    end if;

    -- Do not move an existing member out of the business they are already in.
    select company_id into mine from profiles where id = auth.uid();
    if mine is not null and mine <> invited then
        raise exception 'You already belong to a business.';
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
$function$;

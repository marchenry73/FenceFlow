-- Restores the guard that stopped anybody walking into anybody's business.
--
-- supabase_security_patch.sql wrote this guard deliberately, under the heading
-- "join_company should not let someone re-point an existing profile". It was
-- lost when the function gained a third argument: in Postgres that creates a
-- NEW function rather than replacing the old one, so the guarded two-argument
-- version was orphaned and later dropped, leaving only the unguarded one live.
--
-- What was possible until now: anyone could sign up on the dashboard with any
-- email, call this function with another company's id, and be inserted into
-- that company as CREW -- from where every company-scoped policy passes and
-- they can read that contractor's customers, jobs, supplier costs, margins and
-- job photos. The company id is not a secret: it is the invite code itself, it
-- never changes, and it is the first path segment of every job-file URL.
--
-- Two changes, and nothing else about the function moves:
--   1. Somebody who already belongs to a business cannot re-point themselves
--      into another one. A brand-new signup has no company yet, so the normal
--      way a crew member joins is untouched.
--   2. The seat cap now fails CLOSED. It used to resolve to NULL for any plan
--      name it did not recognise -- including an empty one -- and NULL skipped
--      the check entirely. Pro stays genuinely unlimited because that is what
--      Pro is sold as; anything unrecognised gets the tightest cap instead of
--      none.

create or replace function public.join_company(
    target_company_id uuid,
    member_name text,
    requested_role_in text default ''::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    seat_cap int;
    seats_used int;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to join a business.';
    end if;

    -- The company id is an invite code, not proof of anything. Somebody who
    -- already has a business must be moved by an owner, never by themselves.
    if exists (select 1 from profiles
                where id = auth.uid() and company_id is not null) then
        raise exception 'You already belong to a business. Ask an owner to move you.';
    end if;

    -- A removal is remembered, and it blocks the return trip. The owner lifts
    -- it deliberately with allow_rejoin.
    if exists (select 1 from profiles
                where id = auth.uid() and removed_from_company_id = target_company_id) then
        raise exception 'You no longer have access to this business. Ask the owner to add you back.';
    end if;

    select case lower(coalesce(subscription_plan, ''))
             when 'solo' then 1
             when 'crew' then 6
             when 'pro'  then null   -- unlimited logins is what Pro is sold as
             else 1                  -- unknown or blank plan: tightest cap, never none
           end
      into seat_cap
      from companies where id = target_company_id;

    if not found then
        raise exception 'That business code is not valid.';
    end if;

    if seat_cap is not null then
        select count(*) into seats_used
          from profiles
         where company_id = target_company_id and id <> auth.uid();
        if seats_used >= seat_cap then
            raise exception 'Your plan is full — upgrade to add more crew.';
        end if;
    end if;

    insert into profiles (id, company_id, full_name, role, requested_role)
    values (auth.uid(), target_company_id,
            coalesce(nullif(trim(member_name), ''), ''),
            -- Always the lowest role, whatever they asked for.
            'CREW',
            coalesce(nullif(requested_role_in, ''), ''))
    on conflict (id) do update
        set company_id     = excluded.company_id,
            full_name      = coalesce(nullif(excluded.full_name, ''), profiles.full_name),
            role           = 'CREW',
            requested_role = excluded.requested_role;
end;
$function$;

-- Prove the guard is in the body that is actually installed.
select
  position('You already belong to a business' in prosrc) > 0 as guard_present,
  position('else 1                  -- unknown or blank plan' in prosrc) > 0 as cap_fails_closed
from pg_proc
where proname = 'join_company' and pronamespace = 'public'::regnamespace;

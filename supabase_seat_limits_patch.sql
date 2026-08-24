-- Plan seat limits, enforced where seats are actually granted.
--
-- The pricing page sells Solo (owner only), Crew (owner + 5) and Pro
-- (unlimited), but nothing enforced it: a Solo company could add crew
-- without limit. The check lives in join_company -- the one door every
-- login walks through, app and website alike -- so no client can skip it.
--
-- A blank or unknown plan means no cap: companies granted access by hand
-- (before Stripe existed) were never sold a seat count, and locking them
-- out of hiring would be a regression nobody signed up for.
create or replace function public.join_company(
    target_company_id uuid, member_name text, requested_role_in text default ''
) returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
    seat_cap int;
    seats_used int;
begin
  select case lower(coalesce(subscription_plan, ''))
           when 'solo' then 1
           when 'crew' then 6
           else null
         end
    into seat_cap
    from companies where id = target_company_id;

  if seat_cap is not null then
    select count(*) into seats_used
      from profiles
     where company_id = target_company_id
       and id <> auth.uid();  -- re-joining your own company is not a new seat
    if seats_used >= seat_cap then
      raise exception 'Your plan is full — upgrade to add more crew.';
    end if;
  end if;

  update profiles
     set company_id = target_company_id,
         full_name = coalesce(nullif(member_name, ''), full_name),
         -- Always the lowest role, whatever they asked for. The request is
         -- recorded next to it for the owner to act on.
         role = 'CREW',
         requested_role = coalesce(nullif(requested_role_in, ''), '')
   where id = auth.uid();
end;
$$;

select 'seat limits installed' as done;

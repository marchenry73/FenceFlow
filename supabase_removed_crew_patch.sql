-- "They lose access on their phone straight away." They did not.
--
-- The owner fires somebody, opens App logins and presses Remove. release_seat
-- sets profiles.company_id to null and records nothing else. The invite code a
-- crew member joins with IS the company id, and that never changes. So the
-- person opens the app, pastes the same code they were sent on day one, taps
-- Join the team, and they are back: back in the company, back on a paid seat,
-- and back to reading the money. Nothing in the owner's screen says they
-- returned.
--
-- Reproduced end to end in one rolled-back transaction: owner removes the crew
-- member, the ex-employee calls join_company with the company id, and
-- profiles.company_id is populated again with role CREW.
--
-- A removal is now remembered, and a remembered removal blocks the return
-- trip. Nothing is deleted -- every job, hour and note that person made stays
-- exactly where it is, which is the promise the dialog already makes.
alter table public.profiles
  add column if not exists removed_from_company_id uuid references public.companies(id),
  add column if not exists removed_at timestamptz;

comment on column public.profiles.removed_from_company_id is
  'The company that removed this person. Blocks a return on the same invite code until the owner lets them back in.';

create or replace function public.release_seat(member_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
    caller_company uuid;
begin
    select company_id into caller_company from profiles where id = auth.uid();
    if caller_company is null then
        raise exception 'You are not part of a business.';
    end if;
    if not exists (select 1 from profiles
                    where id = auth.uid() and company_id = caller_company and role = 'OWNER') then
        raise exception 'Only the owner can remove someone from the business.';
    end if;
    if member_id = auth.uid() then
        raise exception 'You cannot remove yourself from your own business.';
    end if;
    if not exists (select 1 from profiles where id = member_id and company_id = caller_company) then
        raise exception 'That person is not in your business.';
    end if;

    update profiles
       set company_id = null,
           requested_role = '',
           removed_from_company_id = caller_company,
           removed_at = now()
     where id = member_id;
end;
$$;
revoke execute on function public.release_seat(uuid) from public, anon;
grant  execute on function public.release_seat(uuid) to authenticated;

-- Letting somebody back in is a decision the owner makes on purpose, because
-- removing the wrong person by mistake must not be a one-way door.
create or replace function public.allow_rejoin(member_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
    caller_company uuid;
begin
    select company_id into caller_company from profiles where id = auth.uid();
    if caller_company is null then
        raise exception 'You are not part of a business.';
    end if;
    if not exists (select 1 from profiles
                    where id = auth.uid() and company_id = caller_company and role = 'OWNER') then
        raise exception 'Only the owner can let somebody back in.';
    end if;

    update profiles
       set removed_from_company_id = null,
           removed_at = null
     where id = member_id
       and removed_from_company_id = caller_company;
end;
$$;
revoke execute on function public.allow_rejoin(uuid) from public, anon;
grant  execute on function public.allow_rejoin(uuid) to authenticated;

-- Who the owner removed, so the dashboard can offer to let them back in.
create or replace function public.removed_people()
returns table(id uuid, full_name text, removed_at timestamptz)
language sql security definer set search_path to 'public'
as $$
    select p.id, p.full_name, p.removed_at
      from profiles p
     where p.removed_from_company_id = (select company_id from profiles where id = auth.uid())
       and exists (select 1 from profiles me
                    where me.id = auth.uid() and me.role = 'OWNER')
     order by p.removed_at desc;
$$;
revoke execute on function public.removed_people() from public, anon;
grant  execute on function public.removed_people() to authenticated;

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

    -- A removal is remembered, and it blocks the return trip. The owner lifts
    -- it deliberately with allow_rejoin.
    if exists (select 1 from profiles
                where id = auth.uid() and removed_from_company_id = target_company_id) then
        raise exception 'You no longer have access to this business. Ask the owner to add you back.';
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
$$;
revoke execute on function public.join_company(uuid, text, text) from public, anon;
grant  execute on function public.join_company(uuid, text, text) to authenticated;

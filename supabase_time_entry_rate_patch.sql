-- A shift with nobody attached to it had its pay rate wiped on every sync.
--
-- stamp_time_entry_rate ended with:
--
--     new.hourly_rate := coalesce(real_rate, 0);
--
-- real_rate comes from looking the employee up by employee_sync_id. When that
-- finds nothing -- an older shift recorded before the app attached a person to
-- it, or one whose employee has since been removed -- the rate was forced to
-- zero. Not once: every single write. So the office could never correct it,
-- and the hours were worth nothing for ever. Both shifts in this database are
-- in exactly that state, and both read $0.
--
-- The old comment said "the office fixes it when they approve the shift".
-- Nothing did that, and had anyone tried, the next push would have zeroed it
-- again.
--
-- Distrusting a number sent by a crew handset is right and is kept. Deleting
-- the office's own figure in order to achieve it is not.
create or replace function public.stamp_time_entry_rate()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    real_rate  numeric;
    privileged boolean;
begin
    select e.hourly_rate into real_rate
      from employees e
     where e.company_id = new.company_id
       and e.sync_id::text = new.employee_sync_id
     limit 1;

    -- The employee record is the authority whenever there is one to consult,
    -- so the figure the phone sent is ignored. This is the case that matters
    -- for security and it behaves exactly as before.
    if real_rate is not null then
        new.hourly_rate := real_rate;
        return new;
    end if;

    -- Nobody to check against. Who is allowed to state a rate unverified?
    --
    -- Deliberately NOT "auth.uid() is null" as a stand-in for the server, and
    -- deliberately no "session_user = postgres" hatch either: under PostgREST
    -- a role switch leaves session_user alone, so such a test says yes to
    -- everybody the moment anything connects as an admin. An operator who
    -- genuinely needs to set a rate by hand sets a service_role claim.
    -- auth.uid() is null for an anonymous caller too, so that test would have
    -- handed the decision to exactly the people it was meant to exclude.
    privileged :=
        coalesce(public.can_see_pay(), false)
        or coalesce(
             nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
             '') = 'service_role'
        ;

    if tg_op = 'UPDATE' then
        -- Never wipe what is already recorded. Someone without pay access who
        -- tries to change the number simply doesn't change it.
        if new.hourly_rate is distinct from old.hourly_rate and not privileged then
            new.hourly_rate := old.hourly_rate;
        end if;
        return new;
    end if;

    -- A brand new shift with nobody attached. Record no rate rather than an
    -- unverified one, unless it came from someone trusted with pay.
    if not privileged then
        new.hourly_rate := 0;
    else
        new.hourly_rate := coalesce(new.hourly_rate, 0);
    end if;
    return new;
end;
$function$;

comment on function public.stamp_time_entry_rate() is
  'Stamps the employee''s real rate onto a shift. When no employee matches, keeps the existing rate instead of destroying it; only someone with SEE_MONEY may state one unverified.';

-- Anyone at all could lift a suspension.
--
-- release_for_payment is how a company comes back the moment their payment
-- clears: the Stripe webhook calls it as the service role after a successful
-- invoice. It had no check on WHO was calling -- just a company id --
--
--     update companies set suspended = false, suspended_reason = ''
--      where id = cid and suspended and suspended_reason is distinct from 'HOLD'
--
-- and EXECUTE was granted to anon along with everything else. So a single
-- HTTP request carrying the website's public key and a company's id lifted
-- that company's suspension. Proved against the live database inside a
-- rolled-back transaction: suspended for UNPAID, then released by a caller
-- whose only claim was {"role":"anon"}.
--
-- The company most likely to know its own id is the one that was just
-- suspended for not paying, which is exactly the wrong person to hand this to.
--
-- Same shape of mistake as admin_mark_invited, and the same shape of fix:
-- auth.uid() cannot tell the backend from a stranger, so the JWT role claim
-- has to, and the grant is narrowed as well.

-- One place to be right about what "the backend itself" means.
create or replace function public.is_service_role()
returns boolean
language sql stable security definer set search_path to 'public'
as $$
    select coalesce(
             nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role',
             ''
           ) = 'service_role';
$$;
revoke execute on function public.is_service_role() from public, anon;
grant  execute on function public.is_service_role() to authenticated, service_role;

create or replace function public.release_for_payment(cid uuid)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare
    released boolean := false;
begin
    -- The backend after a cleared payment, or the platform admin by hand.
    -- Nobody else, and in particular not the suspended company itself.
    if not (public.is_service_role() or public.is_platform_admin()) then
        raise exception 'Only FenceFlow can lift a suspension.';
    end if;

    update companies
       set suspended = false,
           suspended_reason = ''
     where id = cid
       and suspended
       -- A deliberate hold is March's decision and paying does not undo it.
       and suspended_reason is distinct from 'HOLD'
    returning true into released;
    return coalesce(released, false);
end;
$$;
revoke execute on function public.release_for_payment(uuid) from public, anon;
grant  execute on function public.release_for_payment(uuid) to authenticated, service_role;

-- admin_mark_invited was fixed the same way an hour ago with the check written
-- out inline. Pointed at the helper now, so there is one definition of "is
-- this the backend" rather than two that can drift apart.
create or replace function public.admin_mark_invited(target uuid, to_email text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
    if auth.uid() is null then
        if not public.is_service_role() then
            raise exception 'Only a FenceFlow admin may invite a company.';
        end if;
    elsif not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may invite a company.';
    end if;

    update companies
       set invited_at = now(),
           invited_email = nullif(trim(coalesce(to_email, '')), ''),
           email = coalesce(nullif(trim(coalesce(to_email, '')), ''), email)
     where id = target;
end;
$$;
revoke execute on function public.admin_mark_invited(uuid, text) from public, anon;
grant  execute on function public.admin_mark_invited(uuid, text) to authenticated, service_role;

-- Nothing else needs anon. These are read-only or already guarded, but a
-- function anon has no business calling should not be callable by anon:
-- defence that does not depend on every body staying correct for ever.
revoke execute on function public.admin_create_company(text, text)   from public, anon;
revoke execute on function public.admin_extend_trial(uuid, integer)  from public, anon;
revoke execute on function public.admin_grant_access(uuid, text)     from public, anon;
revoke execute on function public.admin_mark_errors_seen(text, text) from public, anon;
revoke execute on function public.admin_start_trial(uuid, integer)   from public, anon;
revoke execute on function public.admin_suspend(uuid, text, boolean) from public, anon;
revoke execute on function public.admin_unsuspend(uuid)              from public, anon;
revoke execute on function public.admin_error_summary(integer)       from public, anon;
revoke execute on function public.release_seat(uuid)                 from public, anon;
revoke execute on function public.save_company_settings(jsonb)       from public, anon;
revoke execute on function public.sign_service_agreement(text, text) from public, anon;
revoke execute on function public.complete_company_details(text, text, text, text) from public, anon;
revoke execute on function public.ar_aging()                         from public, anon;
revoke execute on function public.job_costing(timestamptz, timestamptz) from public, anon;
revoke execute on function public.my_billing_status()                from public, anon;
revoke execute on function public.my_onboarding()                    from public, anon;

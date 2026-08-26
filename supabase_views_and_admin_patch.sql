-- Three things that are not judgement calls.
--
-- 1. TWO VIEWS BYPASSED ROW LEVEL SECURITY ENTIRELY.
--    jobs_crew_view and estimate_line_items_crew are money-free projections
--    meant for crew. Neither sets security_invoker, and both are owned by
--    postgres, so they run with their creator's rights and RLS on the
--    underlying tables never applies to them. A suspended company -- one that
--    has stopped paying -- reads its jobs and estimates straight through them.
--    platform_clients, sitting beside them, already has security_invoker=true,
--    so this is an omission rather than a decision.
--
--    Nothing in the app, either website, or any edge function queries either
--    view today, so turning RLS back on for them cannot break anybody. Doing
--    it now also means they are safe to start using, which is the sensible
--    answer to crew needing a materials list without the costs on it.
alter view public.jobs_crew_view           set (security_invoker = true);
alter view public.estimate_line_items_crew set (security_invoker = true);

-- 2. CREATING A COMPANY WITHOUT AN EMAIL FAILED WITH A RAW POSTGRES ERROR.
--    admin.html deliberately supports leaving the email blank -- that is the
--    path that shows a setup code to read down the phone. But
--    admin_create_company inserted nullif(trim(coalesce(contact_email,'')),''),
--    which is NULL for a blank box, and companies.email is NOT NULL with a ''
--    default. So the one flow the dialog explains produced a not-null
--    constraint violation and no company. Same mistake, same shape, as the one
--    that stopped every onboarding at step 1.
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

    -- '' rather than NULL. That is what the column defaults to, and it does
    -- not accept NULL -- which is the ONLY change here. Everything else,
    -- including the setup code, is exactly as it was.
    insert into companies (name, email, subscription_status, suspended)
    values (trim(company_name), trim(coalesce(contact_email, '')), 'pending', false)
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
revoke execute on function public.admin_create_company(text, text) from public, anon;
grant  execute on function public.admin_create_company(text, text) to authenticated;

-- 3. CREW COULD BLANK THE CUSTOMER ON EVERY JOB AT ONCE.
--    jobs_update carries no role test, so any member may write any column of
--    any job in the company. Executed as a real CREW profile:
--        update jobs set customer_name = '', address = '';
--    succeeded across every job. This is destruction that never looks like a
--    delete: the rows still exist, so there is no tombstone to clear and
--    nothing to restore from, and the audit trail does not cover these columns.
--
--    Crew genuinely need to write to jobs -- that is what RECORD_FIELD_WORK
--    is -- and RLS cannot restrict a single column, so the guard is a trigger,
--    the same shape as enforce_delete_permission. Who the customer is, where
--    they live and how to reach them is office information; changing it needs
--    EDIT_JOBS, which OWNER, MANAGER and SALES have.
create or replace function public.protect_customer_identity()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
    -- A direct database connection -- a migration, a backup, psql -- has no
    -- request context at all. Only requests arriving through the API are
    -- judged here. Checking is_service_role() alone was not enough: that
    -- reads a JWT claim, and a direct connection has no JWT, so maintenance
    -- ran as an unprivileged caller and had its writes quietly reverted.
    claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
    -- Keeps the office's version rather than refusing the write.
    --
    -- Refusing looked right and would have broken crew sync outright. The app
    -- pushes the WHOLE job row whenever the phone's copy is the newer one
    -- (JobSync.kt:373-390), so an installer who edits a punch-list item at
    -- 10:00 pushes the customer name as it was on their phone -- which may be
    -- yesterday's, if the office corrected it since. Raising there would have
    -- rejected the entire update and thrown away their field work, and only
    -- for crew, who are exactly the people working offline all day.
    --
    -- So the columns are held at their existing values instead. Their field
    -- work goes up, the office's correction stays put, and nobody loses
    -- anything. Who the customer is, where they live and how to reach them is
    -- office information; changing it needs EDIT_JOBS, which OWNER, MANAGER
    -- and SALES have.
    --
    -- Asks whether the caller IS the backend rather than inferring it from the
    -- absence of a user: "no auth.uid()" is also what an anonymous caller
    -- looks like, and that assumption is what opened admin_mark_invited and
    -- release_for_payment earlier tonight.
    if claims is not null
       and not public.is_service_role()
       and not has_permission('EDIT_JOBS') then
        new.customer_name := old.customer_name;
        new.address       := old.address;
        new.phone         := old.phone;
        new.customer_id   := old.customer_id;
    end if;
    return new;
end;
$$;

drop trigger if exists protect_customer_identity on public.jobs;
create trigger protect_customer_identity
    before update on public.jobs
    for each row execute function public.protect_customer_identity();

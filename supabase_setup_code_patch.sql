-- A stranger could burn a setup code without claiming anything.
--
-- claim_company_setup is how a new customer becomes the owner of the company
-- FenceFlow set up for them: they make their own account, then hand over the
-- one-time code. Two things were wrong.
--
-- It never checked that anybody was signed in. Its siblings
-- create_company_with_owner and claim_invited_company both open with
-- "if auth.uid() is null then raise"; this one did not, and EXECUTE was
-- granted to anon.
--
-- And the two writes were not tied together:
--
--     update profiles set company_id = target, role = 'OWNER' ...
--      where id = auth.uid();          -- anon: auth.uid() is null, ZERO rows
--
--     update company_setup_codes set used_at = now(), used_by = auth.uid()
--      where code = upper(trim(setup_code));   -- runs regardless, code BURNED
--
-- So an anonymous caller who learned a code consumed it while claiming
-- nothing. Proved against the live database inside a rolled-back transaction:
-- after the call, used_at was set and used_by was null -- nobody owned the
-- company and the code was spent. These codes are short and read aloud over
-- the phone, and the admin dialog shows each one exactly once and never again,
-- so the legitimate new owner is locked out permanently with no way to recover.
--
-- Now: a session is required, and the code is only marked used if the profile
-- update actually claimed it. A code is spent by the person who used it, or
-- not at all.
create or replace function public.claim_company_setup(setup_code text, owner_name text default '')
returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare
    target uuid;
    claimed int;
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

    update profiles
       set company_id = target,
           role = 'OWNER',
           full_name = coalesce(nullif(trim(owner_name), ''), full_name),
           requested_role = ''
     where id = who;

    get diagnostics claimed = row_count;

    -- The code is spent by whoever actually claimed it, or not at all. If the
    -- profile row was not there, nothing has been consumed and they can try
    -- again with the same code once their account exists.
    if claimed = 0 then
        raise exception 'Your account is not set up yet. Sign out, sign back in, and try again.';
    end if;

    update company_setup_codes
       set used_at = now(), used_by = who
     where code = upper(trim(setup_code));

    return target;
end;
$$;
revoke execute on function public.claim_company_setup(text, text) from public, anon;
grant  execute on function public.claim_company_setup(text, text) to authenticated;

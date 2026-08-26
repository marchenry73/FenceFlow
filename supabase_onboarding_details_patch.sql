-- Step 1 of onboarding failed for every single person, with a raw Postgres error.
--
-- "Tell us about your business" -> Save and continue -> a red line reading
--     column reference "license_no" is ambiguous
-- and no way forward. The fourth parameter is named license_no, identical to
-- companies.license_no, so plpgsql refuses the reference. It fires whatever
-- you type. And dashboard.html bounces any OWNER whose details are not done
-- back to welcome.html, so typing the dashboard URL by hand returns them to
-- the same broken screen. Nobody could reach the agreement step, the plan
-- step, or pay us anything.
--
-- Production has two companies and exactly one with details_completed_at set,
-- which is what a function that has essentially never completed looks like.
--
-- Behind it sat a second wall. companies.phone, email and license_no are all
-- NOT NULL with a '' default, while the body wrote nullif(trim(...), '') --
-- NULL for an empty box. The licence field is labelled "(optional)" on the
-- form, and most fencing contractors have no licence number to type, so the
-- ordinary case violated a not-null constraint.
--
-- Argument NAMES are unchanged, so welcome.html's existing rpc call keeps
-- working; renaming them would make PostgREST answer PGRST202 instead.
create or replace function public.complete_company_details(
    biz_name text, biz_phone text, biz_email text, license_no text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
    mine uuid;
begin
    select company_id into mine from profiles where id = auth.uid();
    if mine is null then
        raise exception 'You are not part of a business yet.';
    end if;
    if not exists (select 1 from profiles where id = auth.uid() and role = 'OWNER') then
        raise exception 'Only the owner can set up the business.';
    end if;
    if coalesce(trim(biz_name), '') = '' then
        raise exception 'Your business needs a name.';
    end if;

    -- Qualified with the function name so plpgsql knows the parameter from the
    -- column, and writing '' rather than NULL because that is what these
    -- columns default to and they do not accept NULL.
    update companies c
       set name       = trim(biz_name),
           phone      = trim(coalesce(complete_company_details.biz_phone, '')),
           email      = trim(coalesce(complete_company_details.biz_email, '')),
           license_no = trim(coalesce(complete_company_details.license_no, '')),
           joined_at  = coalesce(c.joined_at, now()),
           details_completed_at = now()
     where c.id = mine;
end;
$$;
revoke execute on function public.complete_company_details(text,text,text,text) from public, anon;
grant  execute on function public.complete_company_details(text,text,text,text) to authenticated;

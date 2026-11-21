-- ============================================================
-- FenceFlow -- a test company you can make, and cannot make by accident
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- WHAT MARCH ASKED FOR (owner list E2, answered 2026-11-21 with "create")
--   "A TEST product key that unlocks the test data, and a REAL one -- a
--    sandbox and the live app -- both controlled from the admin portal."
--
--   Asked which he wanted, flipping an existing company or making a new one,
--   he said CREATE. That is the safe half and it is the half this does.
--
-- WHY NOT A CHECKBOX ON THE EXISTING CREATE DIALOG
--   r64's own comment is the rule: "a checkbox here would be a way to make a
--   test company start mailing real people by misclick." The mirror of that
--   mistake is just as bad -- ticking it on a REAL new company gives a paying
--   contractor a company that can never hold a mailbox or a card processor,
--   with no screen anywhere to undo it.
--
--   So this is a SEPARATE DOOR with a separate name, and the name it writes
--   is stamped: a test company is called "ZZ TEST -- <name>" whatever the
--   admin types, which is the convention the one existing sandbox already
--   follows. A sandbox is then recognisable in every list, export and email
--   on the platform, not only where the badge is drawn.
--
-- WHY IT CALLS admin_create_company RATHER THAN REPEATING IT
--   The setup code's alphabet ("no look-alike characters, grouped in fours,
--   somebody is going to read this out loud to a contractor in a truck") is
--   business wording, and a second copy of it is a second thing to keep in
--   step. This calls the real door and then flips the new row, inside one
--   transaction, so nothing ever observes the company as a live one.
--
--   It also means the platform-admin check is the REAL one, run once, for the
--   real caller: a SECURITY DEFINER function does not change
--   request.jwt.claims, so auth.uid() inside admin_create_company is still
--   the person at the keyboard. That is the same property that made the
--   RECORD_MONEY regression on 20 Nov, used here on purpose.
--
-- WHY THE CATALOG COPY IS OPTIONAL AND ONE-WAY
--   A sandbox with no price list cannot price anything, so it is no use as a
--   demo. sandbox_refresh_from (r64 PART 4) already copies the catalog and
--   settings and already refuses to write into anything that is not a
--   sandbox. It is granted to service_role only; this definer function is
--   owned by postgres, so it may call it while the office page may not --
--   the door stays shut and this is the one key.
--
-- AND WHY sandbox_refresh_from IS AMENDED HERE
--   MEASURED, in a rolled-back probe against production before any of this
--   was applied: the sandbox came out called "Legacy Solutions".
--
--   company_settings carries the company's IDENTITY in its blob --
--   business_name, phone, license_number, email -- and
--   company_settings_mirror_identity pushes all four into companies.* on
--   every write. So copying a live company's settings into a sandbox renamed
--   the sandbox after the live business, and gave it the same phone, licence
--   number and email. A sandbox indistinguishable from the real company in
--   every list is the precise thing r64 exists to prevent, and the copy that
--   did it is r64's own.
--
--   It has never happened in production only because the function is granted
--   to service_role and no caller existed; this feature would have been the
--   first. Fixed where the copy happens, not in the new caller, so the next
--   caller inherits the fix: the four identity keys are stripped from the
--   blob on the way in. The sandbox keeps its own name, and the mirror then
--   has nothing to push.
-- ============================================================

-- ------------------------------------------------------------------------
-- r64 PART 4, amended: copy the catalog and the settings, never the identity
-- ------------------------------------------------------------------------
create or replace function public.sandbox_refresh_from(p_source uuid, p_target uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    n_items int;
    n_set   int;
begin
    if p_source is null or p_target is null then
        raise exception 'Both a source and a target company are required.';
    end if;
    if p_source = p_target then
        raise exception 'Source and target are the same company.';
    end if;
    if not public.company_is_sandbox(p_target) then
        raise exception
            'Refusing to write into a company that is not a sandbox. This copies one way only, into the sandbox.'
            using errcode = 'check_violation';
    end if;
    if public.company_is_sandbox(p_source) then
        raise exception 'The source is itself a sandbox; copy from the live company.'
            using errcode = 'check_violation';
    end if;

    delete from public.material_items where company_id = p_target;
    insert into public.material_items
        (company_id, sync_id, category, role, fence_type, name, unit, unit_price,
         source_doc, taxable, updated_at)
    select p_target, gen_random_uuid(), m.category, m.role, m.fence_type, m.name,
           m.unit, m.unit_price, m.source_doc, m.taxable, now()
      from public.material_items m
     where m.company_id = p_source
       and m.deleted_at is null;
    select count(*) into n_items from public.material_items where company_id = p_target;

    -- THE FOUR IDENTITY KEYS ARE STRIPPED. company_settings_mirror_identity
    -- pushes each of them into companies.* on write, so copying them would
    -- rename the sandbox after the live business and hand it that business's
    -- phone, licence and email. Everything else in the blob -- the rates, the
    -- margins, the tax, the defaults, which is the whole point of the copy --
    -- comes across untouched.
    insert into public.company_settings (company_id, settings, updated_at)
    select p_target,
           coalesce(s.settings, '{}'::jsonb)
             - 'business_name' - 'phone' - 'license_number' - 'email',
           now()
      from public.company_settings s
     where s.company_id = p_source
    on conflict (company_id) do update
        set settings = excluded.settings, updated_at = now();
    select count(*) into n_set from public.company_settings where company_id = p_target;

    return format('copied %s catalog row(s) and %s settings row(s) into the sandbox', n_items, n_set);
end;
$function$;

-- Restated rather than relied on: CREATE OR REPLACE keeps the old privileges,
-- and saying them here means a reader of this file knows what they are.
revoke execute on function public.sandbox_refresh_from(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.sandbox_refresh_from(uuid, uuid) to service_role;

create or replace function public.admin_create_test_company(
    company_name text,
    copy_catalog_from uuid default null
)
returns table(company_id uuid, setup_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    new_id uuid;
    code   text;
begin
    -- Refused BEFORE anything is created, so a mistyped source does not leave
    -- a half-made company behind for somebody to wonder about.
    if copy_catalog_from is not null then
        if not exists (select 1 from public.companies c where c.id = copy_catalog_from) then
            raise exception 'No company to copy the price list from.'
                using errcode = 'check_violation';
        end if;
        if public.company_is_sandbox(copy_catalog_from) then
            raise exception 'Copy the price list from the live company, not from another sandbox.'
                using errcode = 'check_violation';
        end if;
    end if;

    -- The real door, with the real platform-admin check and the real setup
    -- code. It raises for anyone who is not March with a fresh second factor.
    select t.company_id, t.setup_code
      into new_id, code
      from public.admin_create_company('ZZ TEST — ' || trim(coalesce(company_name, '')), null) as t;

    -- Born sandboxed. In the same transaction as the insert, so there is no
    -- moment at which this exists as an ordinary company: r64's capability
    -- guards read the flag at the moment of a write, and no write can reach a
    -- row nobody can see yet.
    update public.companies set is_sandbox = true where id = new_id;

    if copy_catalog_from is not null then
        perform public.sandbox_refresh_from(copy_catalog_from, new_id);
    end if;

    -- The name is checked AFTER everything that could have changed it, and a
    -- wrong one takes the whole creation down with it. A sandbox wearing a
    -- live company's name is worse than no sandbox: this function's entire
    -- purpose is that the two cannot be confused, so it must not half-succeed.
    if not exists (select 1 from public.companies c
                    where c.id = new_id and c.name like 'ZZ TEST %' and c.is_sandbox) then
        raise exception
            'A test company must end up named "ZZ TEST ..." and flagged as a sandbox; this one did not, so nothing was created.'
            using errcode = 'check_violation';
    end if;

    return query select new_id, code;
end;
$function$;

-- A new function is EXECUTE-able by PUBLIC until it is not. Said explicitly
-- rather than relied upon: see memory/new-tables-are-granted-to-anon.md.
revoke execute on function public.admin_create_test_company(text, uuid) from public, anon;
grant  execute on function public.admin_create_test_company(text, uuid) to authenticated;

-- ------------------------------------------------------------------------
-- Prove it. Every row must read true.
-- ------------------------------------------------------------------------
select 'the function exists' as check,
       (select count(*) = 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'admin_create_test_company') as ok
union all
select 'anon cannot execute it',
       not has_function_privilege('anon', 'public.admin_create_test_company(text, uuid)', 'EXECUTE')
union all
select 'authenticated can execute it',
       has_function_privilege('authenticated', 'public.admin_create_test_company(text, uuid)', 'EXECUTE')
union all
select 'it is SECURITY DEFINER, like the door it calls',
       (select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'admin_create_test_company')
union all
select 'sandbox_refresh_from is still shut to the office',
       not has_function_privilege('authenticated', 'public.sandbox_refresh_from(uuid, uuid)', 'EXECUTE')
union all
select 'the stamped prefix matches the sandbox already in use',
       (select count(*) > 0 from public.companies
         where is_sandbox and name like 'ZZ TEST %');

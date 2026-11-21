-- ============================================================
-- E2 probe -- the real function, against the real database, rolled back.
--
-- DDL is transactional in Postgres, so the function being judged is created
-- inside the transaction and vanishes with it: nothing here survives, and no
-- company is left behind.
--
-- ONE THING IS STUBBED, and it is named rather than hidden:
-- admin_second_factor_ok() is replaced with `true` for the length of the
-- transaction, because a fresh second factor is a thing a person does at a
-- keyboard and cannot honestly be faked from here. Everything else is the
-- shipped path -- the real admin_create_company, the real is_platform_admin
-- (identity and email still checked against the live profiles row), the real
-- r64 guards, and the real sandbox_refresh_from.
--
-- POSITIVE CONTROLS, because a probe that only watches refusals cannot tell a
-- correct guard from one that refuses everything -- see
-- memory/guard-too-wide-needs-the-other-question.md.
-- ============================================================
begin;

create temporary table probe(step text, detail text, ok boolean) on commit drop;

-- ---------------------------------------------------------------- the fix
\i supabase_e2_create_test_company.sql

-- -------------------------------------------- the one honest stub, declared
create or replace function public.admin_second_factor_ok() returns boolean
language sql stable as $$ select true $$;

-- =========================================================== THE REFUSALS
-- Nobody signed in at all.
select set_config('request.jwt.claims', null, true);
do $$
begin
    perform public.admin_create_test_company('Anon attempt');
    insert into probe values ('an anonymous caller is refused', 'IT WAS ALLOWED', false);
exception when others then
    insert into probe values ('an anonymous caller is refused', sqlerrm, true);
end $$;

-- Signed in, but not the platform admin. Picked by property: any profile that
-- is NOT the admin, rather than a uid typed in here that could go stale.
do $$
declare other_uid uuid;
begin
    select p.id into other_uid from public.profiles p
     where coalesce(p.is_platform_admin, false) = false limit 1;
    perform set_config('request.jwt.claims',
        json_build_object('sub', other_uid, 'role', 'authenticated')::text, true);
    begin
        perform public.admin_create_test_company('Not the admin');
        insert into probe values ('a signed-in non-admin is refused', 'IT WAS ALLOWED', false);
    exception when others then
        insert into probe values ('a signed-in non-admin is refused', sqlerrm, true);
    end;
end $$;

-- ====================================================== THE LEGITIMATE ROUTE
-- The platform admin, with the second factor stubbed as declared above.
select set_config('request.jwt.claims',
    json_build_object('sub', '7bf38947-24cf-4e79-9af0-6100d04b166b', 'role', 'authenticated')::text,
    true);

-- A source chosen BY PROPERTY -- the live company with the most catalog rows
-- -- never a name or id typed in here. A fixture pinned to one row is how
-- four earlier proofs were voided: memory/fixture-pinned-to-a-person.md.
do $$
declare
    src uuid;
    src_items int;
    made uuid;
    v_code text;
    nm text;
    sandboxed boolean;
    copied int;
begin
    select m.company_id, count(*) into src, src_items
      from public.material_items m
      join public.companies c on c.id = m.company_id
     where m.deleted_at is null and coalesce(c.is_sandbox, false) = false
     group by m.company_id order by count(*) desc limit 1;
    insert into probe values ('a live source with a real catalog was found',
        coalesce(src::text, 'NONE') || ' with ' || coalesce(src_items, 0) || ' rows',
        src is not null and src_items > 0);

    select t.company_id, t.setup_code into made, v_code
      from public.admin_create_test_company('Busy season', src) as t;

    select c.name, c.is_sandbox into nm, sandboxed from public.companies c where c.id = made;
    insert into probe values ('the admin CAN create one', coalesce(nm, '(no row)'), made is not null);
    insert into probe values ('it is born sandboxed', coalesce(sandboxed::text, 'null'), sandboxed is true);
    insert into probe values ('the name is stamped, whatever was typed', nm, nm like 'ZZ TEST %');
    insert into probe values ('a setup code comes back, in the readable shape',
        coalesce(v_code, '(none)'), v_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$');
    insert into probe values ('the setup code is stored against it', '',
        exists (select 1 from public.company_setup_codes s where s.company_id = made and s.code = v_code));

    select count(*) into copied from public.material_items where company_id = made;
    insert into probe values ('the price list came with it',
        copied || ' of ' || src_items || ' rows', copied = src_items);
    insert into probe values ('and the settings did too', '',
        exists (select 1 from public.company_settings s where s.company_id = made));

    -- THE ONE THE FIRST RUN OF THIS PROBE CAUGHT. company_settings carries
    -- business_name, phone, license_number and email, and
    -- company_settings_mirror_identity pushes all four into companies.* --
    -- so the untouched r64 copy renamed the sandbox "Legacy Solutions" and
    -- handed it that company's phone, licence and email.
    declare src_name text; src_phone text; src_lic text; src_email text;
            got_name text; got_phone text; got_lic text; got_email text;
    begin
        select c.name, c.phone, c.license_no, c.email
          into src_name, src_phone, src_lic, src_email
          from public.companies c where c.id = src;
        select c.name, c.phone, c.license_no, c.email
          into got_name, got_phone, got_lic, got_email
          from public.companies c where c.id = made;
        insert into probe values ('it is NOT named after the live company',
            coalesce(got_name,'(none)') || ' vs ' || coalesce(src_name,'(none)'),
            got_name is distinct from src_name and got_name like 'ZZ TEST %');
        insert into probe values ('it does not wear the live phone, licence or email',
            coalesce(got_phone,'-') || ' / ' || coalesce(got_lic,'-') || ' / ' || coalesce(got_email,'-'),
            coalesce(got_phone,'') is distinct from coalesce(nullif(src_phone,''),'~')
            and coalesce(got_lic,'') is distinct from coalesce(nullif(src_lic,''),'~')
            and coalesce(got_email,'') is distinct from coalesce(nullif(src_email,''),'~'));
        insert into probe values ('and the copied blob carries no identity keys', '',
            not exists (select 1 from public.company_settings s
                         where s.company_id = made
                           and (s.settings ? 'business_name' or s.settings ? 'phone'
                                or s.settings ? 'license_number' or s.settings ? 'email')));
        insert into probe values ('while the rates it was copied FOR did come across',
            (select count(*)::text from jsonb_object_keys(
                (select coalesce(settings,'{}'::jsonb) from public.company_settings where company_id = made)) k),
            (select count(*) from jsonb_object_keys(
                (select coalesce(settings,'{}'::jsonb) from public.company_settings where company_id = made)) k) > 3);
    end;

    -- It must still be unable to do the two things a sandbox must not do.
    -- The MESSAGE is checked, not merely that something threw: a NOT NULL on
    -- some other column would refuse these inserts too, and read as the
    -- sandbox guard working when it had not run at all.
    -- See memory/right-rule-wrong-reason.md.
    begin
        insert into public.mail_accounts (company_id) values (made);
        insert into probe values ('it cannot hold a mailbox', 'IT TOOK ONE', false);
    exception when others then
        insert into probe values ('it cannot hold a mailbox', sqlerrm, sqlerrm ilike '%sandbox%');
    end;
    begin
        insert into public.payment_connections (company_id) values (made);
        insert into probe values ('it cannot hold a card processor', 'IT TOOK ONE', false);
    exception when others then
        insert into probe values ('it cannot hold a card processor', sqlerrm, sqlerrm ilike '%sandbox%');
    end;

    -- And copying FROM a sandbox is refused, so two tests cannot breed.
    begin
        perform public.admin_create_test_company('From a sandbox', made);
        insert into probe values ('a sandbox source is refused', 'IT WAS ALLOWED', false);
    exception when others then
        insert into probe values ('a sandbox source is refused', sqlerrm, true);
    end;

    -- A source that does not exist is refused before anything is made.
    begin
        perform public.admin_create_test_company('Bad source',
            '00000000-0000-4000-8000-000000000000'::uuid);
        insert into probe values ('a source that does not exist is refused', 'IT WAS ALLOWED', false);
    exception when others then
        insert into probe values ('a source that does not exist is refused', sqlerrm, true);
    end;

    -- CONTROL: with no source named at all it still works, and copies nothing.
    declare bare uuid; bare_items int;
    begin
        select t.company_id into bare from public.admin_create_test_company('No catalog') as t;
        select count(*) into bare_items from public.material_items where company_id = bare;
        -- NOT zero: companies_seed_starting_catalog gives every new company a
        -- starter price list, which this probe did not know until it measured.
        -- What matters is that it is the STARTER list and not the source's.
        insert into probe values ('the copy is optional: a bare one gets the starter catalog',
            coalesce(bare_items, -1) || ' rows, source had ' || src_items,
            bare is not null and bare_items > 0 and bare_items <> src_items);
    end;
end $$;

-- The summary FIRST and the rows LAST: this CLI returns only the final
-- result set, and a bare "every_check_passed: false" with no rows under it
-- is a verdict nobody can act on.
select count(*) filter (where not ok) = 0 as every_check_passed, count(*) as checks from probe;
select ok, step, left(detail, 110) as detail from probe order by ok, ctid;

rollback;

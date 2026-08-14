-- ============================================================
-- FenceFlow -- SECURITY PATCH (run this after supabase_schema.sql)
-- Paste into: Supabase Dashboard -> SQL Editor -> New query -> Run
--
-- Fixes two real holes found by probing the live API:
--
--  1. ANYONE (not even logged in) could INSERT rows into `companies`.
--     Verified: an unauthenticated POST returned HTTP 201.
--
--  2. Any logged-in user could INSERT their own `profiles` row with an
--     arbitrary company_id AND role -- so if they learned another
--     business's id, they could make themselves its OWNER.
--
-- Both existed because signup needs to create a company/profile before the
-- user has one. The correct fix is to let ONLY the SECURITY DEFINER signup
-- functions do it (they bypass RLS by design) and forbid direct writes.
-- ============================================================

-- ---------- 1. No direct inserts into companies ----------
-- create_company_with_owner() is SECURITY DEFINER, so signup still works.
drop policy if exists companies_insert on companies;

-- ---------- 2. No direct inserts into profiles ----------
-- create_company_with_owner() / join_company() handle profile creation.
drop policy if exists profiles_self_insert on profiles;

-- ---------- 3. You cannot change your own role ----------
-- Stops a MANAGER from quietly promoting themselves to OWNER.
drop policy if exists profiles_manage on profiles;
create policy profiles_manage on profiles
    for update using (
        company_id = current_company_id()
        and current_user_role() in ('OWNER', 'MANAGER')
        and id <> auth.uid()
    );

-- ---------- 4. join_company should not let someone re-point an existing profile ----------
-- Previously an existing member could call join_company(<other company id>)
-- and move themselves into another business. Now it only creates a profile
-- for a user who does not have one yet.
create or replace function join_company(target_company_id uuid, member_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if exists (select 1 from profiles where id = auth.uid() and company_id is not null) then
        raise exception 'You already belong to a business. Ask an owner to move you.';
    end if;
    insert into profiles (id, company_id, full_name, role)
        values (auth.uid(), target_company_id, member_name, 'CREW')
    on conflict (id) do update
        set company_id = excluded.company_id,
            full_name  = excluded.full_name,
            role       = 'CREW';
end $$;

-- ---------- 5. Same guard on company creation ----------
create or replace function create_company_with_owner(company_name text, owner_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare new_company_id uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to create a business.';
    end if;
    if exists (select 1 from profiles where id = auth.uid() and company_id is not null) then
        raise exception 'You already belong to a business.';
    end if;
    insert into companies (name) values (company_name) returning id into new_company_id;
    insert into profiles (id, company_id, full_name, role)
        values (auth.uid(), new_company_id, owner_name, 'OWNER')
    on conflict (id) do update
        set company_id = excluded.company_id,
            full_name  = excluded.full_name,
            role       = 'OWNER';
    return new_company_id;
end $$;

-- ---------- 6. Clean up the two probe rows created while testing ----------
delete from companies where name in ('RLS test', 'RLS probe 2');

-- Nobody could change anybody's role, anywhere in the product.
--
-- An installer joins and says he is a Foreman. join_company records that in
-- requested_role and pins the actual role to CREW, deliberately -- letting a
-- joiner name their own role would let anyone holding a company id make
-- themselves its owner. The app tells him "Your owner confirms this before it
-- takes effect."
--
-- The owner never can. There is no RPC that sets a role, nothing in the
-- Android app that changes one, and the word requested_role does not appear
-- anywhere in the website. So every company is permanently one owner and a
-- pile of crew, and the whole permission system -- MANAGER, SALES, ACCOUNTANT,
-- FOREMAN, each with a carefully chosen set of permissions -- is unreachable.
-- For a product being sold to companies with an office manager and a
-- bookkeeper, that is the difference between usable and not.
--
-- OWNER is deliberately not settable here. Handing over ownership is a real
-- need but a different, riskier action -- it can lock the current owner out of
-- their own business -- and it deserves its own deliberate path rather than
-- being a value in a dropdown.
create or replace function public.set_member_role(member_id uuid, new_role text)
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
        raise exception 'Only the owner can change what someone is allowed to do.';
    end if;
    if member_id = auth.uid() then
        raise exception 'You cannot change your own role.';
    end if;
    if not exists (select 1 from profiles where id = member_id and company_id = caller_company) then
        raise exception 'That person is not in your business.';
    end if;
    if upper(new_role) not in ('MANAGER','CREW','SALES','ACCOUNTANT','FOREMAN') then
        raise exception 'That is not a role you can set.';
    end if;

    update profiles
       set role = upper(new_role)::user_role,
           -- The request has been answered either way, so it stops being a
           -- request. Leaving it set would keep the badge on the row for ever.
           requested_role = ''
     where id = member_id
       and company_id = caller_company;
end;
$$;
revoke execute on function public.set_member_role(uuid, text) from public, anon;
grant  execute on function public.set_member_role(uuid, text) to authenticated;

-- The owner's own list, with what each person asked to be. profiles' own read
-- policy already scopes to the company; this exists so the website can show
-- requested_role, which it has never had access to in a shape it could use.
create or replace function public.company_members()
returns table(id uuid, full_name text, role text, requested_role text, is_me boolean)
language sql security definer set search_path to 'public'
as $$
    select p.id,
           coalesce(p.full_name, ''),
           p.role::text,
           coalesce(p.requested_role, ''),
           (p.id = auth.uid())
      from profiles p
     where p.company_id = (select company_id from profiles where id = auth.uid())
     order by (p.role = 'OWNER') desc, p.full_name;
$$;
revoke execute on function public.company_members() from public, anon;
grant  execute on function public.company_members() to authenticated;

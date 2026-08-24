-- Paying turns the lights back on by itself.
--
-- Suspension was a one-way switch: a company suspended for not paying stayed
-- suspended after it paid, until somebody remembered to go and un-tick it by
-- hand. That is the worst possible moment to be slow -- they have just given
-- you money and still cannot work.
--
-- Not every suspension should lift on payment though, so a suspension now
-- records WHY. The ordinary one clears itself when money arrives; a hold is
-- for the rare case that has nothing to do with money, and only an admin
-- lifts that.
alter table public.companies
  add column if not exists suspended_reason text not null default '';

-- Anything suspended before this existed was suspended for non-payment.
update public.companies
   set suspended_reason = 'UNPAID'
 where suspended and suspended_reason = '';

create or replace function public.release_for_payment(cid uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    released boolean := false;
begin
    update companies
       set suspended = false,
           suspended_reason = ''
     where id = cid
       and suspended
       and suspended_reason is distinct from 'HOLD'
    returning true into released;
    return coalesce(released, false);
end;
$$;
grant execute on function public.release_for_payment(uuid) to service_role;

-- The admin button says which kind it is. Existing callers pass two
-- arguments and keep the old meaning: suspended for not paying, so it
-- lifts the moment they pay.
create or replace function public.admin_suspend(target uuid, note text default null,
                                                hold boolean default false)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may change company access.';
    end if;
    update companies
       set suspended = true,
           suspended_reason = case when hold then 'HOLD' else 'UNPAID' end,
           admin_notes = coalesce(note, admin_notes)
     where id = target;
end;
$$;

select
  (select count(*) from public.companies where suspended) as suspended_now,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='companies'
      and column_name='suspended_reason') as reason_column;

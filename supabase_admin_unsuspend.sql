-- Lifting a suspension deserves to be a function like placing one.
--
-- The admin page did it with a direct table update, which works but leaves
-- suspended_reason behind saying 'UNPAID' on a company that is no longer
-- suspended -- and means the one action that restores somebody's access is
-- the only one with no server-side check of its own.
create or replace function public.admin_unsuspend(target uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may change company access.';
    end if;
    update companies
       set suspended = false,
           suspended_reason = ''
     where id = target;
end;
$$;
grant execute on function public.admin_unsuspend(uuid) to authenticated;
select 'unsuspend added' as done;

-- ROLLBACK for supabase_e2_create_test_company.sql
-- The LIVE body of sandbox_refresh_from as it stood before 2026-11-21,
-- dumped with pg_get_functiondef rather than copied from r64, so this is
-- what was actually deployed and not what a file says was deployed.
-- It does NOT drop admin_create_test_company: a function nothing calls is
-- harmless, and dropping it would take the office page down with it if the
-- page half were still live. Drop that by hand if you really mean to.

CREATE OR REPLACE FUNCTION public.sandbox_refresh_from(p_source uuid, p_target uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

    insert into public.company_settings (company_id, settings, updated_at)
    select p_target, s.settings, now()
      from public.company_settings s
     where s.company_id = p_source
    on conflict (company_id) do update
        set settings = excluded.settings, updated_at = now();
    select count(*) into n_set from public.company_settings where company_id = p_target;

    return format('copied %s catalog row(s) and %s settings row(s) into the sandbox', n_items, n_set);
end;
$function$


revoke execute on function public.sandbox_refresh_from(uuid, uuid) from public, anon, authenticated;
grant  execute on function public.sandbox_refresh_from(uuid, uuid) to service_role;

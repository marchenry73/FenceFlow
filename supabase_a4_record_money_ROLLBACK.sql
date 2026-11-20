-- ROLLBACK for supabase_a4_record_money_is_a_write_permission.sql
-- The live bodies of has_permission and hold_money_columns as they stood
-- immediately BEFORE the fix was applied, 20 Nov 2026. Dumped from the live
-- database with pg_get_functiondef, not retyped.
--
-- Applying this puts both back. It does NOT drop record_money_trusted() or
-- job_received_money_columns(): leaving two unused functions behind is
-- harmless, and dropping a function other things may have come to call is
-- how this project once took every table to 401.
begin;

CREATE OR REPLACE FUNCTION public.has_permission(perm text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with me as (
    select role::text as role_text, coalesce(permission_overrides, '') as overrides
    from profiles where id = auth.uid()
  )
  select case
    when position('-' || perm in (select overrides from me)) > 0 then false
    when position('+' || perm in (select overrides from me)) > 0 then true
    else case (select role_text from me)
      when 'OWNER' then true
      when 'MANAGER' then perm in (
        'SEE_MONEY','SEE_PAY','EDIT_JOBS','EDIT_CATALOG_AND_SETTINGS','SCHEDULE_AND_ASSIGN',
        'REQUEST_PAYMENT','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT','SEE_REPORTS',
        'APPROVE_TIME','APPROVE_PLAN_CHANGES')
      when 'SALES' then perm in ('SEE_MONEY','EDIT_JOBS','SEE_CUSTOMER_CONTACT')
      when 'ACCOUNTANT' then perm in (
        'SEE_MONEY','SEE_PAY','REQUEST_PAYMENT','RECORD_REFUNDS','SEE_CUSTOMER_CONTACT','SEE_REPORTS')
      when 'FOREMAN' then perm in (
        'SCHEDULE_AND_ASSIGN','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT',
        'APPROVE_TIME','APPROVE_PLAN_CHANGES')
      when 'CREW' then perm in ('RECORD_FIELD_WORK')
      else false
    end
  end;
$function$
;

CREATE OR REPLACE FUNCTION public.hold_money_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    cols text[] := case when tg_nargs > 0 then tg_argv else public.job_money_columns() end;
begin
    if public.money_caller_trusted() then
        return new;
    end if;

    if tg_op = 'UPDATE' then
        new := jsonb_populate_record(new, (
            select jsonb_object_agg(c, to_jsonb(old) -> c) from unnest(cols) c));
    else
        new := jsonb_populate_record(new, (
            select jsonb_object_agg(ic.column_name, case
                    when ic.data_type in ('numeric', 'double precision', 'integer', 'bigint', 'real') then to_jsonb(0)
                    when ic.data_type = 'boolean' then to_jsonb(false)
                    when ic.data_type in ('text', 'character varying') then to_jsonb(''::text)
                    else 'null'::jsonb end)
              from information_schema.columns ic
             where ic.table_schema = tg_table_schema
               and ic.table_name = tg_table_name
               and ic.column_name = any(cols)));
        if tg_table_name = 'jobs' then
            new.payment_status := 'UNPAID';
            new.contract_total := null;
            -- A token a crew phone chose is a link a crew phone knows.
            new.quote_token := gen_random_uuid();
        end if;
    end if;
    return new;
end $function$
;

commit;

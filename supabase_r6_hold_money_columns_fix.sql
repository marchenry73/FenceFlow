-- ============================================================
-- FenceFlow -- the money shield no longer rejects every crew insert
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
-- KIND: FUNCTION-REPLACING (hold_money_columns, the LIVE body with one cast).
-- No row, policy or trigger changes.
--
-- hold_money_columns() zeroes money columns on rows written by callers who
-- may not see money. Its INSERT branch built the zero with to_jsonb(''): an
-- untyped literal, which Postgres cannot resolve for a polymorphic function
-- (42804), and because a CASE is planned as a whole the error fired on EVERY
-- untrusted insert through the trigger, not only on text columns. Found
-- 2026-09-21 when a crew change order could not be saved; the fix is
-- to_jsonb(''::text). Proof: a crew login inserts a change order inside a
-- rolled-back transaction -- 42804 before, saved with its money zeroed after.
-- ============================================================
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
end $function$;

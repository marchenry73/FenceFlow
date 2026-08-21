-- The first version read watched columns with a dynamic EXECUTE, which throws
-- if the column does not exist -- and pricing_tier_name does not exist on the
-- cloud jobs table. That would have broken EVERY update to jobs the moment it
-- was live: all syncing, immediately, for everyone.
--
-- Rewritten with to_jsonb, which turns the row into keys and lets a column
-- that is not there simply be skipped. No dynamic SQL, and a watch list that
-- drifts from the schema degrades to logging less rather than to breaking
-- writes.
create or replace function public.audit_changes()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    watched text[];
    col text;
    old_json jsonb;
    new_json jsonb;
    old_val text;
    new_val text;
    who uuid := auth.uid();
    who_email text;
    the_company uuid;
    the_label text;
    the_id text;
begin
    watched := case tg_table_name
        when 'jobs' then array[
            'status','payment_status','deposit_amount','amount_paid','refunded_amount',
            'labor_rate_per_ft','labor_flat_fee','markup_percent','discount_percent',
            'minimum_job_charge','tax_rate_percent'
        ]
        when 'payment_records' then array['amount','method','received_at','note']
        when 'time_entries' then array['approved_at','rejected_at','hourly_rate','started_at','ended_at']
        when 'employees' then array['hourly_rate','per_foot_rate','pay_type','is_active']
        when 'change_orders' then array['additional_cost','material_cost','signed_at']
        when 'estimate_line_items' then array['quantity','unit_price','supplier_unit_price']
        else array[]::text[]
    end;

    if tg_op = 'DELETE' then old_json := to_jsonb(old); new_json := old_json;
    else new_json := to_jsonb(new); old_json := case when tg_op = 'UPDATE' then to_jsonb(old) else new_json end;
    end if;

    the_company := (new_json ->> 'company_id')::uuid;
    the_id := coalesce(new_json ->> 'sync_id', new_json ->> 'id', '');
    the_label := coalesce(new_json ->> 'customer_name', '');
    select email into who_email from auth.users where id = who;

    if tg_op = 'INSERT' then
        insert into audit_log (company_id, actor, actor_email, table_name, record_id, action, label)
        values (the_company, who, who_email, tg_table_name, the_id, 'insert', the_label);
        return new;
    end if;

    if tg_op = 'DELETE' then
        insert into audit_log (company_id, actor, actor_email, table_name, record_id, action, label)
        values (the_company, who, who_email, tg_table_name, the_id, 'delete', the_label);
        return old;
    end if;

    foreach col in array watched loop
        -- Skip anything this table does not actually have. A watch list that
        -- drifts ahead of the schema must never break a write.
        if new_json ? col then
            old_val := old_json ->> col;
            new_val := new_json ->> col;
            -- Only real changes: a sync rewriting a row with identical values
            -- is not somebody changing a price, and logging it would drown the
            -- entries that are.
            if old_val is distinct from new_val then
                insert into audit_log (
                    company_id, actor, actor_email, table_name, record_id,
                    action, field, old_value, new_value, label
                )
                values (
                    the_company, who, who_email, tg_table_name, the_id,
                    'update', col, old_val, new_val, the_label
                );
            end if;
        end if;
    end loop;

    return new;
end;
$$;
select 'audit trigger rewritten' as done;

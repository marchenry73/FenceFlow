-- The audit log knew WHAT changed and never who, on exactly the changes that
-- matter most.
--
-- `actor` is auth.uid(), which is null for anything a server process writes:
-- a customer approving through the quote link, a Stripe or Square webhook
-- recording a payment, an edge function moving a job forward. Those are the
-- money events. Thirty-three entries were already sitting there attributed to
-- nobody, including every "status changed to ACCEPTED" and every change to
-- amount_paid and refunded_amount.
--
-- An audit trail that cannot say who is a log, not an audit trail. This does
-- not invent an actor -- there genuinely is no signed-in user -- it records
-- what actually did it, which is the honest answer and the useful one:
--
--   'customer via quote link: Ana Prueba'   an approval anyone could make
--   'payment processor'                     a webhook
--   'server'                                anything else without a user
--
-- Only actor_email changes. `actor` stays null when there is no user, because
-- writing a fake uuid there would be worse than the gap it fills.
create or replace function public.audit_changes()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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

    -- No signed-in user. Say what did it instead of leaving the column empty.
    if who_email is null then
        who_email := case
            -- An approval that just landed carries the name the customer
            -- typed. It is not proof of identity -- anyone holding the link
            -- can type a name -- and the wording says so rather than dressing
            -- it up as a verified signature.
            when tg_table_name = 'jobs'
             and coalesce(new_json ->> 'quote_approved_at', '') <> ''
             and coalesce(old_json ->> 'quote_approved_at', '') = ''
            then 'customer via quote link: ' ||
                 coalesce(nullif(new_json ->> 'quote_approved_name', ''), 'unnamed')
            when tg_table_name = 'payment_records' then 'payment processor'
            when tg_table_name = 'jobs'
             and (new_json ->> 'amount_paid') is distinct from (old_json ->> 'amount_paid')
            then 'payment processor'
            else 'server'
        end;
    end if;

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
$function$;

-- Who changed the money, and when.
--
-- The first time two people disagree about a number, this is the only thing
-- that settles it -- and it cannot be backfilled, so every day without it is
-- history permanently lost.
--
-- Written as database triggers rather than app code on purpose. The app, the
-- website and anything else all write through Postgres, so this catches every
-- route by construction. App-side logging would have to be remembered at each
-- call site, and the one that mattered would be the one somebody forgot.

create table if not exists public.audit_log (
    id           bigserial primary key,
    company_id   uuid not null,
    at           timestamptz not null default now(),
    actor        uuid,                -- who; null for a database-side change
    actor_email  text,                -- kept as text so it survives them leaving
    table_name   text not null,
    record_id    text not null,       -- text, because sync ids and uuids both appear
    action       text not null,       -- insert | update | delete
    field        text,                -- which column, on an update
    old_value    text,
    new_value    text,
    label        text                 -- what the record is, in a person's words
);

create index if not exists audit_log_company_at on public.audit_log (company_id, at desc);
create index if not exists audit_log_record on public.audit_log (table_name, record_id);

alter table public.audit_log enable row level security;

-- Readable by the company it belongs to, and only by people who can see money.
-- A trail that a crew member can read is a list of what everyone earns.
drop policy if exists audit_log_read on public.audit_log;
create policy audit_log_read on public.audit_log
    for select using (
        company_id = current_company_id()
        and (select role::text from profiles where id = auth.uid()) in ('OWNER','MANAGER','ACCOUNTANT')
    );

-- Nobody writes to it from a client. Triggers do, as the table owner. An audit
-- trail somebody can edit is not an audit trail.
revoke insert, update, delete on public.audit_log from anon, authenticated;

/**
 * Records changes to the columns worth watching.
 *
 * Only money and access, not every field. A trail that logs a customer's phone
 * number being corrected buries the one entry that mattered, and nobody reads
 * a log that is mostly noise.
 */
create or replace function public.audit_changes()
returns trigger language plpgsql security definer set search_path = public as $$
declare
    watched text[];
    col text;
    old_val text;
    new_val text;
    who uuid := auth.uid();
    who_email text;
    the_company uuid;
    the_label text;
begin
    watched := case tg_table_name
        when 'jobs' then array[
            'status','payment_status','deposit_amount','amount_paid','refunded_amount',
            'labor_rate_per_ft','labor_flat_fee','markup_percent','discount_percent',
            'minimum_job_charge','tax_rate_percent','pricing_tier_name'
        ]
        when 'payment_records' then array['amount','method','received_at','note']
        when 'time_entries' then array['approved_at','rejected_at','hourly_rate','started_at','ended_at']
        when 'employees' then array['hourly_rate','per_foot_rate','pay_type','is_active']
        when 'change_orders' then array['additional_cost','material_cost','signed_at']
        when 'estimate_line_items' then array['quantity','unit_price','supplier_unit_price']
        else array[]::text[]
    end;

    select email into who_email from auth.users where id = who;

    if tg_op = 'DELETE' then
        the_company := old.company_id;
    else
        the_company := new.company_id;
    end if;

    the_label := case tg_table_name
        when 'jobs' then coalesce(
            case when tg_op = 'DELETE' then old.customer_name else new.customer_name end, '')
        else ''
    end;

    if tg_op = 'INSERT' then
        insert into audit_log (company_id, actor, actor_email, table_name, record_id, action, label)
        values (the_company, who, who_email, tg_table_name, new.sync_id, 'insert', the_label);
        return new;
    end if;

    if tg_op = 'DELETE' then
        insert into audit_log (company_id, actor, actor_email, table_name, record_id, action, label)
        values (the_company, who, who_email, tg_table_name, old.sync_id, 'delete', the_label);
        return old;
    end if;

    foreach col in array watched loop
        execute format('select ($1).%I::text, ($2).%I::text', col, col)
            into old_val, new_val using old, new;
        -- Only real changes. A sync that rewrites a row with the same values is
        -- not somebody changing a price, and logging it would drown the ones
        -- that are.
        if old_val is distinct from new_val then
            insert into audit_log (
                company_id, actor, actor_email, table_name, record_id,
                action, field, old_value, new_value, label
            )
            values (
                the_company, who, who_email, tg_table_name, new.sync_id,
                'update', col, old_val, new_val, the_label
            );
        end if;
    end loop;

    return new;
end;
$$;

do $$
declare t text;
begin
    foreach t in array array[
        'jobs','payment_records','time_entries','employees','change_orders','estimate_line_items'
    ] loop
        execute format('drop trigger if exists %I on public.%I', t || '_audit', t);
        execute format(
            'create trigger %I after insert or update or delete on public.%I
             for each row execute function public.audit_changes()',
            t || '_audit', t
        );
    end loop;
end $$;

select count(*) as audit_triggers
from pg_trigger where tgname like '%_audit' and not tgisinternal;

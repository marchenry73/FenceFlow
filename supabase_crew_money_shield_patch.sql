-- Crew never write money, and get a door without it.
--
-- Stage one of two. Crew phones today read every column of jobs and
-- estimate_line_items and push whole rows back, because the sync was written
-- before roles existed. The base tables' policies check company membership
-- and nothing else, so the "crew" views that hide prices are cosmetic. Stage
-- two (the policy flip) needs an app on every crew phone that reads the
-- views and writes through the pens below; it waits for that app.
--
-- This stage is safe under every installed build for every role: nothing
-- here refuses a read, and every write a crew phone makes today still lands
-- -- minus the money in it. A trusted caller (a role holding SEE_MONEY, the
-- service role, or a direct connection) is untouched.
--
-- Additive and idempotent. No hard delete anywhere.

-- ------------------------------------------------------- the one list --

create or replace function public.job_money_columns()
returns text[]
language sql
immutable
as $$
    select array[
        'tax_rate_percent', 'markup_percent', 'discount_percent',
        'labor_rate_per_ft', 'labor_flat_fee', 'minimum_job_charge',
        'teardown_flat_fee', 'teardown_rate_per_ft', 'gate_rate_per_ft', 'trash_haul_fee',
        'deposit_amount', 'amount_paid', 'refunded_amount', 'refunded_at', 'refund_reason',
        'payment_status', 'is_invoiced', 'payments_from_processor',
        'contract_total', 'signed_contract_total', 'tip_amount',
        'payment_link_url', 'payment_link_amount',
        'pricing_tier_name', 'supplier_quote_reference',
        'quote_token', 'quote_sent_at', 'quote_viewed_at'
    ]
$$;

-- Who may write money. A direct connection (migrations, this file) carries
-- no claims at all; the service role says so in its claim; everyone else is
-- judged by the permission, never by "auth.uid() is null" -- that escape
-- hatch let anon through once already.
create or replace function public.money_caller_trusted()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select nullif(current_setting('request.jwt.claims', true), '') is null
        or public.is_service_role()
        or coalesce(public.has_permission('SEE_MONEY'), false)
$$;

-- ------------------------------------------------------------ the hold --
--
-- Holds, never raises. A raise would throw away the whole row -- the notes,
-- the status, the completion sign-off a crew member typed in the yard --
-- because of a money column their app sent along without meaning to. The
-- money columns are put back to what they were (UPDATE) or to nothing
-- (INSERT); the rest of the write lands.
create or replace function public.hold_money_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
                    when ic.data_type in ('text', 'character varying') then to_jsonb('')
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
end $$;

-- Named with a leading 00_ so they run BEFORE the edit-clock trigger on the
-- same table (same-event triggers fire in name order): the clock must
-- compare the row as it will be written, with the money put back.
drop trigger if exists "00_protect_job_money" on public.jobs;
create trigger "00_protect_job_money"
    before insert or update on public.jobs
    for each row execute function public.hold_money_columns();

drop trigger if exists "00_hold_line_item_prices" on public.estimate_line_items;
create trigger "00_hold_line_item_prices"
    before update on public.estimate_line_items
    for each row execute function public.hold_money_columns('unit_price', 'supplier_unit_price');

drop trigger if exists "00_hold_change_order_costs" on public.change_orders;
create trigger "00_hold_change_order_costs"
    before update on public.change_orders
    for each row execute function public.hold_money_columns('additional_cost', 'material_cost');

drop trigger if exists "00_zero_change_order_costs" on public.change_orders;
create trigger "00_zero_change_order_costs"
    before insert on public.change_orders
    for each row execute function public.hold_money_columns('additional_cost', 'material_cost');

drop trigger if exists "00_hold_material_price" on public.material_items;
create trigger "00_hold_material_price"
    before update on public.material_items
    for each row execute function public.hold_money_columns('unit_price');

-- Deliberately NOT expenses: a receipt a crew member entered is their own
-- information, and holding its amount would stop them correcting a typo on
-- their own fuel slip.

-- A line a crew phone adds gets the price the office would have given it:
-- the job's last price for that role, else the catalog's, else 0 -- never
-- whatever number the phone sent.
create or replace function public.stamp_line_item_price()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if public.money_caller_trusted() then
        return new;
    end if;
    select li.unit_price into new.unit_price
      from public.estimate_line_items li
     where li.company_id = new.company_id
       and li.job_sync_id = new.job_sync_id
       and li.sync_id <> new.sync_id
       and li.role is not distinct from new.role
       and coalesce(li.role, 'NONE') <> 'NONE'
     order by (li.deleted_at is null) desc, li.updated_at desc
     limit 1;
    if not found then
        select m.unit_price into new.unit_price
          from public.material_items m
         where m.company_id = new.company_id
           and m.deleted_at is null
           and lower(m.name) = lower(new.description)
         order by m.is_active desc
         limit 1;
    end if;
    new.unit_price := coalesce(new.unit_price, 0);
    new.supplier_unit_price := null;
    return new;
end $$;

drop trigger if exists "00_stamp_line_item_price" on public.estimate_line_items;
create trigger "00_stamp_line_item_price"
    before insert on public.estimate_line_items
    for each row execute function public.stamp_line_item_price();

-- ---------------------------------------------------- pricing tiers --
--
-- The margin formula. SEE_MONEY, deliberately not the catalog permission, so
-- a SALES or ACCOUNTANT phone on an old build keeps pushing tiers; a crew
-- phone's pull comes back empty and its push is refused, both of which the
-- app already treats as "not this phone's to sync".
drop policy if exists pricing_tiers_read on public.pricing_tiers;
create policy pricing_tiers_read on public.pricing_tiers for select
    using (company_id = public.current_company_id() and public.has_permission('SEE_MONEY'));
drop policy if exists pricing_tiers_insert on public.pricing_tiers;
create policy pricing_tiers_insert on public.pricing_tiers for insert
    with check (company_id = public.current_company_id() and public.has_permission('SEE_MONEY'));
drop policy if exists pricing_tiers_update on public.pricing_tiers;
create policy pricing_tiers_update on public.pricing_tiers for update
    using (company_id = public.current_company_id() and public.has_permission('SEE_MONEY'))
    with check (company_id = public.current_company_id() and public.has_permission('SEE_MONEY'));

-- ------------------------------------------------------- crew doors --
--
-- Generated from the catalogue, not typed: a column added to jobs tomorrow
-- appears in the door automatically, and a NEW money column is kept out by
-- adding it to job_money_columns(). Owner-run (the view owner bypasses RLS),
-- so the WHERE re-states company scope and suspension itself. Money columns
-- are absent, not null: the app decodes an absent key to its default and
-- would throw on a null.
drop view if exists public.jobs_crew_view;
drop view if exists public.jobs_crew;
drop view if exists public.estimate_line_items_crew;
drop view if exists public.change_orders_crew;
drop view if exists public.material_items_crew;
drop view if exists public.time_entries_crew;

do $$
declare
    cols text;
begin
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'jobs'
       and column_name <> all(public.job_money_columns());
    execute format('create view public.jobs_crew with (security_barrier = true) as
        select %s from public.jobs
         where company_id = public.current_company_id() and not public.company_is_suspended()', cols);

    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'estimate_line_items'
       and column_name not in ('unit_price', 'supplier_unit_price');
    execute format('create view public.estimate_line_items_crew with (security_barrier = true) as
        select %s from public.estimate_line_items
         where company_id = public.current_company_id() and not public.company_is_suspended()', cols);

    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'change_orders'
       and column_name not in ('additional_cost', 'material_cost');
    execute format('create view public.change_orders_crew with (security_barrier = true) as
        select %s from public.change_orders
         where company_id = public.current_company_id() and not public.company_is_suspended()', cols);

    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'material_items'
       and column_name not in ('unit_price');
    execute format('create view public.material_items_crew with (security_barrier = true) as
        select %s from public.material_items
         where company_id = public.current_company_id() and not public.company_is_suspended()', cols);

    select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'time_entries'
       and column_name not in ('hourly_rate');
    execute format('create view public.time_entries_crew with (security_barrier = true) as
        select %s from public.time_entries
         where company_id = public.current_company_id() and not public.company_is_suspended()', cols);
end $$;

revoke all on public.jobs_crew, public.estimate_line_items_crew, public.change_orders_crew,
              public.material_items_crew, public.time_entries_crew from public, anon;
grant select on public.jobs_crew, public.estimate_line_items_crew, public.change_orders_crew,
                public.material_items_crew, public.time_entries_crew to authenticated, service_role;

-- -------------------------------------------------------- crew pens --
--
-- The writes a crew phone will make once it stops touching the base tables:
-- update a job it can see (never insert one), and push its line items minus
-- their prices. RPCs rather than views with rules so that every base trigger
-- -- the hold, customer-identity protection, the delete gate, the edit
-- clock, the audit, the push -- runs exactly as it does for anyone else, and
-- so a refusal can carry 42501, which the app already reads as "not mine to
-- sync".
create or replace function public.crew_save_job(row_in jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    co uuid := public.current_company_id();
    drop_keys text[] := public.job_money_columns()
        || array['id', 'company_id', 'local_id', 'created_at', 'updated_at', 'deleted_at', 'deleted_by'];
    clean jsonb := coalesce(row_in, '{}'::jsonb) - drop_keys;
    cols text[];
    n int;
begin
    if auth.uid() is null or co is null then
        raise exception 'Not signed in' using errcode = '42501';
    end if;
    if public.company_is_suspended() then
        raise exception 'Company suspended' using errcode = '42501';
    end if;
    if not (public.has_permission('RECORD_FIELD_WORK') or public.has_permission('EDIT_JOBS')) then
        raise exception 'Not allowed to write jobs' using errcode = '42501';
    end if;
    if clean->>'sync_id' is null then
        raise exception 'sync_id required';
    end if;

    -- Present keys that are real, non-money columns. An omitted key leaves
    -- the column alone; a column added to jobs tomorrow is writable here
    -- without editing this function; a new MONEY column is kept out by
    -- adding it to job_money_columns().
    select array_agg(c.column_name::text order by c.ordinal_position) into cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'jobs'
       and c.column_name <> all(drop_keys)
       and c.column_name <> 'sync_id'
       and clean ? c.column_name::text;
    if cols is null then
        return true;
    end if;

    execute format(
        'update public.jobs j set (%s) = (select %s from jsonb_populate_record(j, $1) r)
          where j.company_id = $2 and j.sync_id = ($1->>''sync_id'')::uuid and j.deleted_at is null',
        (select string_agg(quote_ident(k), ', ') from unnest(cols) k),
        (select string_agg('r.' || quote_ident(k), ', ') from unnest(cols) k))
    using clean, co;
    get diagnostics n = row_count;
    return n > 0;
end $$;

create or replace function public.crew_push_line_items(rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    co uuid := public.current_company_id();
    drop_keys text[] := array['unit_price', 'supplier_unit_price', 'id', 'company_id',
                              'created_at', 'updated_at', 'deleted_at', 'deleted_by'];
    r jsonb;
    clean jsonb;
    cols text[];
    n int := 0;
begin
    if auth.uid() is null or co is null then
        raise exception 'Not signed in' using errcode = '42501';
    end if;
    if public.company_is_suspended() then
        raise exception 'Company suspended' using errcode = '42501';
    end if;
    if not (public.has_permission('RECORD_FIELD_WORK') or public.has_permission('EDIT_JOBS')) then
        raise exception 'Not allowed to write estimate lines' using errcode = '42501';
    end if;
    if rows is null or jsonb_typeof(rows) <> 'array' then
        return 0;
    end if;

    for r in select * from jsonb_array_elements(rows) loop
        clean := r - drop_keys;
        if clean->>'sync_id' is null or clean->>'job_sync_id' is null then
            continue;
        end if;
        if not exists (select 1 from public.jobs j
                        where j.company_id = co and j.sync_id = (clean->>'job_sync_id')::uuid
                          and j.deleted_at is null) then
            continue;
        end if;
        select array_agg(c.column_name::text order by c.ordinal_position) into cols
          from information_schema.columns c
         where c.table_schema = 'public' and c.table_name = 'estimate_line_items'
           and c.column_name <> all(drop_keys)
           and c.column_name <> 'company_id'
           and clean ? c.column_name::text;
        if cols is null then
            continue;
        end if;
        -- Prices are never in the column list; the stamp and hold triggers
        -- run underneath regardless.
        execute format(
            'insert into public.estimate_line_items (company_id, %s)
               select $2, %s from jsonb_populate_record(null::public.estimate_line_items, $1) r
               on conflict (company_id, sync_id) do update set %s
               where estimate_line_items.deleted_at is null',
            (select string_agg(quote_ident(k), ', ') from unnest(cols) k),
            (select string_agg('r.' || quote_ident(k), ', ') from unnest(cols) k),
            (select string_agg(quote_ident(k) || ' = excluded.' || quote_ident(k), ', ')
               from unnest(cols) k where k <> 'sync_id'))
        using clean, co;
        n := n + 1;
    end loop;
    return n;
end $$;

revoke execute on function public.crew_save_job(jsonb) from public, anon;
grant  execute on function public.crew_save_job(jsonb) to authenticated, service_role;
revoke execute on function public.crew_push_line_items(jsonb) from public, anon;
grant  execute on function public.crew_push_line_items(jsonb) to authenticated, service_role;

-- ------------------------------------------------------- sync signals --
--
-- Realtime applies the SELECT policy per subscriber, so once the flip
-- lands a crew phone stops hearing that a job changed. This table says only
-- WHICH row moved and when -- never a figure -- and everyone in the company
-- may read it.
create table if not exists public.sync_signals (
    company_id  uuid not null,
    table_name  text not null,
    sync_id     text not null,
    touched_at  timestamptz not null default now(),
    primary key (company_id, table_name, sync_id)
);
alter table public.sync_signals enable row level security;
drop policy if exists sync_signals_read on public.sync_signals;
create policy sync_signals_read on public.sync_signals for select
    using (company_id = public.current_company_id());
drop policy if exists sync_signals_not_suspended on public.sync_signals;
create policy sync_signals_not_suspended on public.sync_signals as restrictive for all
    using (not public.company_is_suspended());

create or replace function public.signal_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.sync_signals (company_id, table_name, sync_id, touched_at)
    values (new.company_id, tg_table_name, new.sync_id::text, now())
    on conflict (company_id, table_name, sync_id) do update set touched_at = now();
    return new;
end $$;

drop trigger if exists jobs_signal on public.jobs;
create trigger jobs_signal
    after insert or update on public.jobs
    for each row execute function public.signal_sync();
drop trigger if exists estimate_line_items_signal on public.estimate_line_items;
create trigger estimate_line_items_signal
    after insert or update on public.estimate_line_items
    for each row execute function public.signal_sync();

do $$
begin
    if not exists (select 1 from pg_publication_tables
                    where pubname = 'supabase_realtime' and tablename = 'sync_signals') then
        alter publication supabase_realtime add table public.sync_signals;
    end if;
end $$;

-- ------------------------------------------------------- odds and ends --

-- Recalculating totals is a money action; refusing is clearer than a no-op.
create or replace function public.recalculate_my_job_totals()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    co uuid := public.current_company_id();
    j record;
    n integer := 0;
begin
    if not public.can_see_pay() then return 0; end if;
    if co is null then return 0; end if;
    for j in select sync_id from jobs where company_id = co and deleted_at is null loop
        perform recompute_job_totals(co, j.sync_id);
        n := n + 1;
    end loop;
    return n;
end;
$$;

-- Prepared for stage two's time_entries policy: a shift is mine if the
-- employee row it names is linked to my login.
create or replace function public.is_my_shift(es text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.employees e
         where e.company_id = public.current_company_id()
           and e.sync_id::text = es
           and e.profile_id = auth.uid())
$$;
revoke execute on function public.is_my_shift(text) from public, anon;
grant  execute on function public.is_my_shift(text) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ============================================================
-- FenceFlow -- cloud tables for the rest of the app
-- Run in: SQL Editor -> New query -> Run  (safe to re-run)
--
-- Until now only `jobs` synced, so the website had nothing to show for fence
-- runs, estimates, time, expenses or the catalog. These are the remaining
-- tables.
--
-- Design note: child rows reference their job by the job's device-generated
-- `sync_id`, not by the cloud row's uuid. The phone knows the sync_id at the
-- moment it creates a record, so pushing a child never has to first look up
-- what id the server gave the parent.
-- ============================================================

-- ---------- Bring the original tables up to the same shape ----------
-- These were created before sync existed, so they lack the device-generated
-- id that sync matches on. employees also never had hourly_rate, which the
-- web dashboard was already trying to read.
alter table employees          add column if not exists sync_id uuid;
alter table employees          add column if not exists hourly_rate double precision not null default 0;
alter table employees          add column if not exists updated_at timestamptz not null default now();
alter table customers          add column if not exists sync_id uuid;
alter table customers          add column if not exists updated_at timestamptz not null default now();
alter table expenses           add column if not exists sync_id uuid;
alter table expenses           add column if not exists job_sync_id uuid;
alter table expenses           add column if not exists updated_at timestamptz not null default now();
alter table punch_list_items   add column if not exists sync_id uuid;
alter table punch_list_items   add column if not exists job_sync_id uuid;
alter table punch_list_items   add column if not exists updated_at timestamptz not null default now();

-- Backfill anything already created without one.
update employees        set sync_id = gen_random_uuid() where sync_id is null;
update customers        set sync_id = gen_random_uuid() where sync_id is null;
update expenses         set sync_id = gen_random_uuid() where sync_id is null;
update punch_list_items set sync_id = gen_random_uuid() where sync_id is null;

alter table employees        alter column sync_id set default gen_random_uuid();
alter table customers        alter column sync_id set default gen_random_uuid();
alter table expenses         alter column sync_id set default gen_random_uuid();
alter table punch_list_items alter column sync_id set default gen_random_uuid();

create unique index if not exists employees_company_sync_idx        on employees (company_id, sync_id);
create unique index if not exists customers_company_sync_idx        on customers (company_id, sync_id);
create unique index if not exists expenses_company_sync_idx         on expenses (company_id, sync_id);
create unique index if not exists punch_list_items_company_sync_idx on punch_list_items (company_id, sync_id);

-- ---------- Fence runs (the drawing itself) ----------
create table if not exists fence_runs (
    id                uuid primary key default gen_random_uuid(),
    company_id        uuid not null references companies(id) on delete cascade,
    sync_id           uuid not null,
    job_sync_id       uuid not null,
    label             text not null default '',
    fence_type        text not null default 'VINYL',
    color_or_finish   text not null default '',
    -- Encoded polyline and gate markers, exactly as the app stores them.
    points_encoded    text not null default '',
    gates_encoded     text not null default '',
    closed_loop       boolean not null default false,
    panel_width_ft    real not null default 6,
    panel_height_ft   real not null default 6,
    post_spacing_ft   real not null default 6,
    concrete_bags_per_post real not null default 1,
    updated_at        timestamptz not null default now()
);

-- ---------- Estimate line items ----------
create table if not exists estimate_line_items (
    id             uuid primary key default gen_random_uuid(),
    company_id     uuid not null references companies(id) on delete cascade,
    sync_id        uuid not null,
    job_sync_id    uuid not null,
    run_sync_id    uuid,
    sort_order     integer not null default 0,
    description    text not null default '',
    quantity       double precision not null default 0,
    unit           text not null default 'EA',
    unit_price     double precision not null default 0,
    taxable        boolean not null default true,
    role           text,
    auto_generated boolean not null default false,
    updated_at     timestamptz not null default now()
);

-- ---------- Time entries ----------
create table if not exists time_entries (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references companies(id) on delete cascade,
    sync_id       uuid not null,
    job_sync_id   uuid not null,
    employee_id   uuid,
    started_at    timestamptz not null,
    ended_at      timestamptz,
    hourly_rate   double precision not null default 0,
    notes         text not null default '',
    updated_at    timestamptz not null default now()
);

-- ---------- Change orders ----------
create table if not exists change_orders (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references companies(id) on delete cascade,
    sync_id         uuid not null,
    job_sync_id     uuid not null,
    description     text not null default '',
    additional_feet double precision not null default 0,
    additional_cost double precision not null default 0,
    signed_at       timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- ---------- Job checklists ----------
create table if not exists job_steps (
    id                     uuid primary key default gen_random_uuid(),
    company_id             uuid not null references companies(id) on delete cascade,
    sync_id                uuid not null,
    job_sync_id            uuid not null,
    kind                   text not null default 'INSTALL',
    description            text not null default '',
    checked                boolean not null default false,
    verified_with_customer boolean not null default false,
    sort_order             integer not null default 0,
    completed_at           timestamptz,
    updated_at             timestamptz not null default now()
);

-- ---------- Site markers (pool, easement, obstacles…) ----------
create table if not exists site_markers (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    sync_id     uuid not null,
    job_sync_id uuid not null,
    kind        text not null default 'OBSTACLE',
    x           real not null default 0,
    y           real not null default 0,
    label       text not null default '',
    updated_at  timestamptz not null default now()
);

-- ---------- Materials catalog ----------
create table if not exists material_items (
    id              uuid primary key default gen_random_uuid(),
    company_id      uuid not null references companies(id) on delete cascade,
    sync_id         uuid not null,
    name            text not null default '',
    category        text not null default 'MISC',
    role            text not null default 'OTHER',
    fence_type      text not null default 'UNIVERSAL',
    color_or_finish text not null default '',
    unit            text not null default 'EA',
    unit_price      double precision not null default 0,
    taxable         boolean not null default true,
    covers_ft       real,
    manufacturer_sync_id uuid,
    is_active       boolean not null default true,
    source_doc      text not null default '',
    updated_at      timestamptz not null default now()
);

-- ---------- Pricing tiers ----------
create table if not exists pricing_tiers (
    id               uuid primary key default gen_random_uuid(),
    company_id       uuid not null references companies(id) on delete cascade,
    sync_id          uuid not null,
    name             text not null default '',
    labor_rate_per_ft double precision not null default 0,
    labor_flat_fee   double precision not null default 0,
    markup_percent   double precision not null default 0,
    discount_percent double precision not null default 0,
    sort_order       integer not null default 0,
    updated_at       timestamptz not null default now()
);

-- ---------- Manufacturers / suppliers ----------
create table if not exists manufacturers (
    id         uuid primary key default gen_random_uuid(),
    company_id uuid not null references companies(id) on delete cascade,
    sync_id    uuid not null,
    name       text not null default '',
    email      text not null default '',
    phone      text not null default '',
    address    text not null default '',
    hours      text not null default '',
    notes      text not null default '',
    updated_at timestamptz not null default now()
);

-- ---------- Uniqueness, indexes, RLS, and updated_at triggers ----------
do $$
declare t text;
begin
    foreach t in array array[
        'fence_runs','estimate_line_items','time_entries','change_orders',
        'job_steps','site_markers','material_items','pricing_tiers','manufacturers'
    ]
    loop
        -- One row per record per company; this is what makes repeated pushes
        -- idempotent instead of piling up duplicates.
        execute format(
            'create unique index if not exists %I_company_sync_idx on %I (company_id, sync_id)', t, t);
        execute format(
            'create index if not exists %I_company_idx on %I (company_id)', t, t);

        execute format('alter table %I enable row level security', t);

        execute format('drop policy if exists %I_read on %I', t, t);
        execute format(
            'create policy %I_read on %I for select using (company_id = current_company_id())', t, t);

        execute format('drop policy if exists %I_insert on %I', t, t);
        execute format(
            'create policy %I_insert on %I for insert with check (company_id = current_company_id())', t, t);

        execute format('drop policy if exists %I_update on %I', t, t);
        execute format(
            'create policy %I_update on %I for update using (company_id = current_company_id())', t, t);

        execute format('drop policy if exists %I_delete on %I', t, t);
        execute format(
            'create policy %I_delete on %I for delete using (company_id = current_company_id() '
            'and current_user_role() in (''OWNER'', ''MANAGER''))', t, t);

        -- Keep updated_at honest so last-edit-wins has something to compare.
        execute format('drop trigger if exists %I_touch on %I', t, t);
        execute format(
            'create trigger %I_touch before update on %I '
            'for each row execute function touch_updated_at()', t, t);
    end loop;
end $$;

-- Job-scoped children get an index on the parent, since every query filters by it.
create index if not exists fence_runs_job_idx          on fence_runs (job_sync_id);
create index if not exists estimate_line_items_job_idx on estimate_line_items (job_sync_id);
create index if not exists time_entries_job_idx        on time_entries (job_sync_id);
create index if not exists change_orders_job_idx       on change_orders (job_sync_id);
create index if not exists job_steps_job_idx           on job_steps (job_sync_id);
create index if not exists site_markers_job_idx        on site_markers (job_sync_id);

-- Crew should not be able to read pricing. This view is what the crew-facing
-- web screens read instead of the raw table.
create or replace view estimate_line_items_crew as
select id, company_id, sync_id, job_sync_id, run_sync_id, sort_order,
       description, quantity, unit, role
from estimate_line_items
where company_id = current_company_id();

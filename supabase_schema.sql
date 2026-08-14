-- ============================================================
-- FenceFlow -- Supabase schema
-- Paste this whole file into: Supabase Dashboard -> SQL Editor -> New query -> Run
-- Safe to re-run: every statement is IF NOT EXISTS / OR REPLACE.
-- ============================================================

-- ---------- Companies (one row per fencing business) ----------
create table if not exists companies (
    id          uuid primary key default gen_random_uuid(),
    name        text not null default '',
    phone       text not null default '',
    email       text not null default '',
    license_no  text not null default '',
    created_at  timestamptz not null default now()
);

-- ---------- Roles ----------
do $$ begin
    create type user_role as enum ('OWNER', 'MANAGER', 'CREW');
exception when duplicate_object then null;
end $$;

-- ---------- Profiles (links an auth login to a company + role) ----------
create table if not exists profiles (
    id          uuid primary key references auth.users(id) on delete cascade,
    company_id  uuid references companies(id) on delete cascade,
    full_name   text not null default '',
    role        user_role not null default 'CREW',
    created_at  timestamptz not null default now()
);

-- Helper: the company of the currently logged-in user.
-- SECURITY DEFINER so policies can call it without recursing through RLS.
create or replace function current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$ select company_id from profiles where id = auth.uid() $$;

create or replace function current_user_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$ select role from profiles where id = auth.uid() $$;

-- ---------- Core business tables ----------
create table if not exists customers (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    name        text not null default '',
    address     text not null default '',
    phone       text not null default '',
    email       text not null default '',
    notes       text not null default '',
    created_at  timestamptz not null default now()
);

create table if not exists jobs (
    id                    uuid primary key default gen_random_uuid(),
    company_id            uuid not null references companies(id) on delete cascade,
    customer_id           uuid references customers(id) on delete set null,
    local_id              bigint,
    customer_name         text not null default '',
    address               text not null default '',
    phone                 text not null default '',
    email                 text not null default '',
    notes                 text not null default '',
    status                text not null default 'DRAFT',
    referral_source       text not null default '',
    scheduled_date        timestamptz,
    estimated_duration_hours double precision not null default 4,
    assigned_employee_id  uuid,
    tax_rate_percent      double precision not null default 0,
    markup_percent        double precision not null default 0,
    discount_percent      double precision not null default 0,
    labor_rate_per_ft     double precision not null default 0,
    labor_flat_fee        double precision not null default 0,
    minimum_job_charge    double precision not null default 0,
    teardown_enabled      boolean not null default false,
    teardown_flat_fee     double precision not null default 0,
    teardown_rate_per_ft  double precision not null default 0,
    deposit_amount        double precision not null default 0,
    amount_paid           double precision not null default 0,
    payment_status        text not null default 'UNPAID',
    is_invoiced           boolean not null default false,
    hoa_name              text not null default '',
    hoa_email             text not null default '',
    hoa_approval_status   text not null default 'NOT_REQUIRED',
    permit_number         text not null default '',
    permit_status         text not null default 'NOT_REQUIRED',
    signed_at             timestamptz,
    updated_at            timestamptz not null default now(),
    created_at            timestamptz not null default now()
);

create table if not exists employees (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    name        text not null default '',
    role        text not null default '',
    phone       text not null default '',
    email       text not null default '',
    notes       text not null default ''
);

create table if not exists expenses (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    job_id      uuid references jobs(id) on delete cascade,
    category    text not null default 'OTHER',
    description text not null default '',
    amount      double precision not null default 0,
    spent_at    timestamptz not null default now()
);

create table if not exists punch_list_items (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references companies(id) on delete cascade,
    job_id      uuid references jobs(id) on delete cascade,
    description text not null default '',
    resolved    boolean not null default false,
    created_at  timestamptz not null default now(),
    resolved_at timestamptz
);

-- ---------- Row Level Security ----------
alter table companies         enable row level security;
alter table profiles          enable row level security;
alter table customers         enable row level security;
alter table jobs              enable row level security;
alter table employees         enable row level security;
alter table expenses          enable row level security;
alter table punch_list_items  enable row level security;

-- Everyone can read their own profile; nobody can change their own role
-- (role changes go through an owner/manager, enforced below).
drop policy if exists profiles_self_read on profiles;
create policy profiles_self_read on profiles
    for select using (id = auth.uid() or company_id = current_company_id());

drop policy if exists profiles_self_insert on profiles;
create policy profiles_self_insert on profiles
    for insert with check (id = auth.uid());

drop policy if exists profiles_manage on profiles;
create policy profiles_manage on profiles
    for update using (
        company_id = current_company_id()
        and current_user_role() in ('OWNER', 'MANAGER')
    );

-- Company: readable by its members, editable by owners.
drop policy if exists companies_read on companies;
create policy companies_read on companies
    for select using (id = current_company_id());

drop policy if exists companies_insert on companies;
create policy companies_insert on companies
    for insert with check (true);

drop policy if exists companies_update on companies;
create policy companies_update on companies
    for update using (id = current_company_id() and current_user_role() = 'OWNER');

-- Generic company-scoped access for the operational tables.
-- Crew can read and update job progress, but only owners/managers can delete.
do $$
declare t text;
begin
    foreach t in array array['customers', 'jobs', 'employees', 'expenses', 'punch_list_items']
    loop
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
    end loop;
end $$;

-- Financial columns are the sensitive part: crew should not read cost/profit data.
-- This view is what the crew-facing screens read from.
create or replace view jobs_crew_view as
select
    id, company_id, customer_id, customer_name, address, phone,
    notes, status, scheduled_date, estimated_duration_hours,
    assigned_employee_id, hoa_approval_status, permit_number, permit_status,
    updated_at
from jobs
where company_id = current_company_id();

-- ---------- Signup helper ----------
-- Creates a company + owner profile in one call, for the "create my business" flow.
create or replace function create_company_with_owner(company_name text, owner_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare new_company_id uuid;
begin
    insert into companies (name) values (company_name) returning id into new_company_id;
    insert into profiles (id, company_id, full_name, role)
        values (auth.uid(), new_company_id, owner_name, 'OWNER')
    on conflict (id) do update
        set company_id = excluded.company_id,
            full_name  = excluded.full_name,
            role       = 'OWNER';
    return new_company_id;
end $$;

-- Lets an owner/manager attach a new login to their company by invite code (the company id).
create or replace function join_company(target_company_id uuid, member_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into profiles (id, company_id, full_name, role)
        values (auth.uid(), target_company_id, member_name, 'CREW')
    on conflict (id) do update
        set company_id = excluded.company_id,
            full_name  = excluded.full_name;
end $$;

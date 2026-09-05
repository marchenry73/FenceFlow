-- Build templates: the fence a company usually builds, as data.
--
-- Post spacing, panel height, bags of concrete per post, rail count, picket
-- width -- every new run on a phone started from constants buried in the app
-- (FenceRunListViewModel.defaultSpacingFor: wood 8, chain link 10, split rail
-- 8, panel types = panel width) and the office could not start a run at all.
-- The owner asked for "a default template for the business, and let them add
-- their own, and remember some". This is that, and it is the first piece of
-- the office being able to set a client up end to end without a phone.
--
-- A template is a SPEC, not a link. A run COPIES the template's columns at
-- creation and keeps them; editing a template later never moves a quote
-- somebody has already signed. build_template_sync_id on a run only records
-- where it came from. The spec columns carry the same names and types as
-- fence_runs on purpose, so inheritance is copy-by-name and nobody ever
-- retypes a literal 6 or 8.
--
-- FenceFlow ships ten templates (company_id NULL: readable by every company,
-- writable by none -- no insert or update policy can match a null company).
-- A company adds its own, marks one default per fence type, and every use
-- is written down so "the one you used last" can be offered first.
--
-- Additive and idempotent. Nothing is dropped; retiring a template is
-- deleted_at through the same DELETE_RECORDS gate every other table has.

-- ---------------------------------------------------------------- tables --

create table if not exists public.build_templates (
    id                        uuid primary key default gen_random_uuid(),
    sync_id                   uuid not null default gen_random_uuid(),
    company_id                uuid references public.companies(id) on delete cascade,
    name                      text not null default '',
    description               text not null default '',
    is_default                boolean not null default false,
    derived_from_sync_id      uuid,
    sort_order                integer not null default 0,
    -- spec columns: same names and types as fence_runs
    fence_type                text not null default 'VINYL',
    color_or_finish           text not null default '',
    panel_width_ft            real not null default 6,
    panel_height_ft           real not null default 6,
    post_spacing_ft           real not null default 6,
    concrete_bags_per_post    real not null default 1,
    aluminum_style            text not null default 'RACKABLE',
    wood_style                text not null default 'PRIVACY',
    wood_rail_count           integer not null default 3,
    picket_width_in           real not null default 5.5,
    picket_gap_in             real not null default 0,
    fabric_height_ft          real not null default 4,
    include_top_rail          boolean not null default true,
    include_tension_wire      boolean not null default false,
    include_barbed_wire_arms  boolean not null default false,
    include_privacy_slats     boolean not null default false,
    split_rail_count          integer not null default 2,
    -- gate defaults the wizard offers; not run columns
    gate_width_ft             real not null default 4,
    gate_mounting             text not null default 'LINE',
    updated_at                timestamptz not null default now(),
    deleted_at                timestamptz,
    deleted_by                text not null default ''
);

-- A template must be a fence the engine can take off, and on the panel types
-- the engine trusts spacing == panel width without ever checking it.
do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'build_templates_not_universal') then
        alter table public.build_templates
            add constraint build_templates_not_universal check (fence_type <> 'UNIVERSAL');
    end if;
    if not exists (select 1 from pg_constraint where conname = 'build_templates_panel_spacing') then
        alter table public.build_templates
            add constraint build_templates_panel_spacing check (
                fence_type not in ('VINYL','ALUMINUM','ORNAMENTAL_IRON')
                or post_spacing_ft = panel_width_ft);
    end if;
end $$;

create unique index if not exists build_templates_company_sync_idx
    on public.build_templates (company_id, sync_id) where company_id is not null;
create unique index if not exists build_templates_shipped_sync_idx
    on public.build_templates (sync_id) where company_id is null;
create index if not exists build_templates_company_idx
    on public.build_templates (company_id, fence_type, deleted_at);

-- Memory: every time a template starts a run. Append-only.
create table if not exists public.build_template_uses (
    id                bigserial primary key,
    company_id        uuid not null references public.companies(id) on delete cascade,
    template_sync_id  uuid not null,
    fence_type        text not null,
    run_sync_id       uuid,
    used_by           uuid not null default auth.uid(),
    used_at           timestamptz not null default now()
);
create index if not exists build_template_uses_memory_idx
    on public.build_template_uses (company_id, used_by, fence_type, used_at desc);

-- A disagreement between the two pricing engines, written down instead of
-- overwritten. Filled in by the phone release that follows this patch.
create table if not exists public.pricing_drift (
    id             uuid primary key default gen_random_uuid(),
    company_id     uuid not null references public.companies(id) on delete cascade,
    job_sync_id    uuid not null,
    office_total   numeric,
    phone_total    numeric,
    office_engine  text not null default '',
    phone_engine   text not null default '',
    detail         jsonb not null default '{}'::jsonb,
    noted_by       uuid default auth.uid(),
    noted_at       timestamptz not null default now(),
    seen_at        timestamptz
);
create index if not exists pricing_drift_company_idx
    on public.pricing_drift (company_id, seen_at, noted_at desc);

-- Provenance and wizard bookkeeping on the rows that already exist.
alter table public.fence_runs add column if not exists build_template_sync_id uuid;
alter table public.jobs
    add column if not exists build_template_sync_id uuid,
    add column if not exists wizard_step integer not null default 0,
    add column if not exists priced_by text not null default '',
    add column if not exists priced_at timestamptz,
    add column if not exists pricing_engine_version text not null default '';

comment on column public.jobs.wizard_step is
    '0 = finished or not a wizard job; 1..7 = the office wizard step to resume at.';
comment on column public.jobs.priced_by is
    'Which engine wrote contract_total last: APP (EstimateEngine.kt on a phone) or OFFICE (price-job). Empty for jobs priced before the two were told apart.';

-- ------------------------------------------------------------ edit clock --
--
-- The four new job columns are bookkeeping and must not move updated_at, or
-- the office pricing a job would make every phone lose its offline edits
-- (offline-sync-edit-clock). Same function as supabase_quiet_touch_patch.sql,
-- whole body, one list; never a second version of it.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
declare
    quiet constant text[] := array[
        'updated_at',
        -- derived from the payment ledger, or written by the webhook
        'amount_paid', 'refunded_amount', 'payment_status', 'payments_from_processor',
        -- derived from the line items by every phone
        'contract_total',
        -- a homeowner opening their link, and the office geocoding a pin
        'quote_viewed_at', 'site_lat', 'site_lon',
        -- presence, not editing
        'last_seen_at',
        -- which engine priced it, and where the office wizard is up to
        'priced_by', 'priced_at', 'pricing_engine_version', 'wizard_step'
    ];
begin
    if (to_jsonb(new) - quiet) is distinct from (to_jsonb(old) - quiet) then
        new.updated_at = now();
    else
        -- A client that sent updated_at with a bookkeeping write is
        -- overruled the same way it was when the clock only moved forward.
        new.updated_at = old.updated_at;
    end if;
    return new;
end $$;

drop trigger if exists build_templates_touch on public.build_templates;
create trigger build_templates_touch
    before update on public.build_templates
    for each row execute function public.touch_updated_at();

-- Retiring is a delete, and deletes need DELETE_RECORDS like everywhere else.
drop trigger if exists enforce_delete_permission_build_templates on public.build_templates;
create trigger enforce_delete_permission_build_templates
    before update on public.build_templates
    for each row execute function public.enforce_delete_permission();

-- ------------------------------------------------------------------- RLS --

alter table public.build_templates enable row level security;
alter table public.build_template_uses enable row level security;
alter table public.pricing_drift enable row level security;

drop policy if exists build_templates_read on public.build_templates;
create policy build_templates_read on public.build_templates for select
    using (company_id is null or company_id = public.current_company_id());
drop policy if exists build_templates_insert on public.build_templates;
create policy build_templates_insert on public.build_templates for insert
    with check (company_id = public.current_company_id()
                and public.current_user_role()::text in ('OWNER','MANAGER'));
drop policy if exists build_templates_update on public.build_templates;
create policy build_templates_update on public.build_templates for update
    using (company_id = public.current_company_id()
           and public.current_user_role()::text in ('OWNER','MANAGER'))
    with check (company_id = public.current_company_id());
drop policy if exists build_templates_not_suspended on public.build_templates;
create policy build_templates_not_suspended on public.build_templates as restrictive for all
    using (not public.company_is_suspended());
-- no delete policy: retiring is deleted_at

drop policy if exists build_template_uses_read on public.build_template_uses;
create policy build_template_uses_read on public.build_template_uses for select
    using (company_id = public.current_company_id());
drop policy if exists build_template_uses_insert on public.build_template_uses;
create policy build_template_uses_insert on public.build_template_uses for insert
    with check (company_id = public.current_company_id() and used_by = auth.uid());
drop policy if exists build_template_uses_not_suspended on public.build_template_uses;
create policy build_template_uses_not_suspended on public.build_template_uses as restrictive for all
    using (not public.company_is_suspended());

drop policy if exists pricing_drift_read on public.pricing_drift;
create policy pricing_drift_read on public.pricing_drift for select
    using (company_id = public.current_company_id()
           and public.current_user_role()::text in ('OWNER','MANAGER'));
drop policy if exists pricing_drift_insert on public.pricing_drift;
create policy pricing_drift_insert on public.pricing_drift for insert
    with check (company_id = public.current_company_id());
drop policy if exists pricing_drift_update on public.pricing_drift;
create policy pricing_drift_update on public.pricing_drift for update
    using (company_id = public.current_company_id()
           and public.current_user_role()::text in ('OWNER','MANAGER'))
    with check (company_id = public.current_company_id());
drop policy if exists pricing_drift_not_suspended on public.pricing_drift;
create policy pricing_drift_not_suspended on public.pricing_drift as restrictive for all
    using (not public.company_is_suspended());

-- ------------------------------------------------------- shipped templates --
--
-- Fixed ids, so dev and prod hold identical rows and a phone can name them.
-- The values are the phone's own defaults for each type, so a template-
-- started run prices exactly like a phone-started run of the same type.
-- A superseded shipped row gets deleted_at and a NEW id; never edited.
insert into public.build_templates
    (sync_id, company_id, name, description, sort_order, fence_type, color_or_finish,
     panel_width_ft, panel_height_ft, post_spacing_ft, concrete_bags_per_post,
     aluminum_style, wood_style, wood_rail_count, picket_width_in, picket_gap_in,
     fabric_height_ft, include_top_rail, include_tension_wire, include_barbed_wire_arms,
     include_privacy_slats, split_rail_count, gate_width_ft, gate_mounting)
values
    ('00000000-0000-4000-8000-000000000001', null, 'Vinyl privacy 6 ft', '6 ft white privacy panels on 6 ft centres', 10,
     'VINYL', 'White', 6, 6, 6, 1, 'RACKABLE', 'PRIVACY', 3, 5.5, 0, 4, true, false, false, false, 2, 4, 'LINE'),
    ('00000000-0000-4000-8000-000000000002', null, 'Vinyl privacy 6 ft, 8 ft panels', '6 ft white privacy panels on 8 ft centres', 20,
     'VINYL', 'White', 8, 6, 8, 1, 'RACKABLE', 'PRIVACY', 3, 5.5, 0, 4, true, false, false, false, 2, 4, 'LINE'),
    ('00000000-0000-4000-8000-000000000003', null, 'Wood privacy 6 ft', 'Board-on-board privacy, 3 rails, posts on 8 ft centres', 30,
     'WOOD', '', 8, 6, 8, 1, 'RACKABLE', 'PRIVACY', 3, 5.5, 0, 4, true, false, false, false, 2, 4, 'LINE'),
    ('00000000-0000-4000-8000-000000000004', null, 'Wood spaced picket 4 ft', 'Spaced pickets, 2 rails, posts on 8 ft centres', 40,
     'WOOD', '', 8, 4, 8, 1, 'RACKABLE', 'SPACED_PICKET', 2, 3.5, 2.5, 4, true, false, false, false, 2, 4, 'LINE'),
    ('00000000-0000-4000-8000-000000000005', null, 'Chain link 4 ft residential', '4 ft fabric with top rail, posts on 10 ft centres', 50,
     'CHAIN_LINK', 'Galvanized', 10, 4, 10, 1, 'RACKABLE', 'PRIVACY', 3, 5.5, 0, 4, true, false, false, false, 2, 4, 'LINE'),
    ('00000000-0000-4000-8000-000000000006', null, 'Chain link 6 ft with slats', '6 ft fabric with privacy slats and top rail', 60,
     'CHAIN_LINK', 'Galvanized', 10, 6, 10, 1, 'RACKABLE', 'PRIVACY', 3, 5.5, 0, 6, true, false, false, true, 2, 4, 'LINE'),
    ('00000000-0000-4000-8000-000000000007', null, 'Aluminum 4 ft pool', 'Rackable black aluminum, 6 ft panels', 70,
     'ALUMINUM', 'Black', 6, 4, 6, 1, 'RACKABLE', 'PRIVACY', 3, 5.5, 0, 4, true, false, false, false, 2, 4, 'LINE'),
    ('00000000-0000-4000-8000-000000000008', null, 'Ornamental iron 6 ft', 'Black iron, 8 ft panels', 80,
     'ORNAMENTAL_IRON', 'Black', 8, 6, 8, 1, 'RACKABLE', 'PRIVACY', 3, 5.5, 0, 4, true, false, false, false, 2, 4, 'LINE'),
    ('00000000-0000-4000-8000-000000000009', null, 'Split rail 2-rail', 'Two-rail split rail, posts on 8 ft centres', 90,
     'SPLIT_RAIL', '', 8, 4, 8, 1, 'RACKABLE', 'PRIVACY', 3, 5.5, 0, 4, true, false, false, false, 2, 4, 'LINE'),
    ('00000000-0000-4000-8000-000000000010', null, 'Composite privacy 6 ft', 'Composite boards, 3 rails, posts on 8 ft centres', 100,
     'COMPOSITE', '', 8, 6, 8, 1, 'RACKABLE', 'PRIVACY', 3, 5.5, 0, 4, true, false, false, false, 2, 4, 'LINE')
on conflict (sync_id) where company_id is null do nothing;

-- ------------------------------------------------------------------ RPCs --
--
-- All SECURITY DEFINER with search_path pinned, executable by authenticated
-- and service_role only. They exist so the office and the phone never
-- retype the list of spec columns: one copy, here.

-- Every template this company may use, shipped and own, with the memory
-- the picker wants: when I last used it, when anyone here last used it.
create or replace function public.my_build_templates()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(jsonb_agg(
        to_jsonb(t) || jsonb_build_object(
            'is_shipped', t.company_id is null,
            'my_last_used_at',
                (select max(u.used_at) from build_template_uses u
                  where u.company_id = current_company_id()
                    and u.template_sync_id = t.sync_id and u.used_by = auth.uid()),
            'company_last_used_at',
                (select max(u.used_at) from build_template_uses u
                  where u.company_id = current_company_id() and u.template_sync_id = t.sync_id),
            'use_count',
                (select count(*) from build_template_uses u
                  where u.company_id = current_company_id() and u.template_sync_id = t.sync_id)
        )
        order by (t.company_id is null), t.fence_type, t.sort_order, t.name
    ), '[]'::jsonb)
    from build_templates t
    where t.deleted_at is null
      and (t.company_id is null or t.company_id = current_company_id());
$$;

-- Save (create or replace) one of the company's own templates. The office
-- sends every spec field each time; anything it leaves out takes the
-- table default, which is also what a phone-started run would have used.
create or replace function public.save_build_template(p jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    co uuid := current_company_id();
    sid uuid := coalesce(nullif(p->>'sync_id','')::uuid, gen_random_uuid());
    ft text := coalesce(nullif(p->>'fence_type',''), 'VINYL');
    pw real := coalesce((p->>'panel_width_ft')::real, 6);
    ps real := coalesce((p->>'post_spacing_ft')::real, 6);
    make_default boolean := coalesce((p->>'is_default')::boolean, false);
begin
    if auth.uid() is null or co is null then
        raise exception 'Not signed in' using errcode = '42501';
    end if;
    if current_user_role()::text not in ('OWNER','MANAGER') then
        raise exception 'Office roles only' using errcode = '42501';
    end if;
    if ft = 'UNIVERSAL' then
        raise exception 'A template must be a fence the engine can take off';
    end if;
    -- The engine trusts spacing == panel width on panel types and never
    -- checks it; the template makes it true rather than hoping.
    if ft in ('VINYL','ALUMINUM','ORNAMENTAL_IRON') then ps := pw; end if;

    insert into build_templates
        (sync_id, company_id, name, description, is_default, derived_from_sync_id, sort_order,
         fence_type, color_or_finish, panel_width_ft, panel_height_ft, post_spacing_ft,
         concrete_bags_per_post, aluminum_style, wood_style, wood_rail_count, picket_width_in,
         picket_gap_in, fabric_height_ft, include_top_rail, include_tension_wire,
         include_barbed_wire_arms, include_privacy_slats, split_rail_count, gate_width_ft, gate_mounting)
    values
        (sid, co,
         coalesce(p->>'name', ''),
         coalesce(p->>'description', ''),
         make_default,
         nullif(p->>'derived_from_sync_id','')::uuid,
         coalesce((p->>'sort_order')::integer, 0),
         ft,
         coalesce(p->>'color_or_finish', ''),
         pw,
         coalesce((p->>'panel_height_ft')::real, 6),
         ps,
         coalesce((p->>'concrete_bags_per_post')::real, 1),
         coalesce(nullif(p->>'aluminum_style',''), 'RACKABLE'),
         coalesce(nullif(p->>'wood_style',''), 'PRIVACY'),
         coalesce((p->>'wood_rail_count')::integer, 3),
         coalesce((p->>'picket_width_in')::real, 5.5),
         coalesce((p->>'picket_gap_in')::real, 0),
         coalesce((p->>'fabric_height_ft')::real, 4),
         coalesce((p->>'include_top_rail')::boolean, true),
         coalesce((p->>'include_tension_wire')::boolean, false),
         coalesce((p->>'include_barbed_wire_arms')::boolean, false),
         coalesce((p->>'include_privacy_slats')::boolean, false),
         coalesce((p->>'split_rail_count')::integer, 2),
         coalesce((p->>'gate_width_ft')::real, 4),
         coalesce(nullif(p->>'gate_mounting',''), 'LINE'))
    on conflict (company_id, sync_id) where company_id is not null do update set
        name = excluded.name, description = excluded.description,
        is_default = excluded.is_default, derived_from_sync_id = excluded.derived_from_sync_id,
        sort_order = excluded.sort_order, fence_type = excluded.fence_type,
        color_or_finish = excluded.color_or_finish, panel_width_ft = excluded.panel_width_ft,
        panel_height_ft = excluded.panel_height_ft, post_spacing_ft = excluded.post_spacing_ft,
        concrete_bags_per_post = excluded.concrete_bags_per_post,
        aluminum_style = excluded.aluminum_style, wood_style = excluded.wood_style,
        wood_rail_count = excluded.wood_rail_count, picket_width_in = excluded.picket_width_in,
        picket_gap_in = excluded.picket_gap_in, fabric_height_ft = excluded.fabric_height_ft,
        include_top_rail = excluded.include_top_rail, include_tension_wire = excluded.include_tension_wire,
        include_barbed_wire_arms = excluded.include_barbed_wire_arms,
        include_privacy_slats = excluded.include_privacy_slats,
        split_rail_count = excluded.split_rail_count, gate_width_ft = excluded.gate_width_ft,
        gate_mounting = excluded.gate_mounting,
        deleted_at = null, deleted_by = '';

    -- One default per fence type per company.
    if make_default then
        update build_templates set is_default = false
         where company_id = co and fence_type = ft and sync_id <> sid and is_default;
    end if;
    return sid;
end $$;

-- Retire one of the company's own templates. Runs that came from it are
-- untouched: they copied the spec. The delete gate on the table applies.
create or replace function public.retire_build_template(p_sync_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
    co uuid := current_company_id();
    n integer;
begin
    if auth.uid() is null or co is null then
        raise exception 'Not signed in' using errcode = '42501';
    end if;
    if current_user_role()::text not in ('OWNER','MANAGER') then
        raise exception 'Office roles only' using errcode = '42501';
    end if;
    update build_templates
       set deleted_at = now(), deleted_by = auth.uid()::text, is_default = false
     where company_id = co and sync_id = p_sync_id and deleted_at is null;
    get diagnostics n = row_count;
    return n > 0;
end $$;

-- Start a fence run on a job from a template. The spec is COPIED onto the
-- run; overrides (label, footage, points, gates, or any spec column) win
-- over the template. Returns the new run's sync_id. Explicit column list on
-- purpose: fence_runs has NOT NULL columns with defaults, and populating a
-- record from JSON would write nulls into them.
create or replace function public.create_run_from_template(
    p_job_sync_id uuid,
    p_template_sync_id uuid,
    p_overrides jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    co uuid := current_company_id();
    t build_templates;
    o jsonb := coalesce(p_overrides, '{}'::jsonb);
    sid uuid := coalesce(nullif(o->>'sync_id','')::uuid, gen_random_uuid());
    ft text;
    pw real;
    ps real;
begin
    if auth.uid() is null or co is null then
        raise exception 'Not signed in' using errcode = '42501';
    end if;
    if current_user_role()::text not in ('OWNER','MANAGER') then
        raise exception 'Office roles only' using errcode = '42501';
    end if;
    if company_is_suspended() then
        raise exception 'Company suspended' using errcode = '42501';
    end if;
    select * into t from build_templates
     where sync_id = p_template_sync_id and deleted_at is null
       and (company_id is null or company_id = co);
    if not found then
        raise exception 'Template not found';
    end if;
    if not exists (select 1 from jobs where company_id = co and sync_id = p_job_sync_id and deleted_at is null) then
        raise exception 'Job not found';
    end if;

    ft := coalesce(nullif(o->>'fence_type',''), t.fence_type);
    pw := coalesce((o->>'panel_width_ft')::real, t.panel_width_ft);
    ps := coalesce((o->>'post_spacing_ft')::real, t.post_spacing_ft);
    if ft in ('VINYL','ALUMINUM','ORNAMENTAL_IRON') then ps := pw; end if;

    insert into fence_runs
        (sync_id, company_id, job_sync_id, label, fence_type, color_or_finish,
         points_encoded, gates_encoded, closed_loop, manual_linear_feet, manual_corner_count,
         panel_width_ft, panel_height_ft, post_spacing_ft, concrete_bags_per_post,
         aluminum_style, wood_style, wood_rail_count, picket_width_in, picket_gap_in,
         fabric_height_ft, include_top_rail, include_tension_wire, include_barbed_wire_arms,
         include_privacy_slats, split_rail_count, suppressed_roles, is_teardown, sort_order,
         build_template_sync_id)
    values
        (sid, co, p_job_sync_id,
         coalesce(nullif(o->>'label',''), t.name),
         ft,
         coalesce(o->>'color_or_finish', t.color_or_finish),
         coalesce(o->>'points_encoded', ''),
         coalesce(o->>'gates_encoded', ''),
         coalesce((o->>'closed_loop')::boolean, false),
         (o->>'manual_linear_feet')::double precision,
         coalesce((o->>'manual_corner_count')::integer, 0),
         pw,
         coalesce((o->>'panel_height_ft')::real, t.panel_height_ft),
         ps,
         coalesce((o->>'concrete_bags_per_post')::real, t.concrete_bags_per_post),
         coalesce(nullif(o->>'aluminum_style',''), t.aluminum_style),
         coalesce(nullif(o->>'wood_style',''), t.wood_style),
         coalesce((o->>'wood_rail_count')::integer, t.wood_rail_count),
         coalesce((o->>'picket_width_in')::real, t.picket_width_in),
         coalesce((o->>'picket_gap_in')::real, t.picket_gap_in),
         coalesce((o->>'fabric_height_ft')::real, t.fabric_height_ft),
         coalesce((o->>'include_top_rail')::boolean, t.include_top_rail),
         coalesce((o->>'include_tension_wire')::boolean, t.include_tension_wire),
         coalesce((o->>'include_barbed_wire_arms')::boolean, t.include_barbed_wire_arms),
         coalesce((o->>'include_privacy_slats')::boolean, t.include_privacy_slats),
         coalesce((o->>'split_rail_count')::integer, t.split_rail_count),
         coalesce(o->>'suppressed_roles', ''),
         coalesce((o->>'is_teardown')::boolean, false),
         coalesce((o->>'sort_order')::integer,
                  (select coalesce(max(sort_order), -1) + 1 from fence_runs
                    where company_id = co and job_sync_id = p_job_sync_id)),
         t.sync_id);

    -- The memory.
    insert into build_template_uses (company_id, template_sync_id, fence_type, run_sync_id, used_by)
    values (co, t.sync_id, ft, sid, auth.uid());

    return sid;
end $$;

revoke execute on function public.my_build_templates() from public, anon;
grant  execute on function public.my_build_templates() to authenticated, service_role;
revoke execute on function public.save_build_template(jsonb) from public, anon;
grant  execute on function public.save_build_template(jsonb) to authenticated, service_role;
revoke execute on function public.retire_build_template(uuid) from public, anon;
grant  execute on function public.retire_build_template(uuid) to authenticated, service_role;
revoke execute on function public.create_run_from_template(uuid, uuid, jsonb) from public, anon;
grant  execute on function public.create_run_from_template(uuid, uuid, jsonb) to authenticated, service_role;

notify pgrst, 'reload schema';

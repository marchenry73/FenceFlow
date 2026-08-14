-- ============================================================
-- FenceFlow -- company settings in the cloud
-- Run in: SQL Editor -> New query -> Run
--
-- Business settings (pricing defaults, templates, company details) belong to
-- the COMPANY, not the phone. Storing them here means reinstalling the app,
-- switching phones, or adding a crew member no longer loses them.
--
-- Stored as JSON rather than one column per setting so adding a new setting
-- later doesn't require another migration on everyone's database.
-- ============================================================

create table if not exists company_settings (
    company_id  uuid primary key references companies(id) on delete cascade,
    settings    jsonb not null default '{}'::jsonb,
    updated_at  timestamptz not null default now()
);

alter table company_settings enable row level security;

-- Anyone in the company can read the settings -- crews need the pricing
-- defaults and templates to work offline.
drop policy if exists company_settings_read on company_settings;
create policy company_settings_read on company_settings
    for select using (company_id = current_company_id());

-- Only owners and managers can change them. A crew member shouldn't be able
-- to quietly rewrite the company's markup.
drop policy if exists company_settings_write on company_settings;
create policy company_settings_write on company_settings
    for insert with check (
        company_id = current_company_id()
        and current_user_role() in ('OWNER', 'MANAGER')
    );

drop policy if exists company_settings_update on company_settings;
create policy company_settings_update on company_settings
    for update using (
        company_id = current_company_id()
        and current_user_role() in ('OWNER', 'MANAGER')
    );

-- Saves the caller's company settings, creating the row on first save.
create or replace function save_company_settings(new_settings jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare target uuid;
begin
    target := current_company_id();
    if target is null then
        raise exception 'You are not part of a business yet.';
    end if;
    if current_user_role() not in ('OWNER', 'MANAGER') then
        raise exception 'Only owners and managers can change business settings.';
    end if;

    insert into company_settings (company_id, settings, updated_at)
        values (target, new_settings, now())
    on conflict (company_id) do update
        set settings = excluded.settings,
            updated_at = now();
end $$;

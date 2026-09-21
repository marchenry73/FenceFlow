-- The office's attention alerts and the 4 legacy automation rules only
-- evaluate while a dashboard tab is open (AUDIT_2026-09-18_PHASE1.md P1
-- "Automation" cluster; scratchpad/audit3/automation.md's mechanism finding).
-- A permit gap, an unassigned scheduled job, or a chargeback reaches nobody
-- overnight if no browser has the tab open. This is the settings half of the
-- server-side sweep that closes that gap -- OFF by default per company,
-- same "no row = never turned on" shape as automation_rules
-- (supabase_automation.sql) and follow_up_settings.
--
-- One row per company, not per user: whether the sweep runs at all for a
-- company is an owner/manager decision (gated by EDIT_CATALOG_AND_SETTINGS,
-- the same permission that already gates the Automation tab and catalog
-- edits), same as automation_rules. WHO on that company's team gets
-- notified is a *per-person* question already answered by the existing
-- notification_prefs.muted_alerts table -- this file does not duplicate
-- that, the attention-sweep function reads it directly.
--
-- quiet_hours_start/end/timezone mirror follow_up_settings' shape exactly
-- (supabase_followups_settings.sql) rather than inventing a second notion of
-- "quiet hours" -- reused via approximateUtcOffsetHours()/isQuietHour() in
-- supabase/functions/_shared/follow-up-logic.ts, which take a plain UTC
-- offset and don't care whether the settings row they're fed came from
-- follow_up_settings or this table. There is no PER-PERSON quiet-hours
-- field anywhere in this codebase (only follow_up_settings' per-company one
-- for customer email) -- company-level is what's reused here rather than
-- inventing a per-person one from nothing; see docs/ATTENTION_SWEEP.md for
-- the open question this leaves.
create table if not exists public.attention_sweep_settings (
    company_id         uuid primary key references public.companies(id) on delete cascade,
    enabled            boolean not null default false,
    quiet_hours_start  smallint not null default 21 check (quiet_hours_start between 0 and 23),
    quiet_hours_end    smallint not null default 8  check (quiet_hours_end between 0 and 23),
    timezone           text not null default 'America/New_York',
    updated_at         timestamptz not null default now(),
    updated_by         uuid references public.profiles(id)
);

alter table public.attention_sweep_settings enable row level security;

drop policy if exists attention_sweep_settings_read on public.attention_sweep_settings;
create policy attention_sweep_settings_read on public.attention_sweep_settings
    for select using (company_id = public.current_company_id());

-- No insert/update/delete policy for direct client writes -- same reasoning
-- as automation_rules: the only way to flip this on is the SECURITY DEFINER
-- function below, which checks EDIT_CATALOG_AND_SETTINGS.

create or replace function public.set_attention_sweep_enabled(
    p_enabled boolean,
    p_quiet_hours_start smallint default null,
    p_quiet_hours_end   smallint default null,
    p_timezone          text default null
)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
    co uuid := public.current_company_id();
begin
    if co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if not coalesce(public.has_permission('EDIT_CATALOG_AND_SETTINGS'), false) then
        raise exception 'You cannot change the attention sweep setting.' using errcode = '42501';
    end if;
    if p_quiet_hours_start is not null and (p_quiet_hours_start < 0 or p_quiet_hours_start > 23) then
        raise exception 'quiet_hours_start must be 0-23.' using errcode = '22023';
    end if;
    if p_quiet_hours_end is not null and (p_quiet_hours_end < 0 or p_quiet_hours_end > 23) then
        raise exception 'quiet_hours_end must be 0-23.' using errcode = '22023';
    end if;

    insert into public.attention_sweep_settings
        (company_id, enabled, quiet_hours_start, quiet_hours_end, timezone, updated_at, updated_by)
    values (
        co, p_enabled,
        coalesce(p_quiet_hours_start, 21),
        coalesce(p_quiet_hours_end, 8),
        coalesce(p_timezone, 'America/New_York'),
        now(), auth.uid()
    )
    on conflict (company_id) do update
        set enabled = excluded.enabled,
            quiet_hours_start = coalesce(p_quiet_hours_start, public.attention_sweep_settings.quiet_hours_start),
            quiet_hours_end   = coalesce(p_quiet_hours_end,   public.attention_sweep_settings.quiet_hours_end),
            timezone          = coalesce(p_timezone,          public.attention_sweep_settings.timezone),
            updated_at = now(), updated_by = auth.uid();
end;
$$;

revoke execute on function public.set_attention_sweep_enabled(boolean, smallint, smallint, text) from public, anon;
grant  execute on function public.set_attention_sweep_enabled(boolean, smallint, smallint, text) to authenticated;

comment on table public.attention_sweep_settings is
  'Per-company on/off switch (and quiet hours) for the server-side attention sweep (supabase/functions/attention-sweep). Off by default, no row means off.';

select 'attention sweep settings installed' as done;

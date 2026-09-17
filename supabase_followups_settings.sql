-- Configurable sales follow-up automation -- settings + opt-out.
--
-- Server side only. The office UI comes later; this makes the settings
-- data-driven (one row per company, read by any future UI the same way
-- automation_rules already is) rather than hardcoding delays in the
-- edge function.
--
-- Everything defaults OFF. A company that has never opened a settings
-- screen for this gets zero follow-up emails, same convention as
-- automation_rules ("no row, or enabled=false, means off").
--
-- Purely additive: two new tables, one nullable column, no DROP, no ALTER
-- of an existing column's type or default, no existing policy replaced.

-- ---------------------------------------------------------------------------
-- follow_up_settings -- one row per company
-- ---------------------------------------------------------------------------
create table if not exists public.follow_up_settings (
    company_id uuid primary key references public.companies(id) on delete cascade,

    -- Global kill switch. Checked first, before any per-kind flag, so
    -- turning this off is always enough to silence everything regardless
    -- of what else is configured.
    enabled boolean not null default false,

    -- Per-kind on/off. Each corresponds to one row shape send-follow-ups
    -- can fire (see the CHECK on follow_up_log.kind for the fixed catalog).
    new_lead_not_contacted_enabled   boolean not null default false,
    quote_sent_no_view_enabled       boolean not null default false,
    quote_viewed_not_approved_enabled boolean not null default false,
    approved_no_deposit_enabled      boolean not null default false,

    -- Delays. Hours for the lead-response one (speed-to-lead is measured
    -- in hours, not days -- see competitive research: "speed-to-lead is
    -- the #1 driver of close rate"); days for the rest, which track a
    -- quote/deposit lifecycle that reasonably runs multiple days.
    new_lead_not_contacted_hours     integer not null default 4,
    quote_sent_no_view_days          integer not null default 2,
    quote_viewed_not_approved_days   integer not null default 3,
    approved_no_deposit_days         integer not null default 2,

    -- Quiet hours in the company's own local clock. A follow-up whose local
    -- send time would fall inside [quiet_hours_start, quiet_hours_end) is
    -- held, not dropped -- send-follow-ups re-evaluates it on the next run.
    -- Wraps midnight when start > end (e.g. 21:00-08:00).
    quiet_hours_start smallint not null default 21 check (quiet_hours_start between 0 and 23),
    quiet_hours_end   smallint not null default 8  check (quiet_hours_end   between 0 and 23),
    timezone text not null default 'America/New_York',

    -- Hard daily cap, company-wide, across every kind combined. Cheap
    -- insurance against a bug (or a bulk status change) turning "a few
    -- nudges" into "every customer gets emailed at once".
    daily_cap integer not null default 25 check (daily_cap > 0),

    updated_at timestamptz not null default now(),
    updated_by uuid references public.profiles(id)
);

alter table public.follow_up_settings enable row level security;

drop policy if exists follow_up_settings_read on public.follow_up_settings;
create policy follow_up_settings_read on public.follow_up_settings
    for select using (company_id = public.current_company_id());

-- No client insert/update/delete policy. The office UI (built later) will
-- go through a SECURITY DEFINER function the same shape as
-- set_automation_rule_enabled(), gated by EDIT_CATALOG_AND_SETTINGS -- not
-- added here because this pass is server-side scaffolding only, but the
-- table is already shaped for it (a company can safely have zero rows,
-- read the same way automation_rules is read).
create or replace function public.set_follow_up_settings(p jsonb)
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
        raise exception 'You cannot change follow-up settings.' using errcode = '42501';
    end if;

    insert into public.follow_up_settings (
        company_id, enabled,
        new_lead_not_contacted_enabled, quote_sent_no_view_enabled,
        quote_viewed_not_approved_enabled, approved_no_deposit_enabled,
        new_lead_not_contacted_hours, quote_sent_no_view_days,
        quote_viewed_not_approved_days, approved_no_deposit_days,
        quiet_hours_start, quiet_hours_end, timezone, daily_cap,
        updated_at, updated_by
    )
    values (
        co, coalesce((p->>'enabled')::boolean, false),
        coalesce((p->>'new_lead_not_contacted_enabled')::boolean, false),
        coalesce((p->>'quote_sent_no_view_enabled')::boolean, false),
        coalesce((p->>'quote_viewed_not_approved_enabled')::boolean, false),
        coalesce((p->>'approved_no_deposit_enabled')::boolean, false),
        coalesce((p->>'new_lead_not_contacted_hours')::integer, 4),
        coalesce((p->>'quote_sent_no_view_days')::integer, 2),
        coalesce((p->>'quote_viewed_not_approved_days')::integer, 3),
        coalesce((p->>'approved_no_deposit_days')::integer, 2),
        coalesce((p->>'quiet_hours_start')::smallint, 21),
        coalesce((p->>'quiet_hours_end')::smallint, 8),
        coalesce(p->>'timezone', 'America/New_York'),
        coalesce((p->>'daily_cap')::integer, 25),
        now(), auth.uid()
    )
    on conflict (company_id) do update set
        enabled = excluded.enabled,
        new_lead_not_contacted_enabled = excluded.new_lead_not_contacted_enabled,
        quote_sent_no_view_enabled = excluded.quote_sent_no_view_enabled,
        quote_viewed_not_approved_enabled = excluded.quote_viewed_not_approved_enabled,
        approved_no_deposit_enabled = excluded.approved_no_deposit_enabled,
        new_lead_not_contacted_hours = excluded.new_lead_not_contacted_hours,
        quote_sent_no_view_days = excluded.quote_sent_no_view_days,
        quote_viewed_not_approved_days = excluded.quote_viewed_not_approved_days,
        approved_no_deposit_days = excluded.approved_no_deposit_days,
        quiet_hours_start = excluded.quiet_hours_start,
        quiet_hours_end = excluded.quiet_hours_end,
        timezone = excluded.timezone,
        daily_cap = excluded.daily_cap,
        updated_at = now(), updated_by = auth.uid();
end;
$$;

revoke execute on function public.set_follow_up_settings(jsonb) from public, anon;
grant  execute on function public.set_follow_up_settings(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Customer opt-out.
--
-- Checked first: neither jobs nor customers has an existing unsubscribe or
-- contact-preference column (grepped supabase_schema.sql and every patch
-- touching either table -- none found). Adding a plain nullable timestamp
-- on jobs, where the customer's email/phone for THIS job already lives, so
-- a lookup needs no join. Not on customers, because a customer row is
-- reused across jobs (customer_id nullable, and customer_name/email/phone
-- are copied onto jobs directly per supabase_schema.sql) and an opt-out is
-- a per-conversation signal a homeowner would reasonably expect to be
-- "stop emailing me about THIS job", not silently applied company-wide to
-- every job that customer ever has.
alter table public.jobs
  add column if not exists opted_out_at timestamptz;

comment on column public.jobs.opted_out_at is
  'Set when this job''s customer has asked not to be emailed further sales follow-ups. send-follow-ups must never message a job with this set. Nullable, never auto-cleared.';

-- Bookkeeping, not an edit: same reasoning as quote_viewed_at in
-- supabase_quiet_quote_gate_columns.sql -- a customer opting out (or the
-- follow-up log being written) must not move jobs.updated_at and beat a
-- real field edit on the next offline sync.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $function$
declare
    quiet constant text[] := array[
        'updated_at',
        'amount_paid', 'refunded_amount', 'payment_status', 'payments_from_processor',
        'contract_total',
        'quote_viewed_at', 'site_lat', 'site_lon',
        'last_seen_at',
        'priced_by', 'priced_at', 'pricing_engine_version', 'wizard_step',
        'quote_phone_attempts', 'quote_phone_locked_until',
        'quote_approved_without_phone_check',
        'opted_out_at'
    ];
begin
    if (to_jsonb(new) - quiet) is distinct from (to_jsonb(old) - quiet) then
        new.updated_at = now();
    else
        new.updated_at = old.updated_at;
    end if;
    return new;
end $function$;

select 'follow-up settings + opt-out installed' as done;

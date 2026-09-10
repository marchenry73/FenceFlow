-- One place where an event moves a job forward instead of a person retyping
-- (launch audit §27).
--
-- The office console already DETECTS a handful of things: a quote gone
-- quiet, an approved job with no deposit, a job scheduled soon with no
-- materials, materials that just arrived. Every one of those today ends in
-- a person reading a list on the dashboard and doing something by hand.
-- This adds the part that acts, for exactly those same conditions -- it
-- does not invent a second notion of "gone quiet" or "no deposit", the
-- dashboard's JS re-uses the identical predicates the existing detectors
-- already compute (see AUTOMATION_RULE_DEFS in website/dashboard.html).
--
-- A fixed catalog of four rules on purpose, not a free-form condition
-- builder: every action here is one that can genuinely happen with what
-- this system already has --
--   * move a sold job's production stage forward (the same move the
--     Production board itself makes, through the same set_production_stage
--     function that already exists)
--   * append a timestamped note to the job
--   * raise a flag the office can see and clear
-- Nothing here sends an email or a text -- there is no mail key configured
-- on this system, and a rule that silently fails to send would be worse
-- than no rule. Nothing here changes a price, a deposit, or an amount paid.
-- Nothing here deletes anything.
--
-- Three pieces:
--   automation_rules   -- one row per (company, rule), enabled or not.
--                          Every rule starts disabled: a fresh company (or a
--                          company that has never touched this screen) has
--                          no row, and no row means off, exactly like
--                          notification_prefs already does for alert mutes.
--   automation_runs    -- append-only. What fired, on which job, when, and
--                          what it did. A unique constraint on
--                          (company_id, rule_key, job_sync_id) is what makes
--                          a rule safe to run twice: the same job crossing
--                          the same line a second time cannot insert a
--                          second row, so run_automation_rule() below treats
--                          "insert refused by the constraint" as "already
--                          fired, do nothing" rather than as an error.
--   automation_flags   -- the visible flag one of the rules can raise. Open
--                          until an office user clears it; clearing only
--                          records that it was seen, it does not touch the
--                          job.
--
-- Purely additive: three new tables, three new functions, no DROP, no ALTER
-- of an existing column, no existing policy replaced.

-- ---------------------------------------------------------------------------
-- automation_rules
-- ---------------------------------------------------------------------------
create table if not exists public.automation_rules (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references public.companies(id) on delete cascade,
    -- The fixed catalog. Anything else is refused by the check constraint
    -- below AND by run_automation_rule()'s own case statement -- there is no
    -- rule this table can name that the function does not know how to run.
    rule_key    text not null check (rule_key in (
                    'materials_received_advance_stage',
                    'quote_gone_quiet_note',
                    'approved_no_deposit_flag',
                    'materials_missing_scheduled_flag'
                )),
    -- Off by default. A brand-new company, or one that has never opened the
    -- Automation tab, has no row here at all -- read as "never turned on",
    -- not as "on with no row yet".
    enabled     boolean not null default false,
    updated_at  timestamptz not null default now(),
    updated_by  uuid references public.profiles(id),
    unique (company_id, rule_key)
);

alter table public.automation_rules enable row level security;

drop policy if exists automation_rules_read on public.automation_rules;
create policy automation_rules_read on public.automation_rules
    for select using (company_id = public.current_company_id());

-- No insert/update/delete policy for direct client writes. The only way to
-- flip a rule on or off is set_automation_rule_enabled() below, which is
-- SECURITY DEFINER and checks EDIT_CATALOG_AND_SETTINGS -- the same
-- permission that already gates catalog and settings changes elsewhere on
-- this page.

-- ---------------------------------------------------------------------------
-- automation_runs -- the record of what fired, and the double-fire guard
-- ---------------------------------------------------------------------------
create table if not exists public.automation_runs (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references public.companies(id) on delete cascade,
    rule_key    text not null,
    job_sync_id uuid not null,
    fired_at    timestamptz not null default now(),
    fired_by    uuid references public.profiles(id),
    -- 'done' once the action completed, 'error' if it raised while acting
    -- (the row still exists either way -- an automation that silently
    -- swallows its own failure is exactly the "acts invisibly" trap this
    -- table exists to avoid), never anything else.
    result      text not null default 'pending',
    detail      text,
    -- THE double-fire guard: one row per job per rule per company, ever.
    -- run_automation_rule() inserts this row with ON CONFLICT DO NOTHING
    -- before it does anything else, and only proceeds if that insert
    -- actually landed a row -- so a job that crosses the same line twice,
    -- or a client that calls this twice for the same job, physically
    -- cannot make the same rule act on the same job a second time.
    unique (company_id, rule_key, job_sync_id)
);

create index if not exists automation_runs_company on public.automation_runs(company_id, fired_at desc);

alter table public.automation_runs enable row level security;

drop policy if exists automation_runs_read on public.automation_runs;
create policy automation_runs_read on public.automation_runs
    for select using (company_id = public.current_company_id());

-- No client-writable policy at all. This log is only ever written by
-- run_automation_rule() (SECURITY DEFINER) -- an append-only log any client
-- can write to is not a log, it is a suggestion, the same reasoning
-- supabase_production_stages.sql already applied to job_stage_events.

-- ---------------------------------------------------------------------------
-- automation_flags -- the visible flag one rule action can raise
-- ---------------------------------------------------------------------------
create table if not exists public.automation_flags (
    id          uuid primary key default gen_random_uuid(),
    company_id  uuid not null references public.companies(id) on delete cascade,
    job_sync_id uuid not null,
    rule_key    text not null,
    message     text not null,
    created_at  timestamptz not null default now(),
    cleared_at  timestamptz,
    cleared_by  uuid references public.profiles(id)
);

create index if not exists automation_flags_open on public.automation_flags(company_id, cleared_at);

alter table public.automation_flags enable row level security;

drop policy if exists automation_flags_read on public.automation_flags;
create policy automation_flags_read on public.automation_flags
    for select using (company_id = public.current_company_id());

-- No client-writable policy. Raised only by run_automation_rule(), cleared
-- only by clear_automation_flag() below -- both SECURITY DEFINER, both
-- permission-checked. Clearing never deletes the row: it stamps cleared_at,
-- so "an automation acted and nobody ever looked" stays provable.

-- ---------------------------------------------------------------------------
-- Turning a rule on or off.
-- ---------------------------------------------------------------------------
create or replace function public.set_automation_rule_enabled(p_rule_key text, p_enabled boolean)
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
        raise exception 'You cannot change automation rules.' using errcode = '42501';
    end if;
    if p_rule_key not in (
        'materials_received_advance_stage', 'quote_gone_quiet_note',
        'approved_no_deposit_flag', 'materials_missing_scheduled_flag'
    ) then
        raise exception 'There is no automation rule called %.', p_rule_key using errcode = '22023';
    end if;

    insert into public.automation_rules (company_id, rule_key, enabled, updated_at, updated_by)
    values (co, p_rule_key, p_enabled, now(), auth.uid())
    on conflict (company_id, rule_key)
    do update set enabled = excluded.enabled, updated_at = now(), updated_by = auth.uid();
end;
$$;

revoke execute on function public.set_automation_rule_enabled(text, boolean) from public, anon;
grant  execute on function public.set_automation_rule_enabled(text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Clearing a flag. Records who saw it and when; never removes the row.
-- ---------------------------------------------------------------------------
create or replace function public.clear_automation_flag(p_flag_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
    co uuid := public.current_company_id();
begin
    if co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if not coalesce(public.has_permission('EDIT_JOBS'), false) then
        raise exception 'You cannot clear this flag.' using errcode = '42501';
    end if;

    update public.automation_flags
       set cleared_at = now(), cleared_by = auth.uid()
     where id = p_flag_id and company_id = co and cleared_at is null;
end;
$$;

revoke execute on function public.clear_automation_flag(uuid) from public, anon;
grant  execute on function public.clear_automation_flag(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Running a rule against one job. Called once per (rule, job) that the
-- dashboard's own JS found matching the rule's condition -- and re-checks
-- both the rule and the condition itself here, server-side, rather than
-- trusting the client's word for either.
-- ---------------------------------------------------------------------------
create or replace function public.run_automation_rule(p_rule_key text, p_job_sid text)
returns text
language plpgsql security definer set search_path to 'public'
as $$
declare
    co         uuid := public.current_company_id();
    v_run_id   uuid;
    v_detail   text;
    v_job      jobs%rowtype;
    v_deposit_missing boolean;
begin
    if co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    -- The same permission that already gates editing a job elsewhere on
    -- this page -- an automation acts with exactly the authority a person
    -- doing the same thing by hand would need, no more.
    if not coalesce(public.has_permission('EDIT_JOBS'), false) then
        raise exception 'You cannot run automation on jobs.' using errcode = '42501';
    end if;

    if p_rule_key not in (
        'materials_received_advance_stage', 'quote_gone_quiet_note',
        'approved_no_deposit_flag', 'materials_missing_scheduled_flag'
    ) then
        raise exception 'There is no automation rule called %.', p_rule_key using errcode = '22023';
    end if;

    if not exists (
        select 1 from public.automation_rules
         where company_id = co and rule_key = p_rule_key and enabled = true
    ) then
        return 'rule not enabled';
    end if;

    select * into v_job from public.jobs
     where company_id = co and sync_id::text = p_job_sid and deleted_at is null;
    if v_job.id is null then
        return 'job not found';
    end if;

    -- Re-check the condition itself, server-side, in the job's own current
    -- state -- not the client's copy of it. A stale client (a tab left open
    -- while someone else already handled the job) must not fire an action
    -- whose premise is no longer true.
    if p_rule_key = 'materials_received_advance_stage' then
        if not (
            v_job.status in ('ACCEPTED', 'COMPLETED')
            and v_job.materials_status = 'RECEIVED'
            and (v_job.production_stage is null or v_job.production_stage = 'MATERIALS')
        ) then
            return 'condition no longer true';
        end if;
    elsif p_rule_key = 'quote_gone_quiet_note' then
        if not (
            v_job.status = 'SENT' and v_job.quote_sent_at is not null
            and v_job.quote_approved_at is null
            and v_job.quote_sent_at < now() - interval '14 days'
        ) then
            return 'condition no longer true';
        end if;
    elsif p_rule_key = 'approved_no_deposit_flag' then
        v_deposit_missing := v_job.quote_approved_at is not null
            and coalesce(v_job.deposit_amount, 0) > 0.005
            and coalesce(v_job.amount_paid, 0) < 0.005;
        if not v_deposit_missing then
            return 'condition no longer true';
        end if;
    elsif p_rule_key = 'materials_missing_scheduled_flag' then
        if not (
            v_job.scheduled_date is not null
            and v_job.scheduled_date >= now() and v_job.scheduled_date < now() + interval '7 days'
            and coalesce(v_job.materials_status, 'NOT_ORDERED') not in ('RECEIVED', 'NOT_NEEDED')
        ) then
            return 'condition no longer true';
        end if;
    end if;

    -- THE double-fire guard. Claims the right to act on this (rule, job)
    -- pair before acting on it. If a row already exists -- this rule
    -- already fired on this job, ever -- the insert is refused silently by
    -- the unique constraint and nothing below runs.
    insert into public.automation_runs (company_id, rule_key, job_sync_id, fired_by, result)
    values (co, p_rule_key, v_job.sync_id, auth.uid(), 'pending')
    on conflict (company_id, rule_key, job_sync_id) do nothing
    returning id into v_run_id;

    if v_run_id is null then
        return 'already fired';
    end if;

    begin
        if p_rule_key = 'materials_received_advance_stage' then
            -- The exact same function the Production board's own dropdown
            -- calls -- this does not re-implement "move a stage", it makes
            -- the one move that already exists.
            perform public.set_production_stage(p_job_sid, 'DIG');
            v_detail := 'Moved to Dig.';

        elsif p_rule_key = 'quote_gone_quiet_note' then
            update public.jobs
               set notes = case when coalesce(notes, '') = '' then '' else notes || E'\n' end
                   || '[Automation ' || to_char(now(), 'YYYY-MM-DD') || '] Quote sent '
                   || to_char(v_job.quote_sent_at, 'YYYY-MM-DD') || ' has had no answer for 14+ days.'
             where company_id = co and sync_id = v_job.sync_id;
            v_detail := 'Added a note about the quiet quote.';

        elsif p_rule_key = 'approved_no_deposit_flag' then
            insert into public.automation_flags (company_id, job_sync_id, rule_key, message)
            values (co, v_job.sync_id, p_rule_key, 'Approved with no deposit taken.');
            v_detail := 'Flag raised: approved with no deposit.';

        elsif p_rule_key = 'materials_missing_scheduled_flag' then
            insert into public.automation_flags (company_id, job_sync_id, rule_key, message)
            values (co, v_job.sync_id, p_rule_key, 'Scheduled soon with materials not ready.');
            v_detail := 'Flag raised: scheduled soon, materials not ready.';
        end if;

        update public.automation_runs set result = 'done', detail = v_detail where id = v_run_id;
        return 'done: ' || v_detail;

    exception when others then
        -- The slot in automation_runs is kept either way -- that is what
        -- keeps this idempotent even when the action itself failed partway.
        -- The failure is recorded, visibly, rather than swallowed: an
        -- automation that acts invisibly is indistinguishable from a bug.
        update public.automation_runs set result = 'error', detail = sqlerrm where id = v_run_id;
        return 'error: ' || sqlerrm;
    end;
end;
$$;

revoke execute on function public.run_automation_rule(text, text) from public, anon;
grant  execute on function public.run_automation_rule(text, text) to authenticated;

comment on table public.automation_rules is
  'One row per company per fixed automation rule. Off (no row, or enabled=false) until an owner/manager turns it on.';
comment on table public.automation_runs is
  'Append-only record of every automation firing, and the unique constraint that makes a rule safe to run twice.';
comment on table public.automation_flags is
  'Flags an automation rule raised for the office to see and clear. Clearing never deletes the row.';

select 'automation rules installed' as done;

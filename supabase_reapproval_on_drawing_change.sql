-- ============================================================
-- FenceFlow -- the drawing changed after approval, so the quote needs
-- approving again.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- THE RULE, from the owner: a customer must never be bound to a fence they
-- did not agree to, and the office must not be able to quietly enlarge an
-- approved job. So when a job's drawing changes in a way that changes what
-- gets built, the approval stops counting and the customer has to say yes
-- again -- through the same quote link, the same phone gate, the same name.
--
-- Enforced in the database rather than in the app, because BOTH the phone and
-- the office write fence_runs, and a rule that lives in one of them is a rule
-- the other route walks straight past.
--
-- ---------------------------------------------------------------- MATERIAL
-- "Material" is defined off the takeoff maths, not off the row bytes. Two
-- drawings are the same job if EstimateEngine.linearFeet /
-- FenceGeometryEngine.analyze would price them the same. Concretely, the
-- fingerprint below is, per run:
--
--   * built linear feet     -- manual_linear_feet when typed in, otherwise the
--                              polyline length divided by the job's
--                              calibration_pixels_per_foot, with the closing
--                              segment counted when closed_loop -- rounded to
--                              0.1 ft (the app's own roundFeet)
--   * teardown linear feet  -- the same number for is_teardown runs, kept
--                              apart because it bills at teardown_rate_per_ft
--                              rather than labor_rate_per_ft
--   * corner count          -- vertices whose turn exceeds
--                              CORNER_ANGLE_THRESHOLD_DEGREES (15), ported
--                              from FenceGeometryEngine. Corners are posts.
--   * end count             -- 0 for a closed loop, 2 otherwise. End posts.
--   * gate count, total gate width, and the multiset of gate mountings --
--                              mounting decides concrete and hardware, so a
--                              WALL gate becoming a LINE gate is a real
--                              change even at the same width.
--
-- Deliberately NOT material, i.e. these do not disturb an approval:
--   label, color_or_finish, sort_order, suppressed_roles, updated_at, a gate's
--   swing (IN/OUT/BOTH: hinge side, not material), a gate sliding along the
--   line at the same width and mounting, the whole polyline being dragged to
--   sit better on the survey photo, the point list being reversed, and an
--   extra vertex dropped on a straight stretch -- all of which leave every
--   number above untouched, because lengths, turn angles and counts are what
--   is compared, not the encoded strings.
--
-- Also not material by construction: a run that is inserted empty (nothing
-- drawn, no gates, no typed footage) and a run deleted while still empty.
--
-- ---------------------------------------------------------------- HISTORY
-- The old approval is never deleted. Before quote_approved_at is cleared, the
-- whole of it -- name, timestamp, whether the phone gate ran, the signature
-- path, the contract total at the time, the before/after takeoff -- is copied
-- into quote_reapprovals, and a line goes into audit_log and field_changes so
-- the office feed and the phone both see it. jobs.signed_at and
-- jobs.signature_storage_path are left ALONE: that signature really was given,
-- on that day, for that drawing.
--
-- ---------------------------------------------------------------- MONEY
-- Nothing here touches money. deposit_amount, amount_paid, payment_status,
-- contract_total, refunded_amount, job_payments and payment_ledger are not
-- written. A deposit already collected stays collected; what the cleared
-- approval blocks is create-payment-link asking for MORE, since it gates on
-- quote_approved_at.
--
-- ------------------------------------------------------------------ ABUSE
-- The five quote-gate columns stay pinned by hold_quote_gate_columns() for
-- every API caller (see supabase_sec_quote_gate_columns.sql), so a crew
-- member, an accountant, a suspended company or an anon caller still cannot
-- poke jobs and clear an approval. The one new escape hatch that function
-- gains is CLEAR-ONLY by construction: with the transaction-local flag set,
-- an UPDATE may move those columns towards "not approved" and nothing else.
-- Even a caller who somehow set the flag could not forge an approval, and the
-- flag is set only inside the SECURITY DEFINER function below, for the
-- duration of one statement.
--
-- To undo:
--   drop trigger if exists reapproval_on_drawing_change on public.fence_runs;
--   drop trigger if exists "10_reapproval_resolve" on public.jobs;
--   drop trigger if exists "11_hold_reapproval_columns" on public.jobs;
-- ============================================================

-- ---------- 1. what the job is waiting on -------------------------------
alter table public.jobs add column if not exists reapproval_required_at timestamptz;
alter table public.jobs add column if not exists reapproval_reason      text not null default '';
alter table public.jobs add column if not exists reapproval_count       integer not null default 0;

comment on column public.jobs.reapproval_required_at is
  'Set when the drawing changed after the customer approved. Non-null means: this quote needs approving again. Cleared automatically when a fresh approval lands.';

-- ---------- 2. the history ------------------------------------------------
create table if not exists public.quote_reapprovals (
    id                       uuid primary key default gen_random_uuid(),
    company_id               uuid not null references public.companies(id) on delete cascade,
    job_id                   uuid not null references public.jobs(id) on delete cascade,
    job_sync_id              uuid,
    at                       timestamptz not null default now(),
    -- what happened
    run_sync_id              uuid,
    run_label                text not null default '',
    change_kind              text not null default 'UPDATE',   -- INSERT | UPDATE | DELETE
    takeoff_before           text not null default '',
    takeoff_after            text not null default '',
    reason                   text not null default '',
    -- who did it (best effort: a sync from a phone carries the member's jwt)
    actor                    uuid,
    actor_email              text,
    -- the approval that was in force, kept whole
    prior_approved_at        timestamptz,
    prior_approved_name      text not null default '',
    prior_without_phone_check boolean not null default false,
    prior_contract_total     numeric,
    prior_signed_at          timestamptz,
    prior_signature_path     text not null default '',
    -- filled in when the customer approves again
    resolved_at              timestamptz,
    resolved_name            text not null default ''
);

create index if not exists quote_reapprovals_job_idx on public.quote_reapprovals (job_id, at desc);
create index if not exists quote_reapprovals_company_idx on public.quote_reapprovals (company_id, at desc);

alter table public.quote_reapprovals enable row level security;

-- Readable by the company it belongs to. There is no pricing in it beyond the
-- contract total that the office already sees on the job, and the crew needing
-- to know "do not build this yet" is the entire point.
drop policy if exists quote_reapprovals_read on public.quote_reapprovals;
create policy quote_reapprovals_read on public.quote_reapprovals
    for select using (company_id = public.current_company_id());

-- Nobody writes it from a client. The trigger does, as the table owner.
-- A record of withdrawn approvals that the office can edit is not a record.
revoke insert, update, delete on public.quote_reapprovals from anon, authenticated;

-- ---------- 3. the takeoff fingerprint -----------------------------------
-- A port of FenceGeometryEngine.analyze + EstimateEngine.linearFeet, narrowed
-- to the numbers that decide what is built. Same sqrt form and same 15-degree
-- corner threshold as the Kotlin, so the two agree on what "the same fence"
-- means.
create or replace function public.reapp_run_takeoff(
    points_encoded text,
    gates_encoded  text,
    closed_loop    boolean,
    manual_ft      double precision,
    manual_corners integer,
    is_teardown    boolean,
    ppf            double precision
) returns text
language plpgsql
immutable
set search_path to 'public'
as $fn$
declare
    xs double precision[] := '{}';
    ys double precision[] := '{}';
    pair text;
    parts text[];
    n int;
    i int;
    seg_count int;
    total_px double precision := 0;
    feet double precision := 0;
    corners int := 0;
    ends int := 0;
    a_in double precision;
    a_out double precision;
    turn double precision;
    gate_count int := 0;
    gate_ft double precision := 0;
    mounts text[] := '{}';
    built_ft double precision;
    tear_ft double precision;
begin
    -- ---- points
    foreach pair in array coalesce(string_to_array(coalesce(points_encoded, ''), ','), '{}')
    loop
        parts := string_to_array(pair, ':');
        if array_length(parts, 1) = 2
           and parts[1] ~ '^-?[0-9]+(\.[0-9]+)?([eE]-?[0-9]+)?$'
           and parts[2] ~ '^-?[0-9]+(\.[0-9]+)?([eE]-?[0-9]+)?$' then
            xs := xs || parts[1]::double precision;
            ys := ys || parts[2]::double precision;
        end if;
    end loop;
    n := coalesce(array_length(xs, 1), 0);

    if manual_ft is not null and manual_ft > 0 then
        -- Typed-in footage wins outright, exactly as resolveGeometry does.
        feet := manual_ft;
        corners := greatest(coalesce(manual_corners, 0), 0);
        ends := case when coalesce(closed_loop, false) then 0 else 2 end;
    elsif n >= 2 and coalesce(ppf, 0) > 0 then
        seg_count := case when coalesce(closed_loop, false) then n else n - 1 end;
        for i in 1 .. seg_count loop
            total_px := total_px + sqrt(
                power(xs[(i % n) + 1] - xs[i], 2) + power(ys[(i % n) + 1] - ys[i], 2));
        end loop;
        feet := total_px / ppf;
        for i in 1 .. n loop
            if not coalesce(closed_loop, false) and (i = 1 or i = n) then
                ends := ends + 1;
                continue;
            end if;
            a_in  := atan2(ys[i] - ys[((i - 2 + n) % n) + 1], xs[i] - xs[((i - 2 + n) % n) + 1]);
            a_out := atan2(ys[(i % n) + 1] - ys[i], xs[(i % n) + 1] - xs[i]);
            turn := a_out - a_in;
            while turn > pi() loop turn := turn - 2 * pi(); end loop;
            while turn < -pi() loop turn := turn + 2 * pi(); end loop;
            if abs(degrees(turn)) >= 15 then
                corners := corners + 1;
            end if;
        end loop;
    end if;

    -- ---- gates. x/y and swing are left out on purpose: neither changes a
    -- single item on the material list.
    foreach pair in array coalesce(string_to_array(coalesce(gates_encoded, ''), ','), '{}')
    loop
        parts := string_to_array(pair, ':');
        if array_length(parts, 1) >= 3
           and parts[3] ~ '^-?[0-9]+(\.[0-9]+)?([eE]-?[0-9]+)?$' then
            gate_count := gate_count + 1;
            gate_ft := gate_ft + parts[3]::double precision;
            mounts := mounts || coalesce(nullif(parts[4], ''), 'LINE');
        end if;
    end loop;
    mounts := array(select unnest(mounts) order by 1);

    built_ft := case when coalesce(is_teardown, false) then 0 else feet end;
    tear_ft  := case when coalesce(is_teardown, false) then feet else 0 end;

    return format('b=%s|t=%s|c=%s|e=%s|g=%s|gf=%s|gm=%s',
        round(built_ft::numeric, 1), round(tear_ft::numeric, 1),
        corners, ends, gate_count, round(gate_ft::numeric, 1),
        array_to_string(mounts, '+'));
end;
$fn$;

-- The same thing straight off a fence_runs row, so caller and trigger cannot
-- disagree about which columns feed it.
create or replace function public.reapp_row_takeoff(r public.fence_runs, ppf double precision)
returns text language sql immutable set search_path to 'public' as $fn$
    select public.reapp_run_takeoff(
        r.points_encoded, r.gates_encoded, r.closed_loop,
        r.manual_linear_feet, r.manual_corner_count, r.is_teardown, ppf);
$fn$;

-- "Nothing drawn yet": an empty run appearing or disappearing is not a change
-- to what the customer agreed to.
create or replace function public.reapp_is_empty(fingerprint text)
returns boolean language sql immutable as $fn$
    select fingerprint = 'b=0.0|t=0.0|c=0|e=0|g=0|gf=0.0|gm=';
$fn$;

-- ---------- 4. the clear-only escape hatch -------------------------------
-- hold_quote_gate_columns(), re-stated in full with ONE branch added. Every
-- existing behaviour is byte-for-byte the same: no request claims or the
-- service role passes through, an INSERT is forced to the unapproved state,
-- and an ordinary API UPDATE has all five columns pinned to their old values.
--
-- The added branch is reached only inside reapp_withdraw_approval() below,
-- which sets app.reapproval_clear for the length of one statement. It permits
-- the approval to be taken AWAY and nothing else: each column is accepted only
-- when the new value is the unapproved value, and is otherwise pinned exactly
-- as before. The counters stay pinned outright, so this cannot be used to
-- reset a phone-gate lockout either.
create or replace function public.hold_quote_gate_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    -- No request claims at all: a trigger, a migration, psql. The service
    -- role is the quote-view function itself.
    if nullif(current_setting('request.jwt.claims', true), '') is null
       or public.is_service_role() then
        return new;
    end if;

    if tg_op = 'UPDATE' then
        if coalesce(current_setting('app.reapproval_clear', true), '') = '1' then
            -- Clear-only. Anything that is not "become unapproved" is pinned.
            new.quote_approved_at :=
                case when new.quote_approved_at is null
                     then null else old.quote_approved_at end;
            new.quote_approved_name :=
                case when coalesce(new.quote_approved_name, '') = ''
                     then '' else old.quote_approved_name end;
            new.quote_approved_without_phone_check :=
                case when new.quote_approved_without_phone_check is not true
                     then false else old.quote_approved_without_phone_check end;
            new.quote_phone_attempts     := old.quote_phone_attempts;
            new.quote_phone_locked_until := old.quote_phone_locked_until;
            return new;
        end if;
        new.quote_approved_at                 := old.quote_approved_at;
        new.quote_approved_name               := old.quote_approved_name;
        new.quote_approved_without_phone_check := old.quote_approved_without_phone_check;
        new.quote_phone_attempts              := old.quote_phone_attempts;
        new.quote_phone_locked_until          := old.quote_phone_locked_until;
    else
        new.quote_approved_at                 := null;
        new.quote_approved_name               := '';
        new.quote_approved_without_phone_check := false;
        new.quote_phone_attempts              := 0;
        new.quote_phone_locked_until          := null;
    end if;
    return new;
end;
$function$;

drop trigger if exists "00_hold_quote_gate" on public.jobs;
create trigger "00_hold_quote_gate"
    before insert or update on public.jobs
    for each row execute function public.hold_quote_gate_columns();

-- ---------- 5. the new columns are not a back door either ----------------
-- reapproval_* is the office's and the phone's "do not build this yet" flag.
-- An API caller clearing it by hand would hide the whole rule, so it is
-- pinned the same way the quote-gate columns are. Fires AFTER 00_ by name, so
-- it sees the pinned row.
create or replace function public.hold_reapproval_columns()
returns trigger language plpgsql set search_path to 'public' as $fn$
begin
    -- Invoker, deliberately: inside a SECURITY DEFINER function current_user
    -- is the owner, which is exactly how the trigger below is allowed to
    -- write these columns while PostgREST callers are not.
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;
    if tg_op = 'UPDATE' then
        new.reapproval_required_at := old.reapproval_required_at;
        new.reapproval_reason      := old.reapproval_reason;
        new.reapproval_count       := old.reapproval_count;
    else
        new.reapproval_required_at := null;
        new.reapproval_reason      := '';
        new.reapproval_count       := 0;
    end if;
    return new;
end;
$fn$;

drop trigger if exists "11_hold_reapproval_columns" on public.jobs;
create trigger "11_hold_reapproval_columns"
    before insert or update on public.jobs
    for each row execute function public.hold_reapproval_columns();

-- ---------- 6. withdrawing the approval ----------------------------------
create or replace function public.reapp_withdraw_approval(
    jid uuid, run_sync uuid, run_label text, kind text, before_fp text, after_fp text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
    j public.jobs%rowtype;
    who uuid := auth.uid();
    who_email text;
    the_reason text;
begin
    select * into j from public.jobs where id = jid;
    if not found or j.quote_approved_at is null then
        return;   -- nothing approved, nothing to withdraw
    end if;

    select email into who_email from auth.users where id = who;

    the_reason := format(
        'The drawing changed on %s after %s approved this quote%s. It needs approving again.',
        to_char(now(), 'YYYY-MM-DD'),
        coalesce(nullif(j.quote_approved_name, ''), 'the customer'),
        case when coalesce(run_label, '') = '' then '' else ' (' || run_label || ')' end);

    -- History FIRST, so a failure here cannot leave an approval cleared with
    -- no record of what it was.
    insert into public.quote_reapprovals (
        company_id, job_id, job_sync_id, run_sync_id, run_label, change_kind,
        takeoff_before, takeoff_after, reason, actor, actor_email,
        prior_approved_at, prior_approved_name, prior_without_phone_check,
        prior_contract_total, prior_signed_at, prior_signature_path)
    values (
        j.company_id, j.id, j.sync_id, run_sync, coalesce(run_label, ''), kind,
        coalesce(before_fp, ''), coalesce(after_fp, ''), the_reason, who, who_email,
        j.quote_approved_at, coalesce(j.quote_approved_name, ''),
        coalesce(j.quote_approved_without_phone_check, false),
        j.contract_total, j.signed_at, coalesce(j.signature_storage_path, ''));

    insert into public.audit_log (
        company_id, actor, actor_email, table_name, record_id, action,
        field, old_value, new_value, label)
    values (
        j.company_id, who, who_email, 'jobs', j.sync_id::text, 'update',
        'quote_approved_at', j.quote_approved_at::text, null,
        coalesce(j.customer_name, ''));

    -- The crew's and the office's existing feed. Same table the site changes
    -- already land in, so nobody has to go looking somewhere new.
    insert into public.field_changes (
        company_id, sync_id, job_sync_id, summary, detail, changed_by, changed_by_role)
    values (
        j.company_id, gen_random_uuid()::text, j.sync_id,
        'Quote needs approving again', the_reason,
        coalesce(who_email, 'system'), '');

    -- Now take the approval away. Money columns are deliberately absent from
    -- this UPDATE; so are signed_at and signature_storage_path.
    perform set_config('app.reapproval_clear', '1', true);
    update public.jobs set
        quote_approved_at                  = null,
        quote_approved_name                = '',
        quote_approved_without_phone_check = false,
        reapproval_required_at             = now(),
        reapproval_reason                  = the_reason,
        reapproval_count                   = coalesce(reapproval_count, 0) + 1
    where id = jid;
    perform set_config('app.reapproval_clear', '0', true);
exception when others then
    perform set_config('app.reapproval_clear', '0', true);
    raise;
end;
$fn$;

revoke execute on function public.reapp_withdraw_approval(uuid, uuid, text, text, text, text)
    from anon, authenticated, public;

-- ---------- 7. the trigger on the drawing --------------------------------
-- SECURITY DEFINER on purpose, and it is the reason reapp_withdraw_approval()
-- can stay revoked from every API role: the withdrawal is reachable only
-- through this trigger, never as an RPC a crew member could call on a job they
-- simply fancy un-approving. Scoping comes from the run row itself
-- (company_id + job_sync_id), never from the caller's claims.
create or replace function public.reapp_on_run_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
    j public.jobs%rowtype;
    ppf double precision;
    before_fp text := '';
    after_fp text := '';
    kind text;
    r public.fence_runs;
begin
    r := case when tg_op = 'DELETE' then old else new end;

    select * into j from public.jobs
        where sync_id = r.job_sync_id and company_id = r.company_id;
    -- Unapproved job, or a run that belongs to no job we can see: nothing to
    -- protect. This is the branch that leaves ordinary quoting untouched.
    if not found or j.quote_approved_at is null then
        return case when tg_op = 'DELETE' then old else new end;
    end if;
    ppf := j.calibration_pixels_per_foot;

    if tg_op = 'INSERT' then
        kind := 'INSERT';
        after_fp := public.reapp_row_takeoff(new, ppf);
    elsif tg_op = 'DELETE' then
        kind := 'DELETE';
        before_fp := public.reapp_row_takeoff(old, ppf);
    else
        -- A soft delete is a delete. An undelete puts footage back, which is
        -- just as material.
        before_fp := case when old.deleted_at is not null then ''
                          else public.reapp_row_takeoff(old, ppf) end;
        after_fp  := case when new.deleted_at is not null then ''
                          else public.reapp_row_takeoff(new, ppf) end;
        kind := case
            when old.deleted_at is null and new.deleted_at is not null then 'DELETE'
            when old.deleted_at is not null and new.deleted_at is null then 'INSERT'
            else 'UPDATE' end;
    end if;

    -- An empty run arriving or leaving changes no number on the estimate.
    if coalesce(before_fp, '') = '' and public.reapp_is_empty(coalesce(after_fp, 'x')) then
        return case when tg_op = 'DELETE' then old else new end;
    end if;
    if coalesce(after_fp, '') = '' and public.reapp_is_empty(coalesce(before_fp, 'x')) then
        return case when tg_op = 'DELETE' then old else new end;
    end if;
    -- The whole point: same takeoff, same fence, approval stands.
    if before_fp = after_fp then
        return case when tg_op = 'DELETE' then old else new end;
    end if;

    perform public.reapp_withdraw_approval(
        j.id, r.sync_id, coalesce(r.label, ''), kind, before_fp, after_fp);

    return case when tg_op = 'DELETE' then old else new end;
end;
$fn$;

drop trigger if exists reapproval_on_drawing_change on public.fence_runs;
create trigger reapproval_on_drawing_change
    after insert or update or delete on public.fence_runs
    for each row execute function public.reapp_on_run_change();

-- ---------- 8. re-approval clears the flag -------------------------------
-- The customer approving again is the ONLY thing that clears it, and the only
-- route to quote_approved_at is still quote-view (service role, phone gate,
-- typed name) because hold_quote_gate_columns() pins the column for everyone
-- else. So re-approval goes through exactly the same flow as the first one.
create or replace function public.reapp_resolve_on_approval()
returns trigger language plpgsql security definer set search_path to 'public' as $fn$
begin
    if tg_op = 'UPDATE'
       and old.quote_approved_at is null
       and new.quote_approved_at is not null then
        new.reapproval_required_at := null;
        new.reapproval_reason      := '';
        update public.quote_reapprovals
           set resolved_at = new.quote_approved_at,
               resolved_name = coalesce(new.quote_approved_name, '')
         where job_id = new.id and resolved_at is null;
    end if;
    return new;
end;
$fn$;

drop trigger if exists "10_reapproval_resolve" on public.jobs;
create trigger "10_reapproval_resolve"
    before update on public.jobs
    for each row execute function public.reapp_resolve_on_approval();

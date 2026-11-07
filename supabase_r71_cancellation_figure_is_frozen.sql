-- ============================================================
-- FenceFlow -- WHAT A CANCELLATION KEPT WAS NEVER WRITTEN DOWN
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- r45 added the column and said exactly what it was for:
--
--     -- What was kept, in whole currency units, AS DECIDED AT THE MOMENT OF
--     -- CANCELLATION. Stored rather than recomputed: the line items and the
--     -- footage can change afterwards, and what was retained is a fact about
--     -- that day, not a figure that should drift.
--     add column if not exists cancellation_retained numeric;
--
-- MEASURED 6 Nov 2026: nothing in this repository writes it. Not the office
-- (dashboard.html cancelJob() sets cancelled_at, cancelled_by and
-- cancellation_reason, and stops), not the phone (CancellationApi.cancel()
-- sets cancelled_at and cancellation_reason, and stops), not a trigger, not an
-- edge function. The column has existed, empty, since r45.
--
-- AND THE DISPLAY RECOMPUTES. The deployed job_cancellation_terms was read
-- out of the live database for this migration: it mentions neither
-- cancellation_retained nor cancelled_at. It answers from whatever the job
-- looks like NOW, every time it is asked -- including long after the job was
-- cancelled.
--
-- So: the customer is told "we keep $X, you get $Y back", the job is
-- cancelled, $X is stored nowhere, and the next person to open that job is
-- shown a figure recomputed from today's line items. Nobody can say which
-- number was the agreement. This is the same defect jobs.accepted_total was
-- created to fix on the quote side (job 4598: signed at $9,710, billed
-- against $13,410) -- here it is again, on a refund.
--
-- WHAT DRIFTS, PRECISELY. retained = feet * $1 + material-if-ordered.
--   feet      j.signed_linear_feet -- ALREADY frozen, at signing. Safe.
--   material  sum(quantity * unit_price) over the job's LIVE line items.
--             Re-pricing, an edited quantity, a tombstoned line: all move it.
--   ordered   materials_status / materials_ordered_at, which keep changing
--             after a cancellation like any other column.
-- So the drift is real, and it is the material half.
--
-- TODAY IT HAS HURT NOBODY: 0 of 20 jobs have ever been cancelled. That is
-- the reason to fix it now rather than after the first one.
--
-- ------------------------------------------------------------------------
-- WHY A TRIGGER AND NOT TWO CLIENT PATCHES
-- ------------------------------------------------------------------------
-- The office and the phone each cancel with a plain `update jobs`. Teaching
-- both to also write the figure means two copies of a money rule, a release
-- of each, and a third client later that forgets. The transition itself is
-- the funnel: cancelled_at going from null to not-null happens in exactly one
-- place no matter who asks, so the figure is computed and stored there, as
-- part of the same statement, and a caller that says nothing about it still
-- gets it right. No app release is needed for either client.
--
-- ONE DEFINITION OF THE RULE. The trigger must not carry its own copy of the
-- arithmetic -- two copies of a money expression drift, and this file exists
-- because of a figure that drifted. PART 1 lifts the rule into
-- cancellation_retained_raw(); PART 2 rewrites job_cancellation_terms to call
-- it; PART 3's trigger calls the same function. One rule, three readers.
--
-- THE HELPER IS DELIBERATELY UNROUNDED. The deployed function rounds in two
-- different places from the same base:
--     retained    = round(base, 2)
--     refund_due  = round(greatest(collected - base, 0), 2)   <- base UNROUNDED
-- A helper that returned the rounded figure would change refund_due by up to
-- a cent on live money. Returning the raw base reproduces both columns
-- exactly as deployed.
--
-- WHAT IS FROZEN AND WHAT IS NOT. `retained` is a decision, so it freezes.
-- `paid` is not -- a refund actually issued lowers it -- so refund_due stays
-- `max(paid - retained, 0)` against the stored retained and the live paid,
-- and falls to zero as the money goes back. Freezing the refund too would
-- have the office still demanding a payment it had already made.
--
-- Idempotent. PART 4 raises rather than reporting, and carries a canary.
-- ============================================================

begin;

-- ------------------------------------------------------------------------
-- PART 1  the rule, in one place
-- ------------------------------------------------------------------------
-- Unrounded on purpose (see the header). immutable: it is arithmetic on its
-- arguments and reads nothing.
create or replace function public.cancellation_retained_raw(
    p_feet      numeric,
    p_ordered   boolean,
    p_mat_sell  numeric,
    p_inside    boolean
) returns numeric
language sql
immutable
as $$
  -- r45: $1 a foot for the work that will not happen, plus the material when
  -- it was ordered. r61: nothing at all inside the three business days.
  select case
    when coalesce(p_inside, false) then 0::numeric
    else coalesce(p_feet, 0) * 1.00
         + case when coalesce(p_ordered, false) then coalesce(p_mat_sell, 0) else 0 end
  end;
$$;

comment on function public.cancellation_retained_raw(numeric, boolean, numeric, boolean) is
  'The r45/r61 retention rule, UNROUNDED. job_cancellation_terms rounds it for display and rounds (collected - it) for the refund; freeze_cancellation_retained() rounds it once to store. Unrounded so those two roundings stay exactly as r45 deployed them.';

-- ------------------------------------------------------------------------
-- PART 2  the display honours a figure that was already decided
-- ------------------------------------------------------------------------
-- Body is the deployed function, read out of this project, with two changes:
-- the two retained/refund expressions now call PART 1, and both consult the
-- frozen figure first. Everything else -- the scope, the cooling-off window,
-- the material and payment CTEs -- is untouched.
create or replace function public.job_cancellation_terms(jsync text)
returns table(
    materials_ordered boolean, material_quoted numeric, material_cost numeric,
    feet numeric, inconvenience numeric, retained numeric, paid numeric,
    refund_due numeric, within_cooling_off boolean,
    cooling_off_ends_at timestamp with time zone)
language sql
stable
security definer
set search_path to 'public'
as $$
  with scope as (select money_scope_company_id() as cid),
  j as (
    select jb.*
      from public.jobs jb, scope s
     where jb.company_id = s.cid
       and jb.sync_id = jsync::uuid
       and jb.deleted_at is null
  ),
  zone as (
    select nullif(cs.settings ->> 'cooling_off_timezone', '') as tz
      from public.company_settings cs, scope s
     where cs.company_id = s.cid
  ),
  mat as (
    select coalesce(sum(i.quantity * i.unit_price), 0) as sell,
           coalesce(sum(i.quantity * coalesce(i.supplier_unit_price, i.unit_price)), 0) as cost
      from public.estimate_line_items i, scope s
     where i.company_id = s.cid
       and i.job_sync_id = jsync::uuid
       and i.deleted_at is null
  ),
  money as (
    select coalesce(sum(p.amount), 0) as collected
      from public.payment_records p, scope s
     where p.company_id = s.cid
       and p.job_sync_id = jsync::uuid
       and p.deleted_at is null
  ),
  cool as (
    select j.signed_at is not null
             and now() < public.cooling_off_deadline(j.signed_at, (select tz from zone))
             as inside,
           public.cooling_off_deadline(j.signed_at, (select tz from zone)) as ends
      from j
  ),
  base as (
    select (j.materials_ordered_at is not null
              or upper(coalesce(j.materials_status, 'NOT_ORDERED')) in ('ORDERED', 'RECEIVED')) as ordered,
           coalesce(j.signed_linear_feet, 0)::numeric as ft
      from j
  ),
  -- The decision, if one was made. Both halves are required: a stored figure
  -- on a job that is not cancelled is not an agreement about anything.
  frozen as (
    select case when j.cancelled_at is not null then j.cancellation_retained end as amount
      from j
  ),
  -- One base for both money columns, so they can never disagree about which
  -- figure they are describing.
  r as (
    select coalesce(
             frozen.amount,
             public.cancellation_retained_raw(base.ft, base.ordered, mat.sell::numeric, cool.inside)
           ) as raw
      from base, mat, cool, frozen
  )
  select
    base.ordered as materials_ordered,
    round(mat.sell::numeric, 2) as material_quoted,
    round(mat.cost::numeric, 2) as material_cost,
    base.ft as feet,
    -- UNCHANGED and deliberately NOT frozen: this is the per-foot component
    -- on its own, shown to explain the figure. feet is signed_linear_feet,
    -- which was already fixed at signing, so it does not drift anyway.
    case when cool.inside then 0::numeric else round(base.ft * 1.00, 2) end as inconvenience,
    round(r.raw, 2) as retained,
    round(money.collected::numeric, 2) as paid,
    -- Against the live `paid`, so a refund actually issued brings this down.
    round(greatest(money.collected::numeric - r.raw, 0), 2) as refund_due,
    coalesce(cool.inside, false) as within_cooling_off,
    cool.ends as cooling_off_ends_at
  from j, mat, money, base, cool, r;
$$;

-- ------------------------------------------------------------------------
-- PART 3  write the figure down, at the moment of cancellation
-- ------------------------------------------------------------------------
-- SECURITY DEFINER because it reads the job's own line items to price the
-- material half, and the caller's own grants are not the question here: the
-- row being cancelled is the authority, and it is already in NEW.
--
-- It does NOT call money_scope_company_id(): that is the CALLER's scope, and
-- a crew account with no money scope would store a null and silently lose the
-- figure this file exists to keep. NEW.company_id is the right scope and the
-- only one.
create or replace function public.freeze_cancellation_retained()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_sell numeric;
    v_tz text;
    v_inside boolean;
    v_ordered boolean;
begin
    select coalesce(sum(i.quantity * i.unit_price), 0) into v_sell
      from public.estimate_line_items i
     where i.company_id = new.company_id
       and i.job_sync_id = new.sync_id
       and i.deleted_at is null;

    select nullif(cs.settings ->> 'cooling_off_timezone', '') into v_tz
      from public.company_settings cs
     where cs.company_id = new.company_id;

    v_inside := new.signed_at is not null
                and now() < public.cooling_off_deadline(new.signed_at, v_tz);

    v_ordered := new.materials_ordered_at is not null
                 or upper(coalesce(new.materials_status, 'NOT_ORDERED')) in ('ORDERED', 'RECEIVED');

    -- Rounded once, here, to the same 2 places job_cancellation_terms shows.
    -- Whatever the caller sent in this column is overwritten: the figure is
    -- the server's to decide, not a number a client may post.
    new.cancellation_retained := round(
        public.cancellation_retained_raw(
            coalesce(new.signed_linear_feet, 0)::numeric, v_ordered, v_sell, v_inside), 2);
    return new;
end $$;

-- BEFORE, so the value lands in the same row write rather than a second
-- UPDATE (which would churn updated_at and push the row to every other phone
-- -- see the quiet-write rule in touch_updated_at()).
--
-- Fires only on the null -> not-null transition of cancelled_at, so:
--   * a later edit to a cancelled job never re-prices the decision;
--   * un-cancelling and re-cancelling takes a fresh figure, correctly;
--   * an ordinary update to a live job does no extra reads at all.
drop trigger if exists jobs_freeze_cancellation_retained on public.jobs;
create trigger jobs_freeze_cancellation_retained
    before update of cancelled_at on public.jobs
    for each row
    when (old.cancelled_at is null and new.cancelled_at is not null)
    execute function public.freeze_cancellation_retained();

-- ------------------------------------------------------------------------
-- PART 4  prove it, against a real row, and put the row back
-- ------------------------------------------------------------------------
do $$
declare
    v_job public.jobs%rowtype;
    v_ids uuid[];
    v_id uuid;
    v_stored numeric;
    v_expected numeric;
    v_sell numeric;
    v_ordered boolean;
    v_saw_ordered boolean := false;
    v_saw_plain boolean := false;
    d text;
begin
    -- The rule function answers.
    if public.cancellation_retained_raw(100, true, 250.00, false) <> 350.00 then
        raise exception 'r71: 100ft + $250 ordered material should retain 350, got %',
            public.cancellation_retained_raw(100, true, 250.00, false);
    end if;
    if public.cancellation_retained_raw(100, true, 250.00, true) <> 0 then
        raise exception 'r71: inside the cooling-off window nothing is retained';
    end if;
    if public.cancellation_retained_raw(100, false, 250.00, false) <> 100.00 then
        raise exception 'r71: material that was never ordered must not be retained';
    end if;

    -- The trigger exists and is pinned to the transition.
    select pg_get_triggerdef(oid) into d from pg_trigger
     where tgname = 'jobs_freeze_cancellation_retained';
    if d is null then
        raise exception 'r71: the freeze trigger is missing';
    end if;
    if d !~* 'BEFORE UPDATE OF cancelled_at' then
        raise exception 'r71: the freeze trigger is not on the cancelled_at write: %', d;
    end if;
    if d !~* 'cancelled_at IS NULL' then
        raise exception 'r71: the freeze trigger lost its transition guard, so a later edit re-prices a settled cancellation: %', d;
    end if;

    -- AND IT ACTUALLY FIRES. Everything above would pass with a trigger
    -- function that returned NEW untouched. Cancel a real job, read the
    -- column back, then put the row back by hand.
    --
    -- TWO JOBS, CHOSEN BY PROPERTY, not one chosen by sort order. The first
    -- draft rehearsed against whichever job had the most feet; that job
    -- happens to have NOT_ORDERED materials, so the material half of the rule
    -- was multiplied out and a canary that corrupted the material figure
    -- passed silently. One job with materials ordered and one without is the
    -- smallest set that exercises both branches.
    select array_agg(id) into v_ids from (
        (select jb.id from public.jobs jb
          where jb.deleted_at is null and jb.cancelled_at is null
            and (jb.materials_ordered_at is not null
                 or upper(coalesce(jb.materials_status, 'NOT_ORDERED')) in ('ORDERED', 'RECEIVED'))
          order by jb.signed_linear_feet desc nulls last limit 1)
        union all
        (select jb.id from public.jobs jb
          where jb.deleted_at is null and jb.cancelled_at is null
            and not (jb.materials_ordered_at is not null
                 or upper(coalesce(jb.materials_status, 'NOT_ORDERED')) in ('ORDERED', 'RECEIVED'))
          order by jb.signed_linear_feet desc nulls last limit 1)
    ) q;

    if v_ids is null or array_length(v_ids, 1) = 0 then
        raise exception 'r71: no live job to rehearse against -- the trigger was never exercised, so this migration proves nothing about it';
    end if;
    if array_length(v_ids, 1) < 2 then
        raise notice 'r71: only one rehearsal job available -- one branch of the material rule is unexercised';
    end if;

    foreach v_id in array v_ids loop
        select * into v_job from public.jobs where id = v_id;
        select coalesce(sum(i.quantity * i.unit_price), 0) into v_sell
          from public.estimate_line_items i
         where i.company_id = v_job.company_id and i.job_sync_id = v_job.sync_id
           and i.deleted_at is null;
        v_ordered := v_job.materials_ordered_at is not null
              or upper(coalesce(v_job.materials_status, 'NOT_ORDERED')) in ('ORDERED', 'RECEIVED');
        v_expected := round(public.cancellation_retained_raw(
            coalesce(v_job.signed_linear_feet, 0)::numeric, v_ordered, v_sell,
            v_job.signed_at is not null and now() < public.cooling_off_deadline(
                v_job.signed_at,
                (select nullif(cs.settings ->> 'cooling_off_timezone', '')
                   from public.company_settings cs where cs.company_id = v_job.company_id))), 2);

        update public.jobs set cancelled_at = now() where id = v_job.id;
        select cancellation_retained into v_stored from public.jobs where id = v_job.id;

        -- Put it back BEFORE judging, so a failed check cannot leave a live
        -- job cancelled.
        update public.jobs
           set cancelled_at = v_job.cancelled_at,
               cancellation_retained = v_job.cancellation_retained,
               updated_at = v_job.updated_at
         where id = v_job.id;

        if v_stored is null then
            raise exception 'r71: cancelling job % left cancellation_retained NULL -- the trigger did not fire', v_job.id;
        end if;
        if v_stored <> v_expected then
            raise exception 'r71: on job % the trigger stored % but the rule says %',
                v_job.id, v_stored, v_expected;
        end if;
        -- A rehearsal that retains nothing cannot tell a working trigger from
        -- one that writes a constant zero.
        if v_stored = 0 then
            raise exception 'r71: job % retained 0, so this rehearsal distinguishes nothing -- pick a job with feet on it', v_job.id;
        end if;
        if v_ordered then v_saw_ordered := true; else v_saw_plain := true; end if;
        raise notice 'r71: rehearsed job % (ordered=%) -- stored % as expected', v_job.id, v_ordered, v_stored;
    end loop;

    if not v_saw_ordered then
        raise notice 'r71: no job with ordered materials was available -- the material half of the rule is unexercised here';
    end if;

    -- THE DISPLAY HALF, checked by reading the function rather than calling
    -- it. job_cancellation_terms is scoped by money_scope_company_id(), which
    -- is null for the role that applies migrations, so calling it here returns
    -- no rows and would prove nothing either way -- an empty answer that reads
    -- like success. These are source assertions and they are honest about it:
    -- tests/a165 exercises the behaviour as a real signed-in owner.
    select prosrc into d from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'job_cancellation_terms';
    if d is null then
        raise exception 'r71: job_cancellation_terms is gone';
    end if;
    if d not like '%cancellation_retained%' then
        raise exception 'r71: job_cancellation_terms still never reads the stored figure, so a settled cancellation keeps being re-priced';
    end if;
    if d not like '%cancellation_retained_raw%' then
        raise exception 'r71: job_cancellation_terms no longer shares the rule function, so the display and the trigger can drift apart again';
    end if;
    if d not like '%cancelled_at is not null%' then
        raise exception 'r71: the frozen figure is read without checking the job is actually cancelled -- a stored figure on a live job is not an agreement';
    end if;

    raise notice 'r71 OK: a cancellation now records what it kept';
end $$;

commit;

-- ------------------------------------------------------------------------
-- STILL OPEN after this
-- ------------------------------------------------------------------------
--   1. Nothing has ever been cancelled in production (0 of 20 jobs), so the
--      cancel path itself is still unexercised by a real user. This file
--      rehearses the WRITE inside the migration; it does not prove the
--      office's dialog or the phone's dialog reach it.
--   2. The office shows the terms, the user confirms, and the server decides
--      independently. If the material list changed in those few seconds the
--      stored figure is the server's, not the one on screen. Correct, but the
--      screen does not re-read afterwards -- it should show what was stored.
--   3. jobs.cancellation_retained is not in the phone's CloudSettings/entity
--      pull, so the handset cannot display what a cancellation kept.

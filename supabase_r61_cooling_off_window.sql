-- r61: nothing is retained inside the three-business-day right to cancel.
--
-- WHY. The contract now states the federal three-business-day right in full
-- (FEDERAL_RIGHT_TO_CANCEL_* in ContractTemplate.kt, offered from Settings), and
-- that clause says the customer owes NOTHING inside the window: no cancellation
-- fee, no charge for scheduled work, no charge for materials ordered. r45's
-- job_cancellation_terms() knows nothing about the window and charges $1 a foot
-- plus the whole material sell from the first minute after signing. So the
-- document and the app disagree about money, and the document is the one the
-- customer signed and the one the law backs.
--
-- The owner asked for this ("do all of it", 30 Oct 2026) after it was put to him
-- as a money decision. It only ever moves a figure DOWN, and only for a
-- cancellation inside three business days of signing.
--
-- WHAT A BUSINESS DAY IS. 16 C.F.R. 429.0(e) defines it as any calendar day
-- except Sunday and a list of holidays. This implements Sunday plus the modern
-- federal holiday set, which is a SUPERSET of the rule's list -- the rule
-- predates MLK Day and Juneteenth and still names Lincoln's Birthday. Excluding
-- more days can only make the window LONGER, which is the safe direction: a
-- window that ends too late costs the owner a fee he could have kept, and one
-- that ends too early is a violation of the customer's statutory right. It also
-- matches the clause actually printed on the contract, which says "Sundays and
-- federal holidays do not" count.
--
-- WHICH MIDNIGHT. "Midnight of the third business day" is a LOCAL midnight, and
-- nothing in this database records a company's timezone -- companies has no
-- state, address or timezone column (checked). So the default is deliberately
-- Pacific/Honolulu, the latest US zone: for every company it is the same day
-- boundary or a later one, never an earlier one, so an unset company's window
-- can only be generous. A company that wants it to end at its own local
-- midnight sets company_settings.settings -> 'cooling_off_timezone' (for this
-- one, 'America/New_York').
--
-- WHAT IS NOT CHANGED. The $1/ft and the material rule are untouched outside
-- the window -- the owner settled those on 27 Oct and this does not revisit
-- them. Nothing writes; this function is STABLE and only reports. refund_due
-- still never goes negative.
--
-- A DROP IS NEEDED, not CREATE OR REPLACE: two columns are added to the
-- RETURNS TABLE and Postgres will not replace a function with a different
-- result type. Safe here and checked first -- no policy and no other function
-- references job_cancellation_terms, so nothing breaks while it is gone inside
-- this transaction. The phone decodes it with ignoreUnknownKeys and every field
-- defaulted (CancellationApi.Terms), so a handset on an older build reads the
-- corrected retained/refund_due and simply ignores the two new columns.
--
-- Idempotent. The self-check at the end raises rather than leaving it half done.

begin;

-- ------------------------------------------------------------ a business day
create or replace function public.is_cooling_off_business_day(d date)
returns boolean
language sql
immutable
as $$
    select case
        -- Sunday. The one weekday the rule excludes; Saturday counts.
        when extract(isodow from d) = 7 then false
        -- Fixed dates.
        when (extract(month from d), extract(day from d)) in
             ((1,1),      -- New Year's Day
              (2,12),     -- Lincoln's Birthday (named by 16 C.F.R. 429.0(e))
              (6,19),     -- Juneteenth
              (7,4),      -- Independence Day
              (11,11),    -- Veterans Day
              (12,25))    -- Christmas Day
            then false
        -- Floating Mondays and the one Thursday.
        when extract(month from d) = 1  and extract(isodow from d) = 1
             and extract(day from d) between 15 and 21 then false  -- MLK, 3rd Mon Jan
        when extract(month from d) = 2  and extract(isodow from d) = 1
             and extract(day from d) between 15 and 21 then false  -- Presidents', 3rd Mon Feb
        when extract(month from d) = 5  and extract(isodow from d) = 1
             and extract(day from d) > 24 then false               -- Memorial, last Mon May
        when extract(month from d) = 9  and extract(isodow from d) = 1
             and extract(day from d) <= 7 then false               -- Labor, 1st Mon Sep
        when extract(month from d) = 10 and extract(isodow from d) = 1
             and extract(day from d) between 8 and 14 then false   -- Columbus, 2nd Mon Oct
        when extract(month from d) = 11 and extract(isodow from d) = 4
             and extract(day from d) between 22 and 28 then false  -- Thanksgiving, 4th Thu Nov
        else true
    end;
$$;

comment on function public.is_cooling_off_business_day(date) is
  'False on Sunday and on every modern US federal holiday, for counting the three business days '
  'of the FTC Cooling-Off Rule (16 C.F.R. 429). Deliberately a SUPERSET of the holidays the rule '
  'names -- excluding extra days lengthens the customer''s window, which is the safe direction.';

-- -------------------------------------------------------------- the deadline
create or replace function public.cooling_off_deadline(signed timestamptz, tz text default null)
returns timestamptz
language plpgsql
stable
as $$
declare
    zone text := coalesce(nullif(btrim(coalesce(tz, '')), ''), 'Pacific/Honolulu');
    day  date;
    counted int := 0;
begin
    if signed is null then return null; end if;
    -- The signing DAY in the company's own zone. The count starts the day
    -- AFTER: "the third business day after the day you signed it".
    day := (signed at time zone zone)::date;
    while counted < 3 loop
        day := day + 1;
        if public.is_cooling_off_business_day(day) then
            counted := counted + 1;
        end if;
    end loop;
    -- Midnight at the END of that third business day, back in UTC.
    return ((day + 1)::timestamp) at time zone zone;
exception when others then
    -- An unknown timezone name must not make a cancellation un-quotable.
    -- Fall back to the generous default rather than to no window at all,
    -- which would charge the fee the contract forbids.
    return (((signed at time zone 'Pacific/Honolulu')::date + 4)::timestamp)
             at time zone 'Pacific/Honolulu';
end;
$$;

-- --------------------------------------------------------------- the terms
drop function if exists public.job_cancellation_terms(text);

create function public.job_cancellation_terms(jsync text)
returns table(
    materials_ordered boolean,
    material_quoted numeric,
    material_cost numeric,
    feet numeric,
    inconvenience numeric,
    retained numeric,
    paid numeric,
    refund_due numeric,
    -- NEW. Both default-safe for an older phone: CancellationApi.Terms
    -- decodes by name with every field defaulted.
    within_cooling_off boolean,
    cooling_off_ends_at timestamptz
)
language sql
stable
security definer
set search_path to 'public'
as $function$
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
    -- job_costing's own expressions, verbatim: every non-deleted line item,
    -- sell at unit_price, cost falling back to unit_price when no supplier
    -- price is on record.
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
  -- THE WINDOW. Measured from signed_at, because that is the act the right
  -- attaches to -- not quote_approved_at and not created_at. A job with no
  -- signature on record has no window: there is nothing to cancel within
  -- three days OF, and reading a null as "inside" would zero every
  -- cancellation ever made on an unsigned job.
  cool as (
    select j.signed_at is not null
             and now() < public.cooling_off_deadline(j.signed_at, (select tz from zone))
             as inside,
           public.cooling_off_deadline(j.signed_at, (select tz from zone)) as ends_at
      from j
  ),
  -- The r45 figures, unchanged, named once so the window can zero them
  -- without the expression being written out three more times.
  base as (
    select (j.materials_ordered_at is not null
              or upper(coalesce(j.materials_status, 'NOT_ORDERED')) in ('ORDERED', 'RECEIVED')) as ordered,
           coalesce(j.signed_linear_feet, 0)::numeric as ft
      from j
  )
  select
    base.ordered as materials_ordered,
    round(mat.sell::numeric, 2) as material_quoted,
    round(mat.cost::numeric, 2) as material_cost,
    base.ft as feet,
    -- $1 a foot for the work that will not happen now -- and nothing at all
    -- inside the three business days, which is what the signed contract says.
    case when cool.inside then 0::numeric else round(base.ft * 1.00, 2) end as inconvenience,
    -- ANSWERED 27 Oct 2026, and the per-foot term is out of the case for it:
    -- "Yes for the $1/ft even if material not ordered for cancelation, for no
    -- work done." So the inconvenience fee is charged on every cancellation,
    -- and the MATERIAL is the only part that depends on whether it was
    -- ordered. r61 adds the one exception the law does not leave open: inside
    -- the three-business-day window nothing is retained, whatever was ordered.
    case when cool.inside then 0::numeric
         else round(base.ft * 1.00
                    + case when base.ordered then mat.sell::numeric else 0 end, 2)
    end as retained,
    round(money.collected::numeric, 2) as paid,
    -- Never negative: a job that paid less than is retained owes nothing back,
    -- it simply has nothing to refund. The shortfall is a conversation, not a
    -- negative refund. Inside the window the whole of what was paid goes back.
    case when cool.inside then round(money.collected::numeric, 2)
         else round(greatest(money.collected::numeric -
                (base.ft * 1.00
                 + case when base.ordered then mat.sell::numeric else 0 end), 0), 2)
    end as refund_due,
    coalesce(cool.inside, false) as within_cooling_off,
    cool.ends_at as cooling_off_ends_at
  from j, mat, money, base, cool;
$function$;

revoke all     on function public.job_cancellation_terms(text) from public, anon;
grant  execute on function public.job_cancellation_terms(text) to authenticated;
grant  execute on function public.is_cooling_off_business_day(date) to authenticated;
grant  execute on function public.cooling_off_deadline(timestamptz, text) to authenticated;

-- ------------------------------------------------------------------ self-check
-- Dates, not rows: every assertion below is about the calendar, so it needs no
-- job and writes nothing. Each rule is paired with a day that must come out the
-- other way, because a check that cannot be shown to fail is not a check.
do $check$
declare
    d timestamptz;
begin
    -- Sundays out, Saturdays in.
    if public.is_cooling_off_business_day(date '2026-11-01') then        -- a Sunday
        raise exception 'r61: Sunday counted as a business day';
    end if;
    if not public.is_cooling_off_business_day(date '2026-10-31') then    -- a Saturday
        raise exception 'r61: Saturday did NOT count -- the rule says it does';
    end if;

    -- The floating holidays, each with the same weekday a week earlier as the
    -- control, so a rule that matched the whole month would be caught.
    if public.is_cooling_off_business_day(date '2026-11-26') then        -- 4th Thu: Thanksgiving
        raise exception 'r61: Thanksgiving counted as a business day';
    end if;
    if not public.is_cooling_off_business_day(date '2026-11-19') then    -- the Thursday before
        raise exception 'r61: an ordinary November Thursday was excluded';
    end if;
    if public.is_cooling_off_business_day(date '2026-05-25') then        -- last Mon May
        raise exception 'r61: Memorial Day counted as a business day';
    end if;
    if not public.is_cooling_off_business_day(date '2026-05-18') then
        raise exception 'r61: an ordinary May Monday was excluded';
    end if;
    if public.is_cooling_off_business_day(date '2026-09-07') then        -- 1st Mon Sep
        raise exception 'r61: Labor Day counted as a business day';
    end if;
    if not public.is_cooling_off_business_day(date '2026-09-14') then
        raise exception 'r61: an ordinary September Monday was excluded';
    end if;
    if public.is_cooling_off_business_day(date '2026-12-25') then
        raise exception 'r61: Christmas counted as a business day';
    end if;

    -- A plain week: signed Monday, the window ends at midnight ending Thursday,
    -- because Tue/Wed/Thu are the three business days after the signing day.
    d := public.cooling_off_deadline(timestamptz '2026-11-02 15:00:00-05', 'America/New_York');
    if d <> timestamptz '2026-11-06 00:00:00-05' then
        raise exception 'r61: a Monday signing ends at % , expected midnight ending Thursday 5 Nov', d;
    end if;

    -- Signed Friday: Sat counts, Sun does not, so Sat/Mon/Tue are the three
    -- and it ends at midnight ending Tuesday.
    d := public.cooling_off_deadline(timestamptz '2026-11-06 09:00:00-05', 'America/New_York');
    if d <> timestamptz '2026-11-11 00:00:00-05' then
        raise exception 'r61: a Friday signing ends at %, expected midnight ending Tuesday 10 Nov', d;
    end if;

    -- An unknown zone must fall back, not fail: a cancellation has to stay
    -- quotable.
    if public.cooling_off_deadline(now(), 'Not/AZone') is null then
        raise exception 'r61: an unknown timezone left the deadline null, so no window would apply at all';
    end if;

    -- No signature, no window.
    if public.cooling_off_deadline(null, 'America/New_York') is not null then
        raise exception 'r61: an unsigned job was given a cooling-off deadline';
    end if;
end $check$;

commit;

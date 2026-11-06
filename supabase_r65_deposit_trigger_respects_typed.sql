-- ============================================================
-- FenceFlow -- the price trigger must not rewrite a deposit somebody TYPED
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- THE DEFECT, introduced 5 November 2026 by applying
-- supabase_r8_deposit_follows_price.sql.
--
-- The phone's rule (JobMoney.depositToStore) has three gates and the FIRST is:
--
--     if (!job.depositIsAuto) return null
--
-- "A typed deposit is never touched, which is the protection that cost John
-- Beaunissant's $9,910 to learn." The trigger I applied has no such gate --
-- `position('deposit_is_auto' in prosrc)` on the live body is 0. It checks
-- only that the deposit was not typed IN THE SAME STATEMENT, so any later
-- server-side re-price scales a figure the owner typed weeks ago.
--
-- Measured on live data, 6 November 2026: 8 of 14 priced jobs carry
-- deposit_is_auto = false. One, 'nini', is in the fully exposed state --
-- priced 32,175.25, a typed deposit of 14,395.20, not approved, not signed,
-- nothing paid -- so nothing but this gate stands between a re-price and that
-- figure being overwritten.
--
-- WHAT THIS CHANGES, and deliberately nothing else: one more early return.
-- The trigger can now only do LESS than it did, never more, which is the only
-- shape of fix worth applying to a money rule without a rehearsal. The
-- proportional scaling it still does for AUTO deposits is wrong for a
-- different reason (it does not re-derive from the materials rule, so it can
-- leave a deposit below the materials cost) and is replaced separately -- that
-- one is a formula change and needs the shared engine, not a trigger.
--
-- WHY NOT JUST DROP THE TRIGGER. Because the rule it implements is one March
-- asked for twice: a deposit must follow a re-price while the job is still
-- his own draft. Dropping it would put that back to never following. The
-- narrow fix keeps the behaviour he asked for and removes the behaviour he
-- never did.
-- ============================================================

-- Baseline, read BEFORE the change, so the proofs below can be compared
-- against something rather than asserted into the air.
do $baseline$
declare typed int; auto_n int; exposed int;
begin
    select count(*) filter (where not coalesce(deposit_is_auto, false)
                              and coalesce(deposit_amount, 0) > 0.005),
           count(*) filter (where coalesce(deposit_is_auto, false)
                              and coalesce(deposit_amount, 0) > 0.005),
           count(*) filter (where not coalesce(deposit_is_auto, false)
                              and coalesce(deposit_amount, 0) > 0.005
                              and quote_approved_at is null
                              and signed_at is null
                              and coalesce(amount_paid, 0) <= 0.005)
      into typed, auto_n, exposed
      from public.jobs where deleted_at is null;
    raise notice 'before: % typed deposit(s), % auto, % typed-and-unfrozen (the exposed set)',
        typed, auto_n, exposed;
end $baseline$;

create or replace function public.deposit_follows_price()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
    old_total numeric := coalesce(old.contract_total, 0)::numeric;
    new_total numeric := coalesce(new.contract_total, 0)::numeric;
    old_dep   numeric := coalesce(old.deposit_amount, 0)::numeric;
    net_paid  numeric := coalesce(old.amount_paid, 0)::numeric
                         - coalesce(old.refunded_amount, 0)::numeric;
    -- money has actually moved. Read off OLD only. NEW.amount_paid arrives from
    -- whoever is writing, and a rule that trusts a client-supplied paid figure
    -- is a rule anyone can switch off.
    customer_is_in_it boolean :=
        ((old.quote_approved_at is not null or old.signed_at is not null)
          and old.reapproval_required_at is null)
        or net_paid > 0.005;
    scaled numeric;
begin
    -- Nothing to scale from, or nothing to scale.
    if old_total <= 0.005 or old_dep <= 0.005 then
        return new;
    end if;

    -- THE GATE THIS FILE ADDS. A deposit somebody typed is theirs and never
    -- moves on its own -- the same first gate as JobMoney.depositToStore, in
    -- the same order, for the same reason. Read off OLD: what the figure WAS
    -- when the price moved is what decides whose figure it is. Reading NEW
    -- would let any writer set deposit_is_auto = true in the same statement
    -- and unlock a typed figure, which is a gate anyone can open.
    if not coalesce(old.deposit_is_auto, false) then
        return new;
    end if;

    -- The price did not move.
    if abs(new_total - old_total) <= 0.005 then
        return new;
    end if;
    -- Somebody typed a deposit in this same statement. Their number wins; this
    -- rule is for the case where the price moved and the deposit was left
    -- alone. Without this test, saving the job sheet with a new deposit AND a
    -- new price would scale the figure that was just typed in.
    if abs(coalesce(new.deposit_amount, 0)::numeric - old_dep) > 0.005 then
        return new;
    end if;
    if customer_is_in_it then
        return new;
    end if;
    -- A new price of zero or less is a job being emptied out, not a job being
    -- re-priced; leaving the deposit alone is the safe reading, and the readers
    -- all cap a deposit at the price anyway.
    if new_total <= 0.005 then
        return new;
    end if;

    scaled := round(old_dep / old_total * new_total, 2);
    -- Never above the price. A deposit larger than the job is a bill for money
    -- the customer never agreed to -- it has happened here before, a $3,963
    -- deposit stored against a $3,620 job -- and every reader already caps it
    -- on the way out. Capping on the way IN means the stored row is not wrong
    -- in the first place.
    new.deposit_amount := least(scaled, new_total);
    return new;
end $fn$;

-- The trigger itself is unchanged and still sorts last; recreated only so a
-- fresh database gets it from this file too.
drop trigger if exists zz_deposit_follows_price on public.jobs;
create trigger zz_deposit_follows_price
  before update on public.jobs
  for each row execute function public.deposit_follows_price();

-- ============================================================
-- PROOFS. Every one reads the live database. The last is a CANARY that must
-- read false, because a proof that cannot fail is not a proof.
-- ============================================================
with t as (
    select prosrc from pg_proc
     where pronamespace = 'public'::regnamespace and proname = 'deposit_follows_price'
)
select 'the typed-deposit gate is in the live body' as claim,
       (select position('deposit_is_auto' in prosrc) > 0 from t) as got, true as want
union all
select 'it reads OLD, not NEW, so no writer can unlock it in the same statement',
       (select position('coalesce(old.deposit_is_auto, false)' in prosrc) > 0 from t), true
union all
select 'it does NOT read new.deposit_is_auto anywhere',
       (select position('new.deposit_is_auto' in prosrc) = 0 from t), true
union all
select 'the customer-is-in-it freeze is still there',
       (select position('customer_is_in_it' in prosrc) > 0 from t), true
union all
select 'the cap at the price is still there',
       (select position('least(scaled, new_total)' in prosrc) > 0 from t), true
union all
select 'the trigger exists, BEFORE UPDATE on jobs',
       exists (select 1 from pg_trigger
                where tgrelid = 'public.jobs'::regclass
                  and tgname = 'zz_deposit_follows_price'
                  and not tgisinternal), true
union all
select 'and still sorts AFTER jobs_touch_updated_at, so a re-price is not a clock bump',
       not exists (select 1 from pg_trigger
                    where tgrelid = 'public.jobs'::regclass and not tgisinternal
                      and tgtype & 2 = 2
                      and tgname > 'zz_deposit_follows_price'), true
union all
select 'deposit_amount is still OUTSIDE touch_updated_at''s quiet list',
       (select position('deposit_amount' in prosrc) = 0
          from pg_proc where pronamespace = 'public'::regnamespace
           and proname = 'touch_updated_at'), true
union all
-- THE CANARY. The string below is NOT in the function. If this reads true the
-- comparison above is matching anything, and every proof is worthless.
select 'CANARY: a string that is not in the body reads as absent',
       (select position('zz_this_text_is_not_in_the_function' in prosrc) > 0 from t), false
order by 1;

-- How many jobs this gate now protects that it did not protect a minute ago.
do $after$
declare exposed int;
begin
    select count(*) into exposed
      from public.jobs
     where deleted_at is null
       and not coalesce(deposit_is_auto, false)
       and coalesce(deposit_amount, 0) > 0.005
       and quote_approved_at is null
       and signed_at is null
       and coalesce(amount_paid, 0) <= 0.005;
    raise notice 'after: % job(s) with a typed deposit and no customer freeze are now protected by the gate', exposed;
end $after$;

-- ============================================================
-- FenceFlow -- the deposit follows a re-price, until the customer is in it
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   ADDITIVE ONLY. One new trigger function and one new trigger on public.jobs.
--   No column added, no column dropped, no row touched. Every input it reads
--   already exists on the row.
--
-- WHAT MARCH ASKED FOR, and what he decided (2026-09-24)
--   "deposit must follow re-price everywhere". Asked where it should STOP
--   following, he chose: it follows freely while the job is still his own
--   draft, and freezes the moment the customer is in it -- they approved or
--   signed, or any money landed. If a drawing change withdraws the approval,
--   it follows again, because at that point the whole price is back in play.
--   That is the same rule contract_total itself already lives by.
--
-- WHY THIS IS A TRIGGER AND NOT CODE IN THE APPS
--   contract_total has TWO independent writers that do not talk to each other:
--   the price-job edge function (its CommitPlan jobPatch) and the phone
--   (JobSync.pushContractTotal). Neither touches deposit_amount today -- a
--   grep of supabase/functions finds no assignment to it at all. Writing the
--   rule in both means two copies that can disagree about a customer's money,
--   which is the failure the shared pricing engine exists to prevent. One
--   trigger on the column being changed cannot be bypassed by either writer,
--   or by a third one added later.
--
--   It also deliberately does NOT re-derive the deposit from a percentage.
--   There is no stored deposit percentage -- see the comment still sitting in
--   website/dashboard.html about deposit_percent being written and read by
--   nothing. The proportion is taken from the deposit and the price the owner
--   themselves last agreed on, which needs no new column and cannot drift.
--
-- THE TRAP THIS FILE IS NAMED AROUND -- READ BEFORE RENAMING THE TRIGGER
--   deposit_amount is NOT on touch_updated_at()'s quiet list (checked against
--   the live function, 2026-09-24: updated_at, the dispute columns, amount_paid,
--   refunded_amount, payment_status, payments_from_processor, contract_total,
--   accepted_total, quote_viewed_at, site_lat/lon, last_seen_at, priced_by,
--   priced_at, pricing_engine_version, wizard_step, quote_phone_attempts,
--   quote_phone_locked_until, quote_approved_without_phone_check, opted_out_at).
--
--   Postgres fires BEFORE triggers in trigger-NAME order. So a trigger that
--   rewrote deposit_amount BEFORE jobs_touch_updated_at would leave
--   touch_updated_at seeing deposit_amount differ, and it would stamp
--   new.updated_at = now(). That destroys the exact property price-job's own
--   comment says its jobPatch exists to preserve: the four columns it writes are
--   all quiet, "precisely so this write cannot make a phone's own unsynced
--   offline edits look older than it and lose them on the next merge". Every
--   office re-price and every phone pushContractTotal would become a clock bump,
--   and offline field edits would start disappearing with nothing to show why.
--
--   Hence the zz_ prefix. The BEFORE UPDATE triggers on public.jobs today, in
--   the order they fire: 00_hold_contract_columns, 00_hold_first_contact_by,
--   00_hold_quote_gate, 00_protect_customer_identity, 00_protect_job_money,
--   10_reapproval_resolve, 11_hold_reapproval_columns, 12_stamp_accepted_total,
--   enforce_delete_permission, first_contact_is_first_trg,
--   job_assignment_needs_permission, jobs_touch_updated_at,
--   stamp_materials_dates_trg. zz_ sorts after all of them. PART 3 below proves
--   it rather than trusting the alphabet; supabase_conflict_version_patch.sql
--   already warns not to rely on this without checking.
--
-- WHY IT CANNOT BE SMUGGLED
--   deposit_amount and contract_total are both in job_money_columns(), so
--   00_protect_job_money copies them back from OLD for any caller who is not
--   money_caller_trusted(). That runs first. A crew phone therefore arrives here
--   with new.contract_total = old.contract_total and this trigger does nothing,
--   and it can never be the one that "typed a deposit".
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  the rule
-- ------------------------------------------------------------------------

create or replace function public.deposit_follows_price()
 returns trigger
 language plpgsql
as $function$
declare
    old_total numeric := coalesce(old.contract_total, 0)::numeric;
    new_total numeric := coalesce(new.contract_total, 0)::numeric;
    old_dep   numeric := coalesce(old.deposit_amount, 0)::numeric;
    net_paid  numeric := greatest(
        coalesce(old.amount_paid, 0)::numeric - coalesce(old.refunded_amount, 0)::numeric, 0);
    -- The customer is in it: they have agreed a price that still stands, or
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
end;
$function$;

-- ------------------------------------------------------------------------
-- PART 2  the trigger. The NAME is load-bearing; see the header.
-- ------------------------------------------------------------------------

drop trigger if exists zz_deposit_follows_price on public.jobs;
create trigger zz_deposit_follows_price
  before update on public.jobs
  for each row execute function public.deposit_follows_price();

-- ------------------------------------------------------------------------
-- PART 3  prove what landed. Every row must read true.
-- ------------------------------------------------------------------------

select 'the trigger exists, BEFORE UPDATE on jobs' as check,
       exists (select 1 from pg_trigger
                where tgrelid = 'public.jobs'::regclass
                  and tgname = 'zz_deposit_follows_price'
                  and not tgisinternal
                  and tgtype & 2 = 2 and tgtype & 16 = 16) as ok
union all
-- The whole point of the zz_ prefix. If this ever reads false, the clock bump
-- described in the header is live and offline edits are being lost silently.
select 'it fires AFTER jobs_touch_updated_at',
       (select t1.tgname > t2.tgname
          from pg_trigger t1, pg_trigger t2
         where t1.tgrelid = 'public.jobs'::regclass and t1.tgname = 'zz_deposit_follows_price'
           and t2.tgrelid = 'public.jobs'::regclass and t2.tgname = 'jobs_touch_updated_at')
union all
select 'no other BEFORE UPDATE trigger on jobs sorts after it',
       not exists (select 1 from pg_trigger
                    where tgrelid = 'public.jobs'::regclass and not tgisinternal
                      and tgtype & 2 = 2 and tgtype & 16 = 16
                      and tgname > 'zz_deposit_follows_price')
union all
-- deposit_amount must still be OUTSIDE the quiet list. If someone adds it,
-- this trigger stops needing its name -- and a hand-typed deposit edit stops
-- moving the clock, which it should.
select 'deposit_amount is still not on touch_updated_at quiet list',
       (select position('''deposit_amount''' in prosrc) = 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'touch_updated_at')
union all
select 'a held money column cannot smuggle a deposit (both are guarded)',
       (select count(*) = 2 from unnest(public.job_money_columns()) c
         where c in ('deposit_amount', 'contract_total'));


-- ------------------------------------------------------------------------
-- PART 4  run the rule, on a throwaway table, and read the answers back
--
-- A TEMPORARY table, not public.jobs, and not a rolled-back write to a real
-- row either: jobs carries AFTER triggers including the push notification
-- (job-change-push, an http_request), and an http call is not undone by a
-- ROLLBACK -- a "safe" test would have sent real phones a real push. A temp
-- table with the seven columns the function actually reads exercises the same
-- function body with nothing else attached, and disappears with the session.
--
-- Every row must read true. A case that CANNOT move is as important as one
-- that can: without the frozen cases this block would pass for a trigger that
-- simply scaled everything.
-- ------------------------------------------------------------------------

create temporary table deposit_rule_probe (
    id                     int primary key,
    contract_total         double precision,
    deposit_amount         double precision,
    amount_paid            double precision default 0,
    refunded_amount        double precision default 0,
    quote_approved_at      timestamptz,
    signed_at              timestamptz,
    reapproval_required_at timestamptz
);

create trigger zz_deposit_follows_price
  before update on deposit_rule_probe
  for each row execute function public.deposit_follows_price();

insert into deposit_rule_probe (id, contract_total, deposit_amount, amount_paid,
                               quote_approved_at, signed_at, reapproval_required_at)
values
    -- 1 a plain draft: follows
    (1, 10000, 2000, 0, null, null, null),
    -- 2 approved and the approval stands: frozen
    (2, 10000, 2000, 0, now(), null, null),
    -- 3 signed: frozen
    (3, 10000, 2000, 0, null, now(), null),
    -- 4 approved, then a drawing change withdrew it: follows again
    (4, 10000, 2000, 0, now(), null, now()),
    -- 5 not approved but money has landed: frozen
    (5, 10000, 2000, 250, null, null, null),
    -- 6 money in and fully refunded, so net paid is zero: follows
    (6, 10000, 2000, 250, null, null, null),
    -- 7 no deposit set: nothing to scale
    (7, 10000, 0, 0, null, null, null),
    -- 8 the deposit is typed in the same statement: the typed figure wins
    (8, 10000, 2000, 0, null, null, null),
    -- 9 the scaled figure would exceed the new price: capped at the price
    -- 9 a deposit ALREADY above its own price (this has happened: $3,963
    --   stored against a $3,620 job) and the price then falls further
    (9, 10000, 12000, 0, null, null, null);

update deposit_rule_probe set refunded_amount = 250 where id = 6;

-- Double the price on every row. Only the rows that may follow should move.
update deposit_rule_probe set contract_total = 20000 where id not in (8, 9);
-- Row 8 gets a new price AND a hand-typed deposit in one statement.
update deposit_rule_probe set contract_total = 20000, deposit_amount = 3500 where id = 8;
-- Row 9 goes the other way: the price falls below its own deposit.
update deposit_rule_probe set contract_total = 5000 where id = 9;

select 'a plain draft follows the price' as check,
       (select abs(deposit_amount - 4000) < 0.005 from deposit_rule_probe where id = 1) as ok
union all
select 'an approved job is frozen',
       (select abs(deposit_amount - 2000) < 0.005 from deposit_rule_probe where id = 2)
union all
select 'a signed job is frozen',
       (select abs(deposit_amount - 2000) < 0.005 from deposit_rule_probe where id = 3)
union all
select 'a withdrawn approval follows again',
       (select abs(deposit_amount - 4000) < 0.005 from deposit_rule_probe where id = 4)
union all
select 'money paid freezes it even without an approval',
       (select abs(deposit_amount - 2000) < 0.005 from deposit_rule_probe where id = 5)
union all
select 'money fully refunded does not freeze it',
       (select abs(deposit_amount - 4000) < 0.005 from deposit_rule_probe where id = 6)
union all
select 'no deposit set stays no deposit',
       (select abs(deposit_amount - 0) < 0.005 from deposit_rule_probe where id = 7)
union all
select 'a deposit typed in the same statement is not re-scaled',
       (select abs(deposit_amount - 3500) < 0.005 from deposit_rule_probe where id = 8)
union all
select 'the scaled deposit is capped at the new price',
       (select abs(deposit_amount - 5000) < 0.005 from deposit_rule_probe where id = 9)
union all
-- CANARY. Rows 2, 3 and 5 must have stayed at 2000. If the trigger scaled
-- everything, at least one of these checks is the one that catches it -- so
-- prove the comparison itself can fail, on a figure nothing was asked to move.
select 'CANARY: the same comparison, against a figure the rule never touched',
       (select abs(deposit_amount - 4000) >= 0.005 from deposit_rule_probe where id = 2);

drop trigger zz_deposit_follows_price on deposit_rule_probe;
drop table deposit_rule_probe;

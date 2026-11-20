-- ============================================================================
-- THE DEPOSIT A CUSTOMER AGREED TO CANNOT BE RAISED BEHIND THEIR BACK.
--
-- A4 finding #7, 20 November 2026. `accepted_total` is frozen at approval;
-- `deposit_amount` is not.
--
-- `supabase_r67_deposit_follows_the_materials.sql` computes `customer_is_in_it`
-- and, when true, `return new` -- which stops the AUTOMATIC rule from
-- recomputing the deposit and does nothing at all about a TYPED one. No
-- trigger pins the column the way the quote-gate columns are pinned, and
-- `depositFigures` caps the figure only at the job total. So a customer who
-- approved a $2,000 deposit can be asked for $6,000 by an edit in the office,
-- with no new approval and nothing saying it changed. Most likely to bite as a
-- typo rather than as intent -- which is the main reason to catch it in the
-- database rather than to ask somebody to be careful.
--
-- THE RULE, and it is deliberately one-directional:
--
--   Once the customer is in it, the deposit may go DOWN but not UP.
--
-- Down is harmless: asking for less than somebody agreed to needs nobody's
-- permission, and "actually, just pay $500 now" is a thing a contractor
-- should be able to do. Up is the one that puts a figure in front of a
-- customer they never agreed to.
--
-- WHEN THE CUSTOMER IS "IN IT" -- copied from r67's own definition, so the two
-- cannot come to disagree about it:
--     ((approved or signed) and no re-approval pending) or net paid > 0
--
-- WHICH MEANS THE RE-PRICE ROUTE IS STILL OPEN, and that is the point: raising
-- the deposit is allowed exactly when a re-approval is pending, because that
-- is the flow that asks the customer again. Withdraw the approval, re-price,
-- let them approve the new figure. That matches the money rules already
-- decided -- a re-price carries a new deposit -- rather than inventing a
-- second way to change the number.
--
-- REVERTED, NOT REFUSED, matching hold_money_columns and the quote-gate pins:
-- a sync that carries a column it may not raise must not fail outright, or
-- every other field on the row goes down with it.
--
-- WHO IS EXEMPT: a caller with no JWT claims (a migration, a definer context)
-- and the service role. Neither is the office. The app and the website office
-- both reach this table through PostgREST as the signed-in user, so both are
-- held. No edge function writes deposit_amount -- checked, 20 Nov 2026:
-- create-payment-link, quote-view and both webhooks only ever read it.
--
-- MEASURED FIRST, on production: 12 jobs have a deposit set with the customer
-- in it, 2 of them with a re-approval pending. None is mid-change, so nothing
-- is being taken away from anybody by applying this.
--
-- Re-runnable.
-- ============================================================================

begin;

create or replace function public.hold_deposit_after_approval()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    old_dep  numeric := coalesce(old.deposit_amount, 0)::numeric;
    new_dep  numeric := coalesce(new.deposit_amount, 0)::numeric;
    net_paid numeric := greatest(coalesce(old.amount_paid, 0)::numeric
                                 - coalesce(old.refunded_amount, 0)::numeric, 0);
    -- r67's own definition, character for character.
    customer_is_in_it boolean :=
        ((old.quote_approved_at is not null or old.signed_at is not null)
          and old.reapproval_required_at is null)
        or net_paid > 0.005;
begin
    -- Nothing is being raised.
    if new_dep - old_dep <= 0.005 then
        return new;
    end if;
    if not customer_is_in_it then
        return new;
    end if;
    -- A migration, a definer context, or the server itself.
    if nullif(current_setting('request.jwt.claims', true), '') is null
       or public.is_service_role() then
        return new;
    end if;

    /* Said out loud. A reverted write is invisible by design -- the office
       types 6000, the row keeps 2000, and nothing on the screen explains it.
       The log line is the only place that can say why, and it carries both
       figures so the answer is in the record rather than in somebody's
       reconstruction. */
    raise warning 'deposit_amount held at % on job % (% was asked for): the customer has '
                  'already agreed to this deposit. Withdraw the approval and re-price to '
                  'change it.', old_dep, old.id, new_dep;

    new.deposit_amount := old.deposit_amount;
    -- A deposit the owner typed is theirs and never moves on its own (r65).
    -- Holding the figure while letting the flag through would hand the
    -- automatic rule a job it thinks it may recompute.
    new.deposit_is_auto := old.deposit_is_auto;
    return new;
end $$;

comment on function public.hold_deposit_after_approval() is
  'Once a customer has approved, signed, or paid, the deposit may go down but '
  'not up. Raising it needs a pending re-approval -- the flow that asks them '
  'again. A4 finding #7.';

/* AFTER the money hold (00_) so the figure this reads is the one that
   survived it, and BEFORE the automatic deposit rule (zz_) so that rule sees
   the held figure rather than the one somebody typed over it. */
drop trigger if exists "05_hold_deposit_after_approval" on public.jobs;
create trigger "05_hold_deposit_after_approval"
    before update on public.jobs
    for each row execute function public.hold_deposit_after_approval();

commit;

-- ============================================================================
-- AFTERWARDS: supabase_a4_deposit_pin_probe_live.sql, which is rolled back and
-- carries its own positive controls -- a DECREASE that must still be accepted,
-- a raise before approval that must still be accepted, and a raise while a
-- re-approval is pending that must still be accepted. Without those three a
-- trigger that refused every write would pass the only check that matters.
-- ============================================================================

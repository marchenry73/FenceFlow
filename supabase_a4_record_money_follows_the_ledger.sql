-- ============================================================================
-- THE RECORD_MONEY HOLD MUST FOLLOW THE LEDGER, NOT FREEZE IT.
--
-- Fixes a regression that supabase_a4_record_money_is_a_write_permission.sql
-- introduced and that I measured on production within the hour.
--
-- WHAT WENT WRONG. That patch reverted the seven "money arrived" columns to
-- their OLD values for any caller without RECORD_MONEY. `amount_paid` and
-- `refunded_amount` are not written only by hand: `recompute_job_totals()`
-- derives them from `payment_records` on every ledger change, through the
-- `payment_records_totals` trigger. That function is SECURITY DEFINER, but
-- money_caller_trusted() and record_money_trusted() read
-- `request.jwt.claims`, and a definer function does NOT change the session's
-- claims. So the recompute ran inside a manager's session, hold_money_columns
-- saw a caller without RECORD_MONEY, and reverted the recompute's own write.
--
-- MEASURED, as a real MANAGER, in a rolled-back transaction:
--   INSERT a $250 CASH ledger row ............ accepted (as designed)
--   jobs.amount_paid afterwards .............. 0 -> 0, ledger sums to 250
-- A manager recorded a cash payment, the ledger row landed, and the job's
-- figure never moved. That is worse than the hole it was closing: money that
-- was really taken stops showing.
--
-- THE FIX, and it is better than the first version rather than a patch over
-- it. For a caller without RECORD_MONEY, the derived figures are not frozen
-- at their old values -- they are RECOMPUTED FROM THE LEDGER:
--
--   amount_paid      := sum of the positive ledger rows
--   refunded_amount  := minus the sum of the negative ones
--   payment_status   := the same up-only ladder the webhooks use, applied to
--                       that net figure
--
-- So the recompute's write passes (it already equals the ledger), a cash
-- payment a manager records shows immediately, AND a manager who types a
-- figure in gets the ledger's answer instead of their own. A declaration
-- with nothing behind it now lands on the truth rather than on the previous
-- value, which is a stronger guarantee than the one it replaces.
--
-- `refunded_at`, `refund_reason`, `tip_amount` and `payments_from_processor`
-- are not derivable from the ledger, so those four are still reverted to OLD.
--
-- WHY NOT A FLAG. The obvious alternative is for recompute_job_totals() to
-- set a transaction-local GUC that this trigger honours. It would work, and
-- it would make the guarantee depend on nobody ever exposing a function that
-- sets that GUC from user input. Deriving the number is not a special case
-- for one caller; it is the rule, applied to everybody who may not declare
-- money. The arithmetic below is copied from recompute_job_totals so the two
-- cannot disagree about what the ledger says.
--
-- COST: one indexed aggregate (payment_records_job_idx covers
-- (company_id, job_sync_id)) on each jobs UPDATE by a caller who holds
-- SEE_MONEY but not RECORD_MONEY -- so managers and salespeople, not owners,
-- not the webhooks, not the crew path (which never reaches this branch).
--
-- Re-runnable. One function body changes; no data is read or written.
-- ============================================================================

begin;

create or replace function public.hold_money_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    cols text[] := case when tg_nargs > 0 then tg_argv else public.job_money_columns() end;
    guard_received boolean := tg_nargs = 0;
    /* The received-money columns that cannot be derived from the ledger, so
       they are held at OLD rather than recomputed. Taken FROM
       job_received_money_columns() minus the three that are derived below,
       so that list stays the single authoritative answer to "which columns
       mean money arrived" -- a new one added there is held automatically
       instead of being quietly unguarded. */
    held text[] := array(
        select c from unnest(public.job_received_money_columns()) c
         where c not in ('amount_paid', 'refunded_amount', 'payment_status'));
    sid uuid;
    co uuid;
    v_paid numeric;
    v_refunded numeric;
    v_net numeric;
    v_total numeric;
    v_rank_now int;
    v_rank_want int;
    v_want text;
begin
    if public.money_caller_trusted() then
        /* RECORD_MONEY.

           Being trusted to SEE money is not being trusted to DECLARE it. A
           MANAGER passes the test above -- SEE_MONEY is on their role -- and
           could until 20 Nov 2026 write amount_paid and payment_status
           directly, with no payment anywhere and no ledger row.

           What follows is not a freeze. amount_paid, refunded_amount and
           payment_status are DERIVED from payment_records here, exactly as
           recompute_job_totals derives the first two -- so money this caller
           really recorded still shows, and a figure they typed is replaced by
           the ledger's answer rather than by the previous value. */
        if guard_received and not public.record_money_trusted() then
            if tg_op = 'UPDATE' then
                -- The four that are not derivable: put back as they were.
                new := jsonb_populate_record(new, (
                    select jsonb_object_agg(c, to_jsonb(old) -> c) from unnest(held) c));

                sid := coalesce(old.sync_id, new.sync_id);
                co  := coalesce(old.company_id, new.company_id);

                -- Copied from recompute_job_totals, deliberately, so the two
                -- cannot disagree about what the ledger says.
                select coalesce(sum(amount) filter (where amount >= 0), 0),
                       coalesce(-sum(amount) filter (where amount < 0), 0)
                  into v_paid, v_refunded
                  from payment_records
                 where company_id = co and job_sync_id = sid and deleted_at is null;

                new.amount_paid := v_paid;
                new.refunded_amount := v_refunded;

                /* The same up-only ladder the webhooks use
                   (_shared/record-payment.ts nextPaymentStatus, direction
                   "up"): a payment may raise the status and must never lower
                   it, because the phone may have promoted the job on a total
                   this row does not carry. A job with no contract_total stops
                   at DEPOSIT_PAID, which is what the server has always done
                   for a job it has not priced. */
                v_net := v_paid - v_refunded;
                v_total := coalesce(old.contract_total, 0);
                v_want := case
                    when v_net <= 0.005 then 'UNPAID'
                    when v_total > 0 and v_net >= v_total - 0.005 then 'PAID_IN_FULL'
                    else 'DEPOSIT_PAID' end;
                v_rank_want := case v_want when 'PAID_IN_FULL' then 2
                                           when 'DEPOSIT_PAID' then 1 else 0 end;
                v_rank_now := case coalesce(old.payment_status, 'UNPAID')
                                   when 'PAID_IN_FULL' then 2
                                   when 'DEPOSIT_PAID' then 1 else 0 end;
                new.payment_status := case when v_rank_want > v_rank_now
                                           then v_want
                                           else coalesce(old.payment_status, 'UNPAID') end;
            else
                -- A new job may not arrive already paid. There is no ledger to
                -- derive from yet, so these are the empty values.
                new.amount_paid := 0;
                new.payment_status := 'UNPAID';
                new.refunded_amount := 0;
                new.refunded_at := null;
                new.refund_reason := null;
                new.tip_amount := 0;
                new.payments_from_processor := false;
            end if;
        end if;
        return new;
    end if;

    if tg_op = 'UPDATE' then
        new := jsonb_populate_record(new, (
            select jsonb_object_agg(c, to_jsonb(old) -> c) from unnest(cols) c));
    else
        new := jsonb_populate_record(new, (
            select jsonb_object_agg(ic.column_name, case
                    when ic.data_type in ('numeric', 'double precision', 'integer', 'bigint', 'real') then to_jsonb(0)
                    when ic.data_type = 'boolean' then to_jsonb(false)
                    when ic.data_type in ('text', 'character varying') then to_jsonb(''::text)
                    else 'null'::jsonb end)
              from information_schema.columns ic
             where ic.table_schema = tg_table_schema
               and ic.table_name = tg_table_name
               and ic.column_name = any(cols)));
        if tg_table_name = 'jobs' then
            new.payment_status := 'UNPAID';
            new.contract_total := null;
            -- A token a crew phone chose is a link a crew phone knows.
            new.quote_token := gen_random_uuid();
        end if;
    end if;
    return new;
end $$;

commit;

-- ============================================================================
-- AFTERWARDS: supabase_a4_record_money_probe_live.sql must still show the
-- money columns HELD against a hand write, and
-- supabase_a4_ledger_route_probe_live.sql must show a manager's cash payment
-- reaching the job. Both are rolled back; run them both, because this change
-- is exactly where one of them passing and the other failing is the whole
-- risk.
-- ============================================================================

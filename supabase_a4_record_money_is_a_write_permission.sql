-- ============================================================================
-- DECLARING MONEY RECEIVED IS A WRITE, AND IT NEEDS A WRITE PERMISSION.
--
-- A4 money audit, 20 November 2026. Proved on production inside a rolled-back
-- transaction, as a real MANAGER of his own company, with a cross-company
-- write refused as the positive control (so the write landed UNDER row-level
-- security, not around it):
--
--   does MANAGER hold SEE_MONEY ................................ true
--   update jobs set amount_paid = +12345,
--                   payment_status = 'PAID_IN_FULL' ............ ACCEPTED, 1 row
--   the row afterwards ......................... amount_paid 0 -> 12345
--   CONTROL: same user, a job in ANOTHER company ...... 0 rows, refused
--
-- WHY IT HAPPENS. money_caller_trusted() is
--     claims are empty  OR  is_service_role()  OR  has_permission('SEE_MONEY')
-- and has_permission grants SEE_MONEY to OWNER, MANAGER, SALES and ACCOUNTANT.
-- amount_paid and payment_status are both on job_money_columns(), but that
-- list is only held against callers who do NOT pass money_caller_trusted().
--
-- So a READ permission is being used as the WRITE gate: "may see money" is
-- taken to mean "may declare money received". This project already drew that
-- distinction once -- payment_records writes were separately restricted to
-- REQUEST_PAYMENT / RECORD_REFUNDS -- and the jobs money columns never got it.
--
-- WHAT THIS CHANGES, EXACTLY.
--
--   * A new permission, RECORD_MONEY: "declare money received or returned on
--     a job". Held by OWNER (which is every permission) and ACCOUNTANT. NOT by
--     MANAGER and NOT by SALES. Grant it to a named person the usual way, with
--     a `+RECORD_MONEY` entry in profiles.permission_overrides.
--
--   * Seven columns on `jobs` now need it. They are the ones that say money
--     HAS ARRIVED or HAS GONE BACK -- not the ones that say what a job costs:
--         amount_paid, payment_status, refunded_amount, refunded_at,
--         refund_reason, tip_amount, payments_from_processor
--     A write to any of them from a caller without RECORD_MONEY is reverted to
--     what was already there (and, on INSERT, to nothing), exactly the way the
--     wider money list is already held against a crew phone.
--
--   * Everything else on job_money_columns() is untouched. Managers price
--     jobs: contract_total, the rates, the markup, the tax and the discount
--     stay exactly as reachable as they are today.
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE.
--
--   A manager may still RECORD A PAYMENT -- cash, a check, a transfer -- by
--   writing a payment_records row, which they reach through REQUEST_PAYMENT.
--   The ledger trigger then recomputes jobs.amount_paid from the ledger, so
--   the figure still moves. That is the point: the money is traceable to a
--   row that says who recorded it and when. What is refused is declaring a
--   job paid with NOTHING behind it.
--
--   Whether a manager should be trusted to mark a job paid by hand is his
--   decision. Today it was not a decision anybody made; it was a side effect.
--   This turns it into one line per person.
--
-- SAFE FOR HIS OWN ACCOUNTS: on 20 Nov 2026 production holds 8 OWNER, 2
-- MANAGER and 1 SALES profile, and every one of his own logins is OWNER.
--
-- ONE SHIP NOTE: the Android app's own UI half (hiding the payment-status
-- dropdown and the paid figure from someone without RECORD_MONEY) is in the
-- same change but only reaches a phone when an APK is published. Until then a
-- manager's phone shows the control and the server quietly reverts the write.
--
-- Re-runnable. No data is read or written; only function bodies change.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. The columns that mean MONEY ARRIVED, as their own list.
--
-- Kept separate from job_money_columns() rather than carved out of it, so the
-- wider list keeps its exact shape (tests/a175-money-columns-are-pinned pins
-- it) and so the two questions -- "may this caller see money?" and "may this
-- caller declare it?" -- are answered by two readable lists instead of one
-- list and a special case.
-- ---------------------------------------------------------------------------
create or replace function public.job_received_money_columns()
returns text[]
language sql
immutable
as $$
    select array[
        'amount_paid',              -- what he has been paid
        'payment_status',           -- whether the job reads as settled
        'refunded_amount',          -- what went back
        'refunded_at',
        'refund_reason',
        'tip_amount',               -- money received, by another name
        -- The latch that makes the paid figure read-only in the app. Taking it
        -- off is the first move of typing over the figure, so it belongs with
        -- the figure.
        'payments_from_processor'
    ]
$$;

comment on function public.job_received_money_columns() is
  'The jobs columns that say money HAS ARRIVED or HAS GONE BACK. Writable only '
  'by a caller passing record_money_trusted(). The rest of job_money_columns() '
  'is what a job COSTS, and stays on the SEE_MONEY gate.';

-- ---------------------------------------------------------------------------
-- 2. The gate, mirroring money_caller_trusted() so the two are read side by
--    side. The first two arms are identical and deliberately so: an empty
--    claims object is a migration or a definer context, and the service role
--    is the webhooks, which are the only things that SHOULD be writing these
--    columns in the ordinary course of business.
-- ---------------------------------------------------------------------------
create or replace function public.record_money_trusted()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
    select nullif(current_setting('request.jwt.claims', true), '') is null
        or public.is_service_role()
        or coalesce(public.has_permission('RECORD_MONEY'), false)
$$;

comment on function public.record_money_trusted() is
  'May this caller DECLARE money received or returned? Narrower than '
  'money_caller_trusted(), which only asks whether they may SEE money.';

-- ---------------------------------------------------------------------------
-- 3. RECORD_MONEY exists as a permission.
--
-- The whole body is restated because the live one is the only definition; the
-- ONLY change from the version live on 20 Nov 2026 is RECORD_MONEY added to
-- the ACCOUNTANT list. OWNER holds it already by answering true to everything.
-- MANAGER and SALES deliberately do not have it.
--
-- NOTE ON THE NAME. Overrides are matched by substring (position('+'||perm in
-- overrides)), so no permission name may contain another. RECORD_MONEY
-- contains none of the existing names and none of them contains it --
-- SEE_MONEY is the near miss and does not match, because the search includes
-- the leading sign. EnquiryCaptureTest holds the whole set to that rule.
-- ---------------------------------------------------------------------------
create or replace function public.has_permission(perm text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  with me as (
    select role::text as role_text, coalesce(permission_overrides, '') as overrides
    from profiles where id = auth.uid()
  )
  select case
    when position('-' || perm in (select overrides from me)) > 0 then false
    when position('+' || perm in (select overrides from me)) > 0 then true
    else case (select role_text from me)
      when 'OWNER' then true
      when 'MANAGER' then perm in (
        'SEE_MONEY','SEE_PAY','EDIT_JOBS','EDIT_CATALOG_AND_SETTINGS','SCHEDULE_AND_ASSIGN',
        'REQUEST_PAYMENT','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT','SEE_REPORTS',
        'APPROVE_TIME','APPROVE_PLAN_CHANGES')
      when 'SALES' then perm in ('SEE_MONEY','EDIT_JOBS','SEE_CUSTOMER_CONTACT')
      when 'ACCOUNTANT' then perm in (
        'SEE_MONEY','SEE_PAY','REQUEST_PAYMENT','RECORD_REFUNDS','RECORD_MONEY',
        'SEE_CUSTOMER_CONTACT','SEE_REPORTS')
      when 'FOREMAN' then perm in (
        'SCHEDULE_AND_ASSIGN','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT',
        'APPROVE_TIME','APPROVE_PLAN_CHANGES')
      when 'CREW' then perm in ('RECORD_FIELD_WORK')
      else false
    end
  end;
$$;

-- ---------------------------------------------------------------------------
-- 4. The trigger holds the narrower list against the narrower gate.
--
-- The whole body is restated for the same reason as above. The change is the
-- block marked RECORD_MONEY below; everything else is the version live on
-- 20 Nov 2026, byte for byte.
--
-- SCOPED TO THE DEFAULT LIST ON PURPOSE. This trigger function is also
-- attached to estimate_line_items, change_orders (twice) and material_items,
-- each with an explicit column list in tg_argv -- and those are all PRICES,
-- not money received. `tg_nargs > 0` is what tells the two apart, and the new
-- check only runs when the function is using its own default list, which is
-- the jobs trigger (00_protect_job_money) and nothing else.
-- ---------------------------------------------------------------------------
create or replace function public.hold_money_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    cols text[] := case when tg_nargs > 0 then tg_argv else public.job_money_columns() end;
    received text[] := case when tg_nargs > 0 then array[]::text[]
                            else public.job_received_money_columns() end;
begin
    if public.money_caller_trusted() then
        -- RECORD_MONEY.
        --
        -- Being trusted to SEE money is not being trusted to DECLARE it. A
        -- MANAGER passes the test above -- SEE_MONEY is on their role -- and
        -- could until today write amount_paid and payment_status directly,
        -- with no payment anywhere and no ledger row. Those columns are now
        -- put back exactly as they were unless this caller may record money.
        --
        -- Reverted rather than refused, matching what this function already
        -- does for a crew phone: a sync that carries a column it may not
        -- change must not fail outright, or every other field on the row goes
        -- down with it.
        if coalesce(array_length(received, 1), 0) > 0
           and not public.record_money_trusted() then
            if tg_op = 'UPDATE' then
                new := jsonb_populate_record(new, (
                    select jsonb_object_agg(c, to_jsonb(old) -> c) from unnest(received) c));
            else
                -- A new job may not arrive already paid.
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

-- ---------------------------------------------------------------------------
-- 5. Grants, restated.
--
-- A function whose EXECUTE is revoked makes every policy that calls it throw,
-- and the tables it guards answer 401 -- which this project has already met
-- once. The two new functions are granted the same way their neighbours are.
-- ---------------------------------------------------------------------------
grant execute on function public.job_received_money_columns() to authenticated, anon, service_role;
grant execute on function public.record_money_trusted() to authenticated, anon, service_role;

commit;

-- ============================================================================
-- AFTERWARDS, read-only, to see that it took:
--
--   select public.record_money_trusted();          -- true as service role
--   select unnest(public.job_received_money_columns());
--
-- And the proof that matters, run the same way the finding was proved --
-- inside begin/rollback, impersonating a real MANAGER, with a cross-company
-- write as the positive control:
--   supabase_a4_record_money_probe.sql
-- ============================================================================

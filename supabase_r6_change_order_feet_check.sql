-- ============================================================
-- FenceFlow -- a change order's feet are a real number: finite, not negative
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
-- KIND: TABLE CONSTRAINT on public.change_orders
--       (change_orders_feet_finite_nonnegative). No policy, trigger, function
--       or row changes; nothing is loosened.
-- Apply right after supabase_r6_crew_change_orders.sql.
--
-- WHY (verifier rows O13-O15 and T05, 2026-09-22): additional_feet is double
-- precision, and Postgres takes 'NaN', 'Infinity' and negatives for it.
--   * to_json writes NaN / Infinity as the STRINGS "NaN" / "Infinity". The
--     app's cloudJson (SupabaseModule.kt) does not set
--     allowSpecialFloatingPointValues, so kotlinx refuses that row -- and with
--     it the whole change_orders pull, for every phone in the company.
--   * the feet are billed: labour is charged on the job's feet plus every
--     order's feet (EstimateEngine billableFeet, price-job's
--     change_order_feet). A negative order quietly cuts the labour billed; an
--     infinite one makes the price infinite.
-- crew_push_change_orders skips such rows itself, but a crew login's bare
-- INSERT (PostgREST return=minimal) still passes the change_orders_insert
-- policy and stored NaN (verifier T05). A constraint closes every door at
-- once, the office's included. The app's feet field is a Decimal keyboard
-- (no minus sign) and shows only feet above zero, so no screen writes a
-- value this refuses. Production held 0 change orders on 2026-09-22.
--
-- NaN sorts above Infinity in Postgres, so the one test below refuses NaN,
-- +Infinity, -Infinity and every negative, and accepts 0 and up.
--
-- LOCKS: adding a constraint takes a brief ACCESS EXCLUSIVE lock on
-- change_orders; lock_timeout makes it give up in 5 s rather than queue
-- behind a long transaction (a queued exclusive lock blocks every reader
-- behind it). VALIDATE then scans under SHARE UPDATE EXCLUSIVE, which does
-- not block reads or writes. If it times out, just run the file again.
-- ============================================================

set lock_timeout = '5s';

do $add$
begin
    if not exists (select 1 from pg_constraint
                    where conrelid = 'public.change_orders'::regclass
                      and conname = 'change_orders_feet_finite_nonnegative') then
        alter table public.change_orders
            add constraint change_orders_feet_finite_nonnegative
            check (additional_feet >= 0 and additional_feet < 'Infinity'::double precision) not valid;
    end if;
end $add$;

-- Rows already there: say how many and how to find them, instead of the
-- bare "violated by some row" VALIDATE would give.
do $existing$
declare
    bad int;
begin
    select count(*) into bad from public.change_orders
     where not (additional_feet >= 0 and additional_feet < 'Infinity'::double precision);
    if bad > 0 then
        raise exception '% change order(s) have feet that are negative, NaN or infinite. Find them with: '
                        'select id, company_id, sync_id, job_sync_id, additional_feet from public.change_orders '
                        'where not (additional_feet >= 0 and additional_feet < ''Infinity''::float8); '
                        'set each to its real footage (or 0), then run this file again.', bad;
    end if;
end $existing$;

alter table public.change_orders validate constraint change_orders_feet_finite_nonnegative;

comment on constraint change_orders_feet_finite_nonnegative on public.change_orders is
  'Feet are billed and every phone pulls them: finite and >= 0 (NaN sorts above Infinity, so it is refused too). '
  'supabase_r6_change_order_feet_check.sql';

-- ============================================================
-- Self-check
-- ============================================================
do $check$
declare
    def text;
begin
    select pg_get_constraintdef(c.oid) into def
      from pg_constraint c
     where c.conrelid = 'public.change_orders'::regclass
       and c.conname = 'change_orders_feet_finite_nonnegative'
       and c.contype = 'c' and c.convalidated;
    if def is null then
        raise exception 'change_orders_feet_finite_nonnegative is missing or not validated';
    end if;
    if position('additional_feet >= (0)' in def) = 0 or position('Infinity' in def) = 0 then
        raise exception 'change_orders_feet_finite_nonnegative is not the finite, non-negative test: %', def;
    end if;
end $check$;

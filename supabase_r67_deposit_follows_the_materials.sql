-- ============================================================
-- FenceFlow -- the deposit follows the MATERIALS, not a proportion
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- MARCH, 6 November 2026: "Yes to the deposit re-derivation." And, stating
-- the rule himself: "The deposit should always be more than the material price
-- or else there is an issue."
--
-- WHAT WAS WRONG. supabase_r8 made the deposit follow a re-price by SCALING it
-- in proportion:  new = old_dep / old_total * new_total. That is not the rule.
-- The rule (JobMoney.ruleDeposit, and _shared/quote-deposit.ts, pinned by
-- tests/a29-deposit-rule-vectors.json) is:
--
--     the materials still to be bought, rounded UP to the next $100, plus $100
--
-- The two give different numbers the moment a drawing changes, and the
-- proportional one can land BELOW the materials cost -- which is the contractor
-- fronting material money, the exact thing the rule exists to prevent:
--
--     materials 1,000 -> 2,000 and price 5,000 -> 8,000
--     by the rule:   2,100          by proportion:  1,760   (under the 2,000)
--
-- WHY THIS IS IN THE TRIGGER AND NOT IN price-job.
--
-- The obvious fix -- have price-job put deposit_amount in its own UPDATE --
-- would SILENTLY LOSE OFFLINE EDITS. The four columns in that patch
-- (contract_total, priced_by, priced_at, pricing_engine_version) are on
-- touch_updated_at()'s quiet list precisely so a re-price does not bump the
-- clock; deposit_amount is deliberately NOT on it, because a deposit a person
-- types IS an edit. A fifth, un-quiet column in that statement would bump
-- updated_at and make a phone's unsynced edits look older than the server's
-- row. That is why r8 is a BEFORE trigger named zz_: it sorts AFTER
-- jobs_touch_updated_at, so touch has already decided before the deposit moves.
--
-- SO WHERE DOES THE MATERIALS FIGURE COME FROM? Not from arithmetic repeated
-- in SQL. jobs.materials_to_buy is added here and written by price-job in the
-- same quiet statement as contract_total, exactly as labor_cost already is
-- (r43, and it is on the quiet list for that reason). The engine keeps the one
-- definition of what materials cost; this file only applies the rounding rule
-- to the number the engine stored, plus a plain SUM of change-order material
-- costs -- a column, not a calculation.
--
-- WHAT IS UNCHANGED, because they are the protections and not the formula:
--   * a deposit somebody TYPED is never touched (r65's deposit_is_auto gate)
--   * nothing moves once the customer has approved, signed or paid
--   * a deposit typed in the same statement wins
--   * never above the price
--   * and when materials_to_buy is NULL -- any job not yet re-priced by a
--     server that writes it -- the old proportional scaling still applies, so
--     nothing regresses on the way to the new behaviour.
-- ============================================================

-- ---- 1. where the engine's materials figure is kept -----------------------
alter table public.jobs add column if not exists materials_to_buy numeric;

comment on column public.jobs.materials_to_buy is
  'Materials still to be bought on this job, WITH the sales tax on them, as the '
  'pricing engine computed it: totals.materials_subtotal + totals.tax. Written by '
  'price-job in the same quiet statement as contract_total (like labor_cost, r43), '
  'and read by deposit_follows_price() so the deposit rule does not need the '
  'engine''s arithmetic repeated in SQL. NULL means no server re-price has happened '
  'yet, and the deposit rule falls back to proportional scaling for that job.';

-- jobs carries TABLE-level grants (126 of 126 columns for every role), unlike
-- companies, whose per-column grants once took all company email down when a
-- new column arrived ungranted. Checked before adding this one; nothing to do.

-- ---- 2. the new column must be QUIET ------------------------------------
-- Anchored into the LIVE function rather than retyped, so the rest of the
-- quiet list cannot be lost by a transcription slip. Raises and changes
-- nothing if the anchor has moved.
do $quiet$
declare d text;
begin
    d := pg_get_functiondef('public.touch_updated_at()'::regprocedure);
    if position('materials_to_buy' in d) > 0 then
        raise notice 'materials_to_buy is already on the quiet list';
        return;
    end if;
    if position('''hoa_letter_sent_at''' in d) = 0 then
        raise exception 'touch_updated_at: the anchor ''hoa_letter_sent_at'' is not in the live body; merge this by hand';
    end if;
    d := replace(d,
        '''hoa_letter_sent_at''',
        '''hoa_letter_sent_at'',' || chr(10) ||
        '        -- r67: written by price-job in the same statement as contract_total.' || chr(10) ||
        '        ''materials_to_buy''');
    execute d;
end $quiet$;

-- ---- 3. the rule, in SQL, as a function of its own -----------------------
-- Three lines of rounding, pinned below against the SAME vectors both engines
-- are pinned against. Not the materials arithmetic -- that stays in the engine.
create or replace function public.rule_deposit(outstanding numeric)
returns numeric
language plpgsql
immutable
set search_path to 'public'
as $fn$
declare
    cents numeric;
    hundreds numeric;
begin
    if outstanding is null then return 0; end if;
    -- To cents FIRST, as both engines do: $1,000 of materials arriving as
    -- 999.9999999999999 is $1,000, not a cent over. Float dust must not push a
    -- deposit into the next hundred.
    cents := round(outstanding * 100);
    if cents <= 0 then return 0; end if;
    -- Rounded UP to the next $100 (10,000 cents)...
    hundreds := div(cents + 9999, 10000);
    -- ...and then $100 added. The extra $100 pays for scheduling and transport
    -- and is NEVER itemised on a customer-facing surface.
    return hundreds * 100 + 100;
end $fn$;

-- FROM PUBLIC, not just from anon. A new function carries EXECUTE for PUBLIC
-- by default and anon inherits it, so `revoke ... from anon` alone leaves it
-- callable by anyone -- which this file's own proof caught. Nothing needs a
-- grant back: deposit_follows_price() is SECURITY DEFINER and runs as the
-- owner, so it does not consult these privileges at all.
revoke all on function public.rule_deposit(numeric) from public;
revoke all on function public.rule_deposit(numeric) from anon;
revoke all on function public.rule_deposit(numeric) from authenticated;

-- ---- 4. the trigger re-derives instead of scaling ------------------------
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
    net_paid  numeric := greatest(coalesce(old.amount_paid, 0)::numeric
                                  - coalesce(old.refunded_amount, 0)::numeric, 0);
    customer_is_in_it boolean :=
        ((old.quote_approved_at is not null or old.signed_at is not null)
          and old.reapproval_required_at is null)
        or net_paid > 0.005;
    materials numeric;
    co_materials numeric;
    rule numeric;
    owed numeric;
    wanted numeric;
begin
    if old_total <= 0.005 or old_dep <= 0.005 then
        return new;
    end if;
    -- r65: a deposit somebody typed is theirs and never moves on its own.
    -- Read off OLD; reading NEW would let any writer unlock it in the same
    -- statement.
    if not coalesce(old.deposit_is_auto, false) then
        return new;
    end if;
    if abs(new_total - old_total) <= 0.005 then
        return new;
    end if;
    if abs(coalesce(new.deposit_amount, 0)::numeric - old_dep) > 0.005 then
        return new;
    end if;
    if customer_is_in_it then
        return new;
    end if;
    if new_total <= 0.005 then
        return new;
    end if;

    -- THE RULE. Change-order materials are a plain SUM of a stored column, not
    -- a calculation: the same thing JobMoney.materialsToBuy adds on the phone.
    select coalesce(sum(co.material_cost), 0)::numeric into co_materials
      from public.change_orders co
     where co.company_id = new.company_id
       and co.job_sync_id = new.sync_id
       and co.deleted_at is null;

    materials := coalesce(new.materials_to_buy, old.materials_to_buy);
    if materials is not null then
        materials := materials + co_materials;
        -- INCREMENTAL rule, CUMULATIVE column: the stored deposit is
        -- netPaid + rule, so every reader's own `asked - netPaid` lands back on
        -- the rule's figure. Storing the incremental number in the cumulative
        -- column once took the same payment off twice.
        rule := public.rule_deposit(materials - net_paid);
        if rule <= 0 then
            return new;
        end if;
        owed := round(greatest(new_total - net_paid, 0), 2);
        if owed <= 0.005 then
            return new;
        end if;
        -- Capped at what is still owed, for the existing reason: a deposit
        -- above the job is a bill for money the customer never agreed to.
        wanted := round(net_paid + least(rule, owed), 2);
    else
        -- No engine figure for this job yet. The old proportional scaling,
        -- unchanged, so nothing regresses before price-job starts writing it.
        wanted := least(round(old_dep / old_total * new_total, 2), new_total);
    end if;

    new.deposit_amount := least(wanted, new_total);
    return new;
end $fn$;

drop trigger if exists zz_deposit_follows_price on public.jobs;
create trigger zz_deposit_follows_price
  before update on public.jobs
  for each row execute function public.deposit_follows_price();

-- ============================================================
-- PROOFS
-- ============================================================

-- 4a. THE RULE AGAINST THE SHARED VECTORS. These rows were generated from
-- tests/a29-deposit-rule-vectors.json, the same file the phone's
-- JobMoneyDepositRuleTest and the office's a29 are pinned against.
-- tests/a157 re-reads both and fails if they ever drift apart.
with vectors(outstanding, want) as (values
    (0::numeric, 0::numeric),
    (-550::numeric, 0::numeric),
    (0.004::numeric, 0::numeric),
    (0.01::numeric, 200::numeric),
    (0.5::numeric, 200::numeric),
    (99.99::numeric, 200::numeric),
    (100::numeric, 200::numeric),
    (100.01::numeric, 300::numeric),
    (199.99::numeric, 300::numeric),
    (200::numeric, 300::numeric),
    (999.9999999999999::numeric, 1100::numeric),
    (1000::numeric, 1100::numeric),
    (1000.0000000000001::numeric, 1100::numeric),
    (1000.01::numeric, 1200::numeric),
    (1449.1::numeric, 1600::numeric),
    (1630::numeric, 1800::numeric),
    (3963.44::numeric, 4100::numeric),
    (9999.99::numeric, 10100::numeric),
    (10000::numeric, 10100::numeric)
)
select 'rule_deposit matches every shared vector' as claim,
       (count(*) filter (where public.rule_deposit(outstanding) = want) = count(*))::text as got,
       'true' as want
  from vectors
union all
select 'and there are as many vectors as the JSON holds',
       (select count(*)::text from vectors), '19'
union all
-- CANARY: the comparison can fail. An off-by-one-dollar rule must not match.
select 'CANARY: a rule one dollar out fails these vectors',
       (select (count(*) filter (where public.rule_deposit(outstanding) + 1 = want) = count(*))::text
          from vectors where want > 0),
       'false'
union all
select 'the column exists',
       (select count(*)::text from information_schema.columns
         where table_schema='public' and table_name='jobs' and column_name='materials_to_buy'), '1'
union all
select 'it is on the quiet list',
       (select (position('materials_to_buy' in prosrc) > 0)::text from pg_proc
         where pronamespace='public'::regnamespace and proname='touch_updated_at'), 'true'
union all
select 'the quiet list did NOT lose labor_cost while being edited',
       (select (position('labor_cost' in prosrc) > 0)::text from pg_proc
         where pronamespace='public'::regnamespace and proname='touch_updated_at'), 'true'
union all
select 'nor contract_total, nor hoa_letter_sent_at',
       (select (position('contract_total' in prosrc) > 0
                and position('hoa_letter_sent_at' in prosrc) > 0)::text from pg_proc
         where pronamespace='public'::regnamespace and proname='touch_updated_at'), 'true'
union all
select 'deposit_amount is STILL NOT on the quiet list',
       (select (position('deposit_amount' in prosrc) = 0)::text from pg_proc
         where pronamespace='public'::regnamespace and proname='touch_updated_at'), 'true'
union all
select 'the trigger re-derives: it calls rule_deposit',
       (select (position('rule_deposit' in prosrc) > 0)::text from pg_proc
         where pronamespace='public'::regnamespace and proname='deposit_follows_price'), 'true'
union all
select 'the typed-deposit gate from r65 survived the rewrite',
       (select (position('coalesce(old.deposit_is_auto, false)' in prosrc) > 0)::text from pg_proc
         where pronamespace='public'::regnamespace and proname='deposit_follows_price'), 'true'
union all
select 'so did the customer freeze and the cap',
       (select (position('customer_is_in_it' in prosrc) > 0
                and position('least(wanted, new_total)' in prosrc) > 0)::text from pg_proc
         where pronamespace='public'::regnamespace and proname='deposit_follows_price'), 'true'
union all
select 'the proportional fallback is still there for jobs with no engine figure',
       (select (position('old_dep / old_total * new_total' in prosrc) > 0)::text from pg_proc
         where pronamespace='public'::regnamespace and proname='deposit_follows_price'), 'true'
union all
select 'anon cannot execute rule_deposit',
       (has_function_privilege('anon', 'public.rule_deposit(numeric)', 'execute'))::text, 'false'
union all
select 'zz_ still sorts last, so a re-price is not a clock bump',
       (not exists (select 1 from pg_trigger
                     where tgrelid = 'public.jobs'::regclass and not tgisinternal
                       and tgtype & 2 = 2 and tgname > 'zz_deposit_follows_price'))::text, 'true'
order by 1;

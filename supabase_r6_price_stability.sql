-- ============================================================
-- FenceFlow -- the price a customer accepted stays the price
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   ADDITIVE           jobs.accepted_total (a new, nullable column), the
--                      stamp_accepted_total() trigger function and its trigger;
--                      change_orders.in_accepted_total (new, false by default)
--                      with latch_change_order_acceptance() and
--                      mark_change_orders_accepted() and their triggers;
--                      hold_line_item_takeoff_identity() and its trigger.
--   FUNCTION-REPLACING job_money_columns(), touch_updated_at(),
--                      enforce_delete_permission(), crew_push_line_items().
--   POLICY-ADDING      one RESTRICTIVE insert policy on estimate_line_items
--                      (restrictive: it can only narrow who may insert).
--   No row is deleted, and no existing value is rewritten. The only backfill
--   is at the bottom, COMMENTED OUT, for the owner to decide on. The one
--   UPDATE statement (in mark_change_orders_accepted) runs only when a job is
--   accepted after this is applied, and only ever sets a false flag true.
--
-- APPLY ORDER
--   * BEFORE redeploying quote-view and create-payment-link: both read and
--     write jobs.accepted_total. (Both also fall back to their old behaviour
--     if the column is missing, so a function deployed first degrades rather
--     than breaking every quote link -- but apply this first anyway.)
--   * BEFORE supabase_crew_job_scope.sql, as that file asks. It no longer
--     matters much: crew_push_line_items is patched here the same way that
--     file patches it -- the LIVE body, at a named anchor -- so whichever of
--     the two runs second keeps the other's lines.
--   * With the app release that reads accepted_total (Job.acceptedTotal,
--     JobMoney.anchoredTotal). Old builds ignore the column.
--
-- WHAT WAS WRONG (diag 2026-09-21, "price keeps changing / deposit wrong")
--
--   1. Nothing recorded what the customer agreed to. After acceptance the
--      phones kept pushing their live recompute as contract_total, and the
--      quote page, the payment link and the deposit cap all read that moving
--      figure. Woody was signed at $3,620 and showed $200; job 4598 was
--      signed at $9,710 and its quote page later showed $13,410; Marco was
--      signed at $19,810 with a $10,930 payment link against $9,300. An
--      online approval stored no figure at all (quote-view set only the time
--      and the name). jobs.accepted_total is that figure:
--        * online approval -- quote-view writes the total the page showed,
--          in the same UPDATE as quote_approved_at (see that function);
--        * drawn signature -- stamp_accepted_total() below copies
--          signed_contract_total when signed_at moves. The phone never sends
--          accepted_total (it is pull-only in the app), so the server is the
--          only writer on this path.
--      It is a price, so it joins job_money_columns(): crew never read it
--      (jobs_crew has an explicit column list without it) and never write it
--      (hold_money_columns() and crew_save_job() both drop that list).
--      It is server bookkeeping, so it joins touch_updated_at()'s quiet
--      list -- a stamp must never look like an edit that beats a phone's
--      offline work (the same reason contract_total is quiet).
--
--   2. A MANAGER could never land the tombstones a takeoff makes. A
--      regenerate replaces a run's generated lines and tombstones the ones
--      that went away; enforce_delete_permission() refused every tombstone
--      from a caller without DELETE_RECORDS, which MANAGER does not hold.
--      The phone retried for ever and the pull brought the replaced lines
--      back beside the new ones, counting both (proved by impersonating the
--      MANAGER login in a rolled-back transaction: refused; the owner,
--      as the positive control: 1 row). Replacing generated takeoff lines is
--      editing the estimate, which EDIT_JOBS already covers. The carve-out
--      is exactly that and nothing wider: an EDIT_JOBS caller may tombstone
--      an estimate_line_items row that WAS (old row) auto-generated, has a
--      material role and belongs to a run. A hand-typed extra (role NONE),
--      a line the user edited by hand (auto_generated false), and every other
--      table still need DELETE_RECORDS. CREW and FOREMAN hold no EDIT_JOBS,
--      and crew cannot read line items at all (RESTRICTIVE
--      line_items_money_hidden_from_crew), so "crew never delete" holds.
--
--   3. Crew phones rewrote the office's quantities. crew_push_line_items
--      dropped prices but wrote quantity and description, and a crew phone's
--      takeoff is not the office's: its catalog is money-scrubbed (every
--      price 0, so the product pick breaks ties by sync id and lands on other
--      posts and panels) and its copy of the drawing can be stale. The audit
--      log shows 161 quantity flips between the owner and one crew login,
--      2026-09-17..21: Woody's concrete 3 <-> 85, John Beaunissant's panels
--      402 <-> 177, back and forth on every sync, the price moving with them.
--      No crew screen edits a line item (only the estimate screen does, and
--      crew cannot open it), so for callers without EDIT_JOBS this door now
--      accepts and ignores: it returns 0 and writes nothing. Accepted rather
--      than refused, so a crew phone still on an old build does not retry a
--      refusal for ever. The app stopped using the door in the same release.
--      A crew login could also INSERT lines straight into the table (the
--      insert policy checked only the company); PART 6b closes that too.
--
--   4. A change order could be billed twice. The accepted figure contains
--      every order that existed at acceptance (the engine counts unsigned
--      ones too), and billableTotal adds orders signed after acceptance on top
--      -- so an order unsigned at acceptance and signed later was counted in
--      both. change_orders.in_accepted_total (PART 4b) records which orders an
--      acceptance covered. And an old signature synced after a newer online
--      approval no longer re-stamps the accepted price (PART 4).
--
--   5. The carve-out in 2 judged one statement at a time, so two statements
--      got around it (give a hand-typed extra a role and a run, then delete
--      it). PART 5b holds role and run on such a line for anyone without
--      DELETE_RECORDS.
--
-- NOT HERE, on purpose (owner decisions / other files):
--   * the jobs.created_at repair and the priced_by cosmetic repair from the
--     diagnosis -- listed in the report, not run by a migration;
--   * rewriting any deposit, contract_total or payment link -- customer-facing
--     figures, reviewed by the owner job by job;
--   * a trigger that would pin contract_total to accepted_total -- a policy
--     change the owner has not approved. Old app builds can still push a
--     drifting contract_total; quote-view and create-payment-link now bill
--     against accepted_total while an acceptance stands, so that drift no
--     longer reaches the customer.
--
-- Proof: supabase_r6_price_crew_probe.sql (rolled back, synthetic fixtures,
-- positive control beside every refusal) and tests/r6-price-crew.test.mjs
-- (runs migration + probe in one rolled-back transaction, then again with
-- each piece sabotaged, and the checks guarding that piece must go red).
-- ============================================================


-- ------------------------------------------------------------------------
-- PART 1 -- jobs.accepted_total
-- ------------------------------------------------------------------------
-- numeric and nullable, like contract_total. Null means "nothing anchors
-- the price yet" and every reader then uses contract_total exactly as
-- before, so every job accepted before this existed behaves as it always did.
alter table public.jobs add column if not exists accepted_total numeric;

comment on column public.jobs.accepted_total is
    'The price the customer accepted. Online approval: the total the quote page showed, '
    'written by quote-view with quote_approved_at. Drawn signature: signed_contract_total, '
    'stamped by stamp_accepted_total(). Null = not anchored; readers use contract_total. '
    'A money column (job_money_columns) and quiet (touch_updated_at).';


-- ------------------------------------------------------------------------
-- PART 2 -- job_money_columns() gains accepted_total
-- ------------------------------------------------------------------------
-- The body below is the live one (pg_get_functiondef, 2026-09-21) with one
-- element appended. hold_money_columns() and crew_save_job() read this list
-- at run time, so appending here is what keeps crew from reading or writing
-- the new column. Guarded: if the live list has grown since this file was
-- written, replacing it with this one would silently drop a money column
-- from the crew shield, so the file stops instead.
do $guard$
declare
    missing text[];
begin
    select array_agg(c) into missing
      from unnest(public.job_money_columns()) c
     where c <> all (array[
        'tax_rate_percent', 'markup_percent', 'discount_percent',
        'labor_rate_per_ft', 'labor_flat_fee', 'minimum_job_charge',
        'teardown_flat_fee', 'teardown_rate_per_ft', 'gate_rate_per_ft', 'trash_haul_fee',
        'deposit_amount', 'amount_paid', 'refunded_amount', 'refunded_at', 'refund_reason',
        'payment_status', 'is_invoiced', 'payments_from_processor',
        'contract_total', 'signed_contract_total', 'tip_amount',
        'payment_link_url', 'payment_link_amount',
        'pricing_tier_name', 'supplier_quote_reference',
        'quote_token', 'quote_sent_at', 'quote_viewed_at',
        'accepted_total']);
    if missing is not null then
        raise exception 'job_money_columns() now also lists %, which this file would drop. '
                        'Add them to PART 2 before running it.', missing;
    end if;
end $guard$;

create or replace function public.job_money_columns()
 returns text[]
 language sql
 immutable
as $function$
    select array[
        'tax_rate_percent', 'markup_percent', 'discount_percent',
        'labor_rate_per_ft', 'labor_flat_fee', 'minimum_job_charge',
        'teardown_flat_fee', 'teardown_rate_per_ft', 'gate_rate_per_ft', 'trash_haul_fee',
        'deposit_amount', 'amount_paid', 'refunded_amount', 'refunded_at', 'refund_reason',
        'payment_status', 'is_invoiced', 'payments_from_processor',
        'contract_total', 'signed_contract_total', 'tip_amount',
        'payment_link_url', 'payment_link_amount',
        'pricing_tier_name', 'supplier_quote_reference',
        'quote_token', 'quote_sent_at', 'quote_viewed_at',
        -- The price the customer accepted (r6_price_stability). A price, so
        -- crew never read it and never write it.
        'accepted_total'
    ]
$function$;


-- ------------------------------------------------------------------------
-- PART 3 -- accepted_total is quiet on the edit clock
-- ------------------------------------------------------------------------
-- touch_updated_at() is shared by thirteen tables, so it is not retyped: the
-- LIVE body is read and 'accepted_total' is inserted after 'contract_total'
-- in its quiet array, and nothing else changes. The key exists only on jobs,
-- so every other table is unaffected. Idempotent: a body that already names
-- accepted_total is left alone.
do $quiet$
declare
    d text;
    n int;
begin
    d := pg_get_functiondef('public.touch_updated_at()'::regprocedure);
    if position('''accepted_total''' in d) > 0 then
        return;
    end if;
    select count(*) into n from regexp_matches(d, '''contract_total'',', 'g');
    if n <> 1 then
        raise exception 'touch_updated_at(): ''contract_total'', appears % times in its quiet list, not once. '
                        'Not touched -- add ''accepted_total'' to the quiet array by hand.', n;
    end if;
    execute replace(d, '''contract_total'',', '''contract_total'', ''accepted_total'',');
end $quiet$;


-- ------------------------------------------------------------------------
-- PART 4 -- a drawn signature stamps the price it recorded
-- ------------------------------------------------------------------------
-- The phone writes signed_at and signed_contract_total in one update when the
-- customer signs (EstimateViewModel.captureSignature) and never sends
-- accepted_total, so this is the only writer on that path. A later signature
-- is a later agreement and re-stamps -- LATER than any online approval, that
-- is. A signature taken offline at 10:00 and synced at 12:00, after the
-- customer approved online at 11:00, is an OLDER agreement arriving late: it
-- used to re-stamp anyway, putting the older signed figure over the
-- approval's, and both billableTotal copies then measured extra work from
-- 11:00 against a figure from 10:00 -- change orders signed between the two
-- were treated as already inside it and never billed.
--
-- Online approval is deliberately NOT stamped here. quote-view writes the
-- figure the page showed in the same UPDATE as quote_approved_at, and a
-- trigger cannot tell "the approver wrote this figure" from "the approver
-- left it alone" when the two happen to be equal. A fallback from
-- contract_total got exactly the case that started all this wrong: job 4598,
-- signed at $9,710 on the phone, then approved online at $9,710 while an old
-- build had pushed contract_total to $13,410 -- the equal figure reads as
-- "not written", and the fallback would have anchored the job at $13,410.
-- quote-view is the only writer of quote_approved_at (hold_quote_gate_columns
-- pins it for everyone else), so it is also the only place that needs to.
--
-- Named 12_ so it runs after the 00_ holds and 10_/11_ reapproval triggers
-- (same-event BEFORE triggers fire in name order): it sees signed_at and
-- signed_contract_total as they will be written, after hold_contract_columns
-- has held them for a caller without EDIT_JOBS and hold_money_columns has
-- held the money for a caller without SEE_MONEY. A crew phone therefore can
-- never move either, and never stamps anything.
--
-- An explicit figure from the writer wins: a restore that carries its own
-- accepted_total, or the office correcting it by hand, is kept. Only a
-- money-trusted caller can get a changed accepted_total this far --
-- hold_money_columns has already put it back for anyone else.
--
-- Invoker, not definer: it only reads and writes NEW.
create or replace function public.stamp_accepted_total()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
    explicit boolean;
begin
    if tg_op = 'INSERT' then
        -- A job that reaches the cloud already signed: a phone that took the
        -- signature with no signal and inserts the job afterwards.
        if new.accepted_total is null
           and new.signed_at is not null
           and coalesce(new.signed_contract_total, 0) > 0 then
            new.accepted_total := new.signed_contract_total;
        end if;
        return new;
    end if;

    explicit := new.accepted_total is distinct from old.accepted_total
                and coalesce(new.accepted_total, 0) > 0;

    if new.signed_at is not null
       and new.signed_at is distinct from old.signed_at
       and coalesce(new.signed_contract_total, 0) > 0
       and (new.quote_approved_at is null or new.signed_at >= new.quote_approved_at)
       and not explicit then
        new.accepted_total := new.signed_contract_total;
    end if;
    return new;
end;
$function$;

drop trigger if exists "12_stamp_accepted_total" on public.jobs;
create trigger "12_stamp_accepted_total"
    before insert or update on public.jobs
    for each row execute function public.stamp_accepted_total();


-- ------------------------------------------------------------------------
-- PART 4b -- which change orders an accepted price already contains
-- ------------------------------------------------------------------------
-- The engine counts EVERY change order in the grand total, signed or not, so
-- an accepted figure already contains any order that existed when it was
-- accepted. billableTotal (quote-deposit.ts, JobMoney.anchoredTotal) adds
-- orders signed AFTER acceptance on top of accepted_total -- so an order
-- added while the quote was out, left unsigned, and signed the day after the
-- contract was billed twice: $9,710 accepted with a $900 order inside it
-- became $10,610 on the quote page, the payment link cap and the balance.
-- change_orders.in_accepted_total records that an acceptance covered the
-- order; both billableTotal copies skip an order carrying it.
--
-- Who marks it:
--   * an online approval -- mark_change_orders_accepted() below, the moment
--     quote_approved_at is set (quote-view is its only writer), every live
--     order of the job the server holds then: the page total was the phone's
--     contract_total, which counted exactly those;
--   * a drawn signature -- the phone marks every order it holds in the same
--     transaction as the signature (Repository.recordSignedAcceptance) and
--     sends true; the trigger also marks the server's copies when signed_at
--     or accepted_total moves, which covers an order an old build pushed.
-- It latches: latch_change_order_acceptance() never lets it go back to false,
-- so a phone pushing an older copy of an order cannot unmark it, and a caller
-- who may not see money can neither set nor clear it -- it moves a bill.
alter table public.change_orders add column if not exists in_accepted_total boolean not null default false;

comment on column public.change_orders.in_accepted_total is
    'True once an accepted price (jobs.accepted_total) already contains this order, so billableTotal '
    'never adds it on top again. Set by mark_change_orders_accepted() and by the phone at a signature; '
    'latched by latch_change_order_acceptance(); SEE_MONEY callers only.';

create or replace function public.latch_change_order_acceptance()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
    if tg_op = 'UPDATE' and coalesce(old.in_accepted_total, false) then
        new.in_accepted_total := true;
    elsif not public.money_caller_trusted() then
        new.in_accepted_total := case when tg_op = 'UPDATE' then coalesce(old.in_accepted_total, false) else false end;
    else
        -- A batch that names the column on some rows writes an explicit null
        -- on the others; null is "not marked", never an error.
        new.in_accepted_total := coalesce(new.in_accepted_total, false);
    end if;
    return new;
end;
$function$;

drop trigger if exists "00_latch_change_order_acceptance" on public.change_orders;
create trigger "00_latch_change_order_acceptance"
    before insert or update on public.change_orders
    for each row execute function public.latch_change_order_acceptance();

-- Definer, so the flag lands whoever accepted: quote-view's service role, or
-- the phone user whose signature arrived. It changes nothing but the flag,
-- and only false -> true.
create or replace function public.mark_change_orders_accepted()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
    if (tg_op = 'INSERT' and new.accepted_total is not null)
       or (tg_op = 'UPDATE' and (
               (new.quote_approved_at is not null and new.quote_approved_at is distinct from old.quote_approved_at)
            or (new.signed_at is not null and new.signed_at is distinct from old.signed_at)
            or (new.accepted_total is not null and new.accepted_total is distinct from old.accepted_total))) then
        update public.change_orders co
           set in_accepted_total = true
         where co.company_id = new.company_id
           and co.job_sync_id = new.sync_id
           and co.deleted_at is null
           and not co.in_accepted_total;
    end if;
    return null;
end;
$function$;

drop trigger if exists "90_mark_change_orders_accepted" on public.jobs;
create trigger "90_mark_change_orders_accepted"
    after insert or update on public.jobs
    for each row execute function public.mark_change_orders_accepted();


-- ------------------------------------------------------------------------
-- PART 5 -- a takeoff replacing its own lines is an estimate edit
-- ------------------------------------------------------------------------
-- Shared by seventeen tables (jobs, fence_runs, estimate_line_items,
-- change_orders, ...). Behaviour is byte-for-byte the old one everywhere
-- except estimate_line_items, and there only for the narrow case described
-- in the header. Fields are read through to_jsonb(old), so the other tables
-- never resolve a column they do not have.
--
-- Everything is judged on OLD, the row as it stands before this update:
-- flipping a hand-typed line to auto_generated in the same statement that
-- tombstones it gets nowhere.
--
-- Guarded: replaced only if the live body is still the one this file was
-- written against (compared with whitespace removed), or already this one.
do $guard$
declare
    live text;
begin
    select regexp_replace(p.prosrc, '\s', '', 'g') into live
      from pg_proc p
     where p.oid = 'public.enforce_delete_permission()'::regprocedure;
    if live <> regexp_replace($old$
begin
    if new.deleted_at is not null and old.deleted_at is null then
        if auth.uid() is not null and not has_permission('DELETE_RECORDS') then
            raise exception 'Deleting needs the delete permission';
        end if;
    end if;
    return new;
end $old$, '\s', '', 'g')
       and position('r6_takeoff_line_carve_out' in live) = 0 then
        raise exception 'enforce_delete_permission() has changed since this file was written. '
                        'Not replaced -- merge PART 5 into the live body by hand.';
    end if;
end $guard$;

create or replace function public.enforce_delete_permission()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    o jsonb;
begin
    if new.deleted_at is not null and old.deleted_at is null then
        if auth.uid() is not null and not has_permission('DELETE_RECORDS') then
            -- r6_takeoff_line_carve_out. A takeoff regenerate on a MANAGER
            -- phone tombstones the generated lines it replaces; refusing that
            -- left them in the cloud, and the next pull put them back beside
            -- the new ones, so the price counted both. Replacing generated
            -- lines is editing the estimate (EDIT_JOBS), not deleting a
            -- record. Hand-typed extras (role NONE) and lines a person edited
            -- (auto_generated false) still need DELETE_RECORDS; CREW and
            -- FOREMAN have no EDIT_JOBS.
            if tg_table_name = 'estimate_line_items' and has_permission('EDIT_JOBS') then
                o := to_jsonb(old);
                if coalesce((o->>'auto_generated')::boolean, false)
                   and coalesce(nullif(o->>'role', ''), 'NONE') <> 'NONE'
                   and coalesce(nullif(o->>'fence_run_sync_id', ''), o->>'run_sync_id') is not null then
                    return new;
                end if;
            end if;
            raise exception 'Deleting needs the delete permission';
        end if;
    end if;
    return new;
end $function$;


-- ------------------------------------------------------------------------
-- PART 5b -- a hand-typed line cannot be dressed up in two statements
-- ------------------------------------------------------------------------
-- The carve-out judges OLD, so a one-statement disguise (give a hand-typed
-- extra a role and a run AND tombstone it) is refused. Two statements were
-- not: a MANAGER patched a hand-typed extra to role 'LINE_POST' with a run
-- (1 row), then tombstoned it (1 row) -- any EDIT_JOBS caller could delete
-- any line without DELETE_RECORDS, which is what the carve-out promised not
-- to allow. So for a caller without DELETE_RECORDS, a line with no material
-- role keeps having none, and a line on no run stays on none. A takeoff line
-- can still flip back to auto_generated (the app's "Use suggested"), and
-- every other column moves as before. Callers with DELETE_RECORDS, the
-- service role and direct connections (no JWT) are untouched.
create or replace function public.hold_line_item_takeoff_identity()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
    gains_role boolean;
    gains_run boolean;
begin
    if auth.uid() is null then
        return new;
    end if;
    -- Asked about DELETE_RECORDS only when a held change is actually being
    -- attempted: an ordinary line push never pays for the lookup.
    gains_role := coalesce(nullif(old.role, ''), 'NONE') = 'NONE'
                  and new.role is distinct from old.role;
    gains_run := nullif(old.fence_run_sync_id, '') is null and old.run_sync_id is null
                 and (new.fence_run_sync_id is distinct from old.fence_run_sync_id
                      or new.run_sync_id is distinct from old.run_sync_id);
    if (gains_role or gains_run) and not coalesce(public.has_permission('DELETE_RECORDS'), false) then
        if gains_role then
            new.role := old.role;
        end if;
        if gains_run then
            new.fence_run_sync_id := old.fence_run_sync_id;
            new.run_sync_id := old.run_sync_id;
        end if;
    end if;
    return new;
end;
$function$;

drop trigger if exists "00_hold_line_item_takeoff_identity" on public.estimate_line_items;
create trigger "00_hold_line_item_takeoff_identity"
    before update on public.estimate_line_items
    for each row execute function public.hold_line_item_takeoff_identity();


-- ------------------------------------------------------------------------
-- PART 6 -- crew phones no longer write estimate lines
-- ------------------------------------------------------------------------
-- The LIVE body is read and one early return is inserted directly after the
-- existing permission check, which is the anchor. Nothing else changes: the
-- job existence test that supabase_crew_job_scope.sql anchors on is left
-- exactly as it is, so that file can still find it (once) and add its own
-- line, whichever of the two runs first. Idempotent: a body that already
-- carries the marker is left alone.
do $crewlines$
declare
    d text;
    n int;
    anchor constant text :=
        $re$(raise exception 'Not allowed to write estimate lines' using errcode = '42501';\s+end if;)$re$;
begin
    d := pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure);
    if position('r6_crew_lines_read_only' in d) > 0 then
        return;
    end if;
    select count(*) into n from regexp_matches(d, anchor, 'g');
    if n <> 1 then
        raise exception 'crew_push_line_items: the permission check to anchor on appears % times, not once. '
                        'Not touched -- merge PART 6 by hand.', n;
    end if;
    d := regexp_replace(d, anchor, $rep$\1

    -- r6_crew_lines_read_only. Estimates are priced by people who can edit
    -- jobs. A crew phone re-ran the takeoff from its own copy of the drawing,
    -- with every catalog price scrubbed to zero, and pushed its quantities
    -- through here: the owner's phone and a crew phone overwrote each other
    -- on every sync (161 flips, 2026-09-17..21), and the price moved with
    -- them. No crew screen edits a line item. Accepted and ignored -- 0 rows,
    -- never an error -- so an old crew build's sync stays green instead of
    -- retrying a refusal for ever.
    if not public.has_permission('EDIT_JOBS') then
        return 0;
    end if;$rep$);
    execute d;
end $crewlines$;

-- CREATE OR REPLACE keeps the grants; restated so this file alone says who
-- may call it.
revoke execute on function public.crew_push_line_items(jsonb) from public, anon;
grant  execute on function public.crew_push_line_items(jsonb) to authenticated, service_role;


-- ------------------------------------------------------------------------
-- PART 6b -- ...and not straight into the table either
-- ------------------------------------------------------------------------
-- PART 6 closes the door crew phones used. It was not the only one: the
-- insert policy on estimate_line_items checks only company_id, the
-- restrictive crew policy covers SELECT only, and an insert with
-- return=minimal needs no SELECT. In a rolled-back probe a CREW login
-- inserted 'crew extra' qty 999 and a LINE_POST line qty 500 on a company
-- job (1 row each), and 00_stamp_line_item_price stamped a real catalog
-- price on the second: $8,280 added to a customer's estimate by a caller who
-- cannot see money. "Crew phones no longer write estimate lines" held only
-- for an honest app. Restrictive, so it only ever narrows: an insert now also
-- needs EDIT_JOBS or SEE_MONEY (SEE_MONEY as well, for now, because an
-- accountant's phone -- money, no EDIT_JOBS -- still pushes a line it
-- changed). crew_push_line_items is SECURITY DEFINER and unaffected, and the
-- service role bypasses RLS. Altered in place on a re-run, never dropped, so
-- there is no moment without it.
do $insertpolicy$
begin
    if exists (select 1 from pg_policies
                where schemaname = 'public' and tablename = 'estimate_line_items'
                  and policyname = 'line_items_insert_needs_money_or_edit') then
        alter policy line_items_insert_needs_money_or_edit on public.estimate_line_items
            with check (public.has_permission('EDIT_JOBS') or public.has_permission('SEE_MONEY'));
    else
        create policy line_items_insert_needs_money_or_edit on public.estimate_line_items
            as restrictive for insert to public
            with check (public.has_permission('EDIT_JOBS') or public.has_permission('SEE_MONEY'));
    end if;
end $insertpolicy$;


-- ------------------------------------------------------------------------
-- Self-check. Fails loudly, and the whole file rolls back with it.
-- ------------------------------------------------------------------------
do $check$
declare
    n int;
    nm text;
begin
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'jobs'
                      and column_name = 'accepted_total') then
        raise exception 'jobs.accepted_total is missing';
    end if;
    if not ('accepted_total' = any (public.job_money_columns())) then
        raise exception 'job_money_columns() does not list accepted_total';
    end if;
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'jobs_crew'
                  and column_name = 'accepted_total') then
        raise exception 'jobs_crew exposes accepted_total to crew';
    end if;
    if position('''accepted_total''' in pg_get_functiondef('public.touch_updated_at()'::regprocedure)) = 0 then
        raise exception 'touch_updated_at() does not treat accepted_total as quiet';
    end if;

    select count(*), min(t.tgname) into n, nm
      from pg_trigger t
     where t.tgrelid = 'public.jobs'::regclass and not t.tgisinternal
       and t.tgfoid = 'public.stamp_accepted_total()'::regprocedure;
    if n <> 1 then
        raise exception 'expected one stamp_accepted_total trigger on jobs, found %', n;
    end if;
    -- After every hold, before the clock.
    if exists (select 1 from pg_trigger t
                where t.tgrelid = 'public.jobs'::regclass and not t.tgisinternal
                  and t.tgfoid in ('public.hold_money_columns()'::regprocedure,
                                   'public.hold_contract_columns()'::regprocedure,
                                   'public.hold_reapproval_columns()'::regprocedure)
                  and t.tgname::text collate "C" >= nm collate "C")
       or nm collate "C" >= 'jobs_touch_updated_at' collate "C" then
        raise exception 'trigger % does not sort between the holds and jobs_touch_updated_at', nm;
    end if;

    if position('new.signed_at >= new.quote_approved_at' in
                pg_get_functiondef('public.stamp_accepted_total()'::regprocedure)) = 0 then
        raise exception 'stamp_accepted_total() lets an older signature re-stamp over a later approval';
    end if;

    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'change_orders'
                      and column_name = 'in_accepted_total') then
        raise exception 'change_orders.in_accepted_total is missing';
    end if;
    if (select count(*) from pg_trigger t
         where t.tgrelid = 'public.change_orders'::regclass and not t.tgisinternal
           and t.tgfoid = 'public.latch_change_order_acceptance()'::regprocedure) <> 1 then
        raise exception 'expected one latch_change_order_acceptance trigger on change_orders';
    end if;
    if (select count(*) from pg_trigger t
         where t.tgrelid = 'public.jobs'::regclass and not t.tgisinternal
           and t.tgfoid = 'public.mark_change_orders_accepted()'::regprocedure) <> 1 then
        raise exception 'expected one mark_change_orders_accepted trigger on jobs';
    end if;

    if position('r6_takeoff_line_carve_out' in
                pg_get_functiondef('public.enforce_delete_permission()'::regprocedure)) = 0 then
        raise exception 'enforce_delete_permission() lacks the takeoff-line carve-out';
    end if;
    if (select count(*) from pg_trigger t
         where t.tgrelid = 'public.estimate_line_items'::regclass and not t.tgisinternal
           and t.tgfoid = 'public.hold_line_item_takeoff_identity()'::regprocedure) <> 1 then
        raise exception 'expected one hold_line_item_takeoff_identity trigger on estimate_line_items';
    end if;
    if not exists (select 1 from pg_policies
                    where schemaname = 'public' and tablename = 'estimate_line_items'
                      and policyname = 'line_items_insert_needs_money_or_edit'
                      and permissive = 'RESTRICTIVE' and cmd = 'INSERT') then
        raise exception 'the restrictive insert policy on estimate_line_items is missing';
    end if;

    if position('r6_crew_lines_read_only' in
                pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure)) = 0 then
        raise exception 'crew_push_line_items() lacks the crew early return';
    end if;
    -- supabase_crew_job_scope.sql must still find its anchor exactly once --
    -- unless it has already run, in which case its guard sits in that very
    -- spot (the test reads "... is null and public.can_see_job(...)") and
    -- there is nothing left for it to find.
    select count(*) into n
      from regexp_matches(pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure),
                          $re$where j\.company_id = co and j\.sync_id = \(clean->>'job_sync_id'\)::uuid\s+and j\.deleted_at is null\)$re$,
                          'g');
    if n <> 1 and position('can_see_job' in pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure)) = 0 then
        raise exception 'crew_push_line_items(): the job existence test supabase_crew_job_scope.sql anchors on '
                        'now appears % times', n;
    end if;
end $check$;


-- ------------------------------------------------------------------------
-- OPTIONAL BACKFILL -- the owner's call, not this file's. Left commented.
-- ------------------------------------------------------------------------
-- Anchors jobs signed on a phone before this existed at the figure their
-- signature recorded. A write to the new column only (quiet, so no phone
-- sees it as an edit; phones pick it up through the app's accepted_total
-- pull branch). Jobs approved ONLINE before this existed have no trustworthy
-- figure -- the page total was never stored -- and are not touched: review
-- them by hand (re-approve or re-sign at the right price).
--
-- Review first, read-only:
--   select sync_id, customer_name, status, signed_contract_total, contract_total,
--          deposit_amount, payment_link_amount, amount_paid, signed_at, quote_approved_at
--     from public.jobs
--    where deleted_at is null and accepted_total is null
--      and signed_at is not null and signed_contract_total > 0
--    order by company_id, signed_at;
--
-- update public.jobs set accepted_total = signed_contract_total
--  where accepted_total is null and deleted_at is null
--    and signed_at is not null and signed_contract_total > 0;

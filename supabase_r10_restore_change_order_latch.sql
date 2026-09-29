-- ============================================================
-- FenceFlow -- restoring a withdrawn approval must not cover a change order
-- it never priced
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- STATUS: UNAPPLIED. Nothing in this file has been run against the live
-- database. It is a drafted, reviewed fix, staged for whoever decides to
-- apply it. Two functions are replaced, in place, same signatures, same
-- ACLs -- nothing dropped, nothing deleted, no column added or removed.
--
-- VERIFIED AGAINST THE LIVE DATABASE on 2026-09-28, via
--   npx supabase db query --linked --project-ref newcrgafcptspmapacrx
-- reading pg_proc and pg_trigger directly (never the repo .sql files, which
-- is how four earlier reports this session mis-described this database).
-- The live bodies of both functions below, and the trigger wiring, are
-- byte-identical to what supabase_r6_price_stability.sql (already applied)
-- describes. Both functions are also unique on their tables: exactly one
-- "90_mark_change_orders_accepted" AFTER INSERT OR UPDATE trigger on
-- public.jobs, and exactly one "00_latch_change_order_acceptance" trigger on
-- public.change_orders (172 functions total in public at the time of
-- reading -- a positive control that the pg_proc read itself was not empty).
--
-- ------------------------------------------------------------------------
-- THE HOLE
-- ------------------------------------------------------------------------
-- reapp_restore_approval() puts a withdrawn approval back once the drawing
-- (and, since supabase_r8_restore_proof_whole_job.sql, the whole job) matches
-- what was approved before. Its own UPDATE:
--
--     update public.jobs set
--         quote_approved_at = q.prior_approved_at,   -- null -> a real timestamp
--         ...
--       where id = jid;
--
-- moves jobs.quote_approved_at from null to non-null. That is an ordinary
-- row update, and it fires the ordinary "90_mark_change_orders_accepted"
-- AFTER trigger on public.jobs -- not an explicit call, not a cascade
-- reapp_restore_approval knows about, just the same trigger that fires on
-- every fresh approval. mark_change_orders_accepted(), LIVE body:
--
--     if (tg_op = 'INSERT' and new.accepted_total is not null)
--        or (tg_op = 'UPDATE' and (
--                (new.quote_approved_at is not null and new.quote_approved_at is distinct from old.quote_approved_at)
--             or (new.signed_at is not null and new.signed_at is distinct from old.signed_at)
--             or (new.accepted_total is not null and new.accepted_total is distinct from old.accepted_total))) then
--         update public.change_orders co
--            set in_accepted_total = true
--          where co.company_id = new.company_id
--            and co.job_sync_id = new.sync_id
--            and co.deleted_at is null
--            and not co.in_accepted_total;
--     end if;
--
-- ANSWERING THE KEY QUESTION PLAINLY: no, it does not compare the order's
-- signing time against anything. It marks every unmarked, undeleted change
-- order on the job, full stop. That is correct for the case the trigger was
-- written for -- a FRESH approval, where the engine had already summed every
-- live order (signed or not) into the contract_total the customer just saw
-- and approved (see the comment above this function in
-- supabase_r6_price_stability.sql, PART 4b). It is wrong for a RESTORE,
-- where the price coming back is the OLD one, fixed before the approval was
-- ever withdrawn -- and reapp_restore_approval's own price check only
-- requires today's contract_total to equal that old figure again, which says
-- nothing about what got SIGNED in between. A change order that already
-- existed and was simply signed during the withdrawn window does not move
-- contract_total at all (the engine counts every order, signed or not), so
-- the restore's price check passes right over it, and mark_change_orders_
-- accepted then folds its cost into the reinstated price as if the customer
-- had agreed to that too. They didn't -- the approval being restored predates
-- their signature on that order.
--
-- CONFIRMED, NOT NARROWED: the finding survives. The marking has no time
-- comparison of any kind today.
--
-- ------------------------------------------------------------------------
-- CURRENT LIVE STATE (checked 2026-09-28, SELECT-only, with positive
-- controls so a zero could not be a dead query)
-- ------------------------------------------------------------------------
--   jobs .................................... 21
--   change_orders (all, any state) ..........  0   <- table is EMPTY
--   quote_reapprovals (all) .................  8
--   quote_reapprovals, unresolved (at) ......  4
--
--   Jobs currently ARMED (an unresolved withdrawal whose job carries a
--   change order signed after the withdrawal and not yet marked -- the
--   exact row a future restore would wrongly sweep up): 0
--
--   Jobs where this has ALREADY SPRUNG historically (a RESOLVED withdrawal
--   whose window contains a change order signed inside it that IS marked
--   in_accepted_total): 0
--
-- Both zeros are honest but weak: change_orders has no rows at all in
-- production right now, of any kind, signed or not, so "0 armed" and
-- "0 already sprung" are also what an empty table trivially returns. This is
-- not a table that has been checked and found clean of the pattern -- it is
-- a table nobody has put a change order into yet. Treat "no job is in this
-- state today" as true, and as no stronger than that. It is exactly why the
-- owner asked for this fixed now, before the first change order signed
-- during a withdrawn window meets a restore.
--
-- ------------------------------------------------------------------------
-- THE RULE, THE FIX
-- ------------------------------------------------------------------------
-- The owner's own rule: a customer pays what they agreed to until they agree
-- to something else. An order signed DURING the withdrawn window was never
-- part of the old accepted price -- the customer had no active approval to
-- extend it against -- so it must stay billable after a restore, exactly as
-- it would if the approval were never restored at all.
--
-- Smallest correct change: reapp_restore_approval() records, in a
-- transaction-local setting, the exact moment (quote_reapprovals.at) the
-- approval it is putting back was withdrawn, immediately around its own
-- jobs UPDATE. mark_change_orders_accepted() reads that setting and, only
-- when present, excludes an order signed after it from the sweep. Every
-- other path that can fire this trigger -- a fresh online approval, a drawn
-- signature, an office correction to accepted_total -- never sets it, so
-- current_setting(..., true) returns null and the WHERE clause's added
-- condition is a no-op: those paths are byte-for-byte unchanged.
--
-- WHAT THIS DOES, state by state, on the job a restore is invoked for:
--   * No orders at all -- no-op, exactly as today. Nothing to update either
--     way.
--   * An order signed BEFORE the withdrawal (including one never signed at
--     all) -- unaffected: signed_at <= the withdrawal moment (or null), so
--     it is still marked in_accepted_total = true, same as today. It was
--     already folded into the price the withdrawal recorded
--     (prior_contract_total), so folding it into the restored price is
--     correct, not a bug, and stays that way.
--   * An order signed DURING the withdrawn window -- FIXED: stays
--     in_accepted_total = false. It remains billable through billableTotal's
--     existing "accepted_total, plus change orders signed after acceptance
--     that are not in_accepted_total" rule, same as it would if nothing were
--     ever withdrawn.
--   * An order signed AFTER the restore -- unaffected either way: the
--     restore's own UPDATE has already run and mark_change_orders_accepted
--     already fired before this order existed. Nothing sweeps it up on its
--     own signature; it stays unmarked and billable exactly as any change
--     order signed after an ordinary approval always has.
--   * Two orders straddling (one before the withdrawal, one during it) -- the
--     fix splits them correctly: the first is marked true (folded into the
--     restored price), the second stays false (stays billable). Proven
--     together as one scenario in tests/a16-latch-restore-change-order.test.mjs.
--
-- WHAT THIS DOES TO JOBS THAT ALREADY EXIST: nothing, by construction. This
-- is a trigger-function body replacement, not a data correction -- it changes
-- what happens the NEXT time reapp_restore_approval() runs, never what a
-- past run already wrote to change_orders.in_accepted_total. No UPDATE
-- statement in this file touches an existing row. Checked directly: with
-- change_orders empty in production today (see above), there is no existing
-- row whose in_accepted_total, or whose job's billable total, could possibly
-- move by applying this file -- there is nothing there to move. If that ever
-- changes before this is applied, re-run the two live counts above; a
-- corrective UPDATE to a row already wrongly marked would be a SEPARATE,
-- much more deliberate decision (re-billing something already written off)
-- and is deliberately NOT part of this file.
--
-- ------------------------------------------------------------------------
-- TO UNDO
-- ------------------------------------------------------------------------
-- A function replacement, so undoing it is replacing it back. The exact live
-- bodies this file started from (captured via pg_get_functiondef against the
-- live database on 2026-09-28):
--
--   create or replace function public.mark_change_orders_accepted()
--    returns trigger
--    language plpgsql
--    security definer
--    set search_path to 'public'
--   as $function$
--   begin
--       if (tg_op = 'INSERT' and new.accepted_total is not null)
--          or (tg_op = 'UPDATE' and (
--                  (new.quote_approved_at is not null and new.quote_approved_at is distinct from old.quote_approved_at)
--               or (new.signed_at is not null and new.signed_at is distinct from old.signed_at)
--               or (new.accepted_total is not null and new.accepted_total is distinct from old.accepted_total))) then
--           update public.change_orders co
--              set in_accepted_total = true
--            where co.company_id = new.company_id
--              and co.job_sync_id = new.sync_id
--              and co.deleted_at is null
--              and not co.in_accepted_total;
--       end if;
--       return null;
--   end;
--   $function$;
--
--   create or replace function public.reapp_restore_approval(
--       jid uuid, run_sync uuid, q public.quote_reapprovals)
--   returns boolean
--   language plpgsql
--   security definer
--   set search_path to 'public'
--   as $fn$
--   declare
--       j public.jobs%rowtype;
--       who uuid := auth.uid();
--       who_email text;
--       job_now text;
--   begin
--       select * into j from public.jobs where id = jid;
--       if not found then return false; end if;
--       if q.prior_contract_total is null
--          or j.contract_total is null
--          or abs(j.contract_total::numeric - q.prior_contract_total::numeric) > 0.005 then
--           return false;
--       end if;
--       if coalesce(q.job_takeoff_before, '') <> '' then
--           job_now := public.reapp_job_takeoff(
--               j.sync_id, j.company_id, j.calibration_pixels_per_foot);
--           if coalesce(job_now, '') is distinct from q.job_takeoff_before then
--               return false;
--           end if;
--       end if;
--       select email into who_email from auth.users where id = who;
--       if exists (select 1 from public.quote_reapprovals
--                   where job_id = jid and resolved_at is null
--                     and run_sync_id is distinct from run_sync) then
--           return false;
--       end if;
--       update public.quote_reapprovals
--          set resolved_at = now(),
--              resolved_name = coalesce(q.prior_approved_name, '')
--        where job_id = jid
--          and run_sync_id is not distinct from run_sync
--          and resolved_at is null;
--       perform set_config('app.reapproval_clear', '1', true);
--       update public.jobs set
--           quote_approved_at                  = q.prior_approved_at,
--           quote_approved_name                = coalesce(q.prior_approved_name, ''),
--           quote_approved_without_phone_check = coalesce(q.prior_without_phone_check, false),
--           reapproval_required_at             = null,
--           reapproval_reason                  = ''
--         where id = jid;
--       perform set_config('app.reapproval_clear', '0', true);
--       insert into public.audit_log (
--           company_id, actor, actor_email, table_name, record_id, action,
--           field, old_value, new_value, label)
--       values (
--           j.company_id, who, who_email, 'jobs', j.sync_id::text, 'update',
--           'quote_approved_at', null, q.prior_approved_at::text,
--           coalesce(j.customer_name, ''));
--       insert into public.field_changes (
--           company_id, sync_id, job_sync_id, summary, detail, changed_by, changed_by_role)
--       values (
--           j.company_id, gen_random_uuid()::text, j.sync_id,
--           'Back to the approved drawing',
--           format('The drawing was put back to what %s approved, at the same price, so the approval stands.',
--                  coalesce(nullif(q.prior_approved_name, ''), 'the customer')),
--           coalesce(who_email, 'system'), '');
--       return true;
--   exception when others then
--       perform set_config('app.reapproval_clear', '0', true);
--       raise;
--   end;
--   $fn$;
--
-- (then re-run the two REVOKE/GRANT statements this file also carries, which
-- are already exactly what production has, so re-running them changes
-- nothing.)
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1 -- mark_change_orders_accepted() learns to skip a restore's own
-- withdrawn window
-- ------------------------------------------------------------------------
create or replace function public.mark_change_orders_accepted()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    restore_cutoff timestamptz;
begin
    if (tg_op = 'INSERT' and new.accepted_total is not null)
       or (tg_op = 'UPDATE' and (
               (new.quote_approved_at is not null and new.quote_approved_at is distinct from old.quote_approved_at)
            or (new.signed_at is not null and new.signed_at is distinct from old.signed_at)
            or (new.accepted_total is not null and new.accepted_total is distinct from old.accepted_total))) then

        -- Set by reapp_restore_approval() alone, to the moment
        -- (quote_reapprovals.at) the approval it is putting back was
        -- withdrawn. Absent on every ordinary approval -- a fresh online
        -- approval, a drawn signature, an office correction to
        -- accepted_total -- so current_setting(..., true) reads null and the
        -- extra AND below is a no-op: those paths are unchanged.
        restore_cutoff := nullif(current_setting('app.reapproval_restore_signed_cutoff', true), '')::timestamptz;

        update public.change_orders co
           set in_accepted_total = true
         where co.company_id = new.company_id
           and co.job_sync_id = new.sync_id
           and co.deleted_at is null
           and not co.in_accepted_total
           -- The only change: during a restore, an order signed AFTER the
           -- withdrawal it is undoing never existed, signed, at the price
           -- being put back -- it stays unmarked, and billable. One signed
           -- before the withdrawal (or never signed) was already inside that
           -- price and is marked exactly as it always has been.
           and (restore_cutoff is null or co.signed_at is null or co.signed_at <= restore_cutoff);
    end if;
    return null;
end;
$function$;

-- ------------------------------------------------------------------------
-- PART 2 -- reapp_restore_approval() tells it when, and for what moment
-- ------------------------------------------------------------------------
create or replace function public.reapp_restore_approval(
    jid uuid, run_sync uuid, q public.quote_reapprovals)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
    j public.jobs%rowtype;
    who uuid := auth.uid();
    who_email text;
    job_now text;
begin
    select * into j from public.jobs where id = jid;
    if not found then return false; end if;

    -- The price has to be back too. An approval is a price and a length.
    if q.prior_contract_total is null
       or j.contract_total is null
       or abs(j.contract_total::numeric - q.prior_contract_total::numeric) > 0.005 then
        return false;
    end if;

    -- And the WHOLE job has to be back, not just this fence line. (See
    -- supabase_r8_restore_proof_whole_job.sql for why.)
    if coalesce(q.job_takeoff_before, '') <> '' then
        job_now := public.reapp_job_takeoff(
            j.sync_id, j.company_id, j.calibration_pixels_per_foot);
        if coalesce(job_now, '') is distinct from q.job_takeoff_before then
            return false;
        end if;
    end if;

    select email into who_email from auth.users where id = who;

    -- Is any OTHER fence line on this job still altered? Asked BEFORE
    -- anything is marked settled.
    if exists (select 1 from public.quote_reapprovals
                where job_id = jid and resolved_at is null
                  and run_sync_id is distinct from run_sync) then
        return false;
    end if;

    update public.quote_reapprovals
       set resolved_at = now(),
           resolved_name = coalesce(q.prior_approved_name, '')
     where job_id = jid
       and run_sync_id is not distinct from run_sync
       and resolved_at is null;

    -- NEW: tell mark_change_orders_accepted() the exact moment THIS approval
    -- was withdrawn, so the quote_approved_at transition two lines down
    -- cannot sweep up a change order signed after that moment -- it was
    -- never priced into what is being restored. Local to this transaction
    -- only (the third argument to set_config), cleared in the same two
    -- places app.reapproval_clear already is, including the exception
    -- handler, so a raised error never leaves it set for whatever runs next
    -- on this connection.
    perform set_config('app.reapproval_restore_signed_cutoff', q.at::text, true);

    -- Same escape hatch reapp_withdraw_approval uses, for the same reason:
    -- 11_hold_reapproval_columns pins these columns against every ordinary
    -- caller, and this is not an ordinary caller.
    perform set_config('app.reapproval_clear', '1', true);
    update public.jobs set
        quote_approved_at                  = q.prior_approved_at,
        quote_approved_name                = coalesce(q.prior_approved_name, ''),
        quote_approved_without_phone_check = coalesce(q.prior_without_phone_check, false),
        reapproval_required_at             = null,
        reapproval_reason                  = ''
      where id = jid;
    perform set_config('app.reapproval_clear', '0', true);
    perform set_config('app.reapproval_restore_signed_cutoff', '', true);

    -- On the record, in the same two places a withdrawal is recorded, so a
    -- restored approval is never something that just happened quietly.
    insert into public.audit_log (
        company_id, actor, actor_email, table_name, record_id, action,
        field, old_value, new_value, label)
    values (
        j.company_id, who, who_email, 'jobs', j.sync_id::text, 'update',
        'quote_approved_at', null, q.prior_approved_at::text,
        coalesce(j.customer_name, ''));

    insert into public.field_changes (
        company_id, sync_id, job_sync_id, summary, detail, changed_by, changed_by_role)
    values (
        j.company_id, gen_random_uuid()::text, j.sync_id,
        'Back to the approved drawing',
        format('The drawing was put back to what %s approved, at the same price, so the approval stands.',
               coalesce(nullif(q.prior_approved_name, ''), 'the customer')),
        coalesce(who_email, 'system'), '');

    return true;
exception when others then
    perform set_config('app.reapproval_clear', '0', true);
    perform set_config('app.reapproval_restore_signed_cutoff', '', true);
    raise;
end;
$fn$;

-- ACL restated, not assumed: CREATE OR REPLACE keeps an unchanged function's
-- existing grants, but this file's job is to leave no ambiguity about what
-- production already has -- SECURITY DEFINER, reachable only through the
-- reapproval trigger chain, never as a direct RPC.
revoke all on function public.reapp_restore_approval(
    uuid, uuid, public.quote_reapprovals) from public, anon, authenticated;
grant execute on function public.reapp_restore_approval(
    uuid, uuid, public.quote_reapprovals) to service_role;

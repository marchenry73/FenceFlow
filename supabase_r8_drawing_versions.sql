-- ============================================================
-- FenceFlow -- go back to an earlier drawing, and keep the approval when the
--              drawing you went back to is the one they approved
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   ADDITIVE           two columns on public.quote_reapprovals, both defaulted,
--                      and a new reapp_restores_approved_state() helper.
--   FUNCTION-REPLACING reapp_withdraw_approval() GAINS two defaulted arguments,
--                      so the old one must be dropped first. Its grants are
--                      RE-STATED at the bottom: a plain CREATE resets a
--                      function's ACL, and this one is SECURITY DEFINER and
--                      clears a customer's approval -- it is currently EXECUTE
--                      for postgres and service_role only, and it must stay
--                      that way. reapp_on_run_change() is replaced in place
--                      (same signature, ACL untouched).
--   No row deleted, no column dropped.
--
-- WHAT MARCH ASKED FOR, and what he decided (2026-09-24)
--   "Drawing and job versions you can go back to -- so a change made with the
--   customer not there can be undone." Asked what a restore should do to an
--   approval, he chose the harder of the two: restoring back to what the
--   customer actually approved KEEPS the approval, rather than asking them
--   again for a drawing they have already agreed to.
--
-- WHY THIS IS NOT AN "APPROVE ANYWAY" BUTTON
--   docs/REAPPROVAL_RULE.md says plainly that there must be no office-side way
--   to clear a re-approval, and there is deliberately no server route for one.
--   Nothing here adds one. The approval is put back ONLY when the database can
--   prove the job is the same job the customer approved, on both halves of what
--   they agreed:
--
--     * the TAKEOFF FINGERPRINT after this write equals the fingerprint that
--       was in force when they approved -- which is the takeoff_before of the
--       OLDEST unresolved withdrawal for this run, because before that
--       withdrawal the approval still stood. Same reapp_row_takeoff() the
--       trigger already compares old against new with; nothing new is trusted.
--     * the price is back where it was too: jobs.contract_total within a cent
--       of prior_contract_total, the figure kept on that same withdrawal row.
--       An approval is a price AND a length. Restoring the geometry while the
--       price has moved is not the job they approved, so that still asks again.
--     * every other run on the job is settled. A change can touch two fence
--       lines; putting one back while the other is still altered would restore
--       an approval for a drawing that is still not the approved one.
--
--   If any of the three fails, the withdrawal stands exactly as it does today.
--   There is no flag, no permission and no argument that skips the test.
--
-- WHAT THE SNAPSHOTS ARE FOR
--   quote_reapprovals already records a fingerprint of the takeoff either side
--   of every change -- enough to know THAT the fence moved, not enough to put
--   it back. run_snapshot_before/after carry the encoded geometry itself
--   (points|gates|closedLoop, the same FenceCodec strings the app reads), so
--   "go back" has something to go back TO.
--
--   RETENTION, said out loud because nothing here cleans up: this stores a
--   customer's yard geometry indefinitely, in a table every member of the
--   company can read under its existing RLS. About 70 bytes a row for a
--   typical run. That is a deliberate trade for being able to undo a change
--   made with the customer not present, and it is the reason to keep the
--   snapshot to the run that changed rather than the whole job.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  somewhere to keep the drawing
-- ------------------------------------------------------------------------

alter table public.quote_reapprovals
    add column if not exists run_snapshot_before text not null default '',
    add column if not exists run_snapshot_after  text not null default '';

comment on column public.quote_reapprovals.run_snapshot_before is
  'The run''s encoded geometry before this change: points|gates|closedLoop, the FenceCodec strings the app reads. Empty for an INSERT, and empty on rows written before this column existed.';
comment on column public.quote_reapprovals.run_snapshot_after is
  'The same, after the change. Empty for a DELETE.';

-- ------------------------------------------------------------------------
-- PART 2  is this write putting the approved job back?
--
-- Read-only, so it can be called from the trigger before anything is decided.
-- Returns the withdrawal row whose state is being restored, or nothing.
-- ------------------------------------------------------------------------

create or replace function public.reapp_restores_approved_state(
    jid uuid, run_sync uuid, after_fp text)
returns public.quote_reapprovals
language sql
stable
security definer
set search_path to 'public'
as $fn$
    -- The OLDEST unresolved withdrawal for this run. Its takeoff_before is the
    -- takeoff that was in force when the customer approved, because every later
    -- withdrawal started from a drawing they had never seen.
    select q.* from public.quote_reapprovals q
     where q.job_id = jid
       and q.run_sync_id is not distinct from run_sync
       and q.resolved_at is null
       and q.takeoff_before <> ''
       and q.takeoff_before = after_fp
       and q.prior_approved_at is not null
     order by q.at asc
     limit 1;
$fn$;

revoke all on function public.reapp_restores_approved_state(uuid, uuid, text)
    from public, anon, authenticated;
grant execute on function public.reapp_restores_approved_state(uuid, uuid, text)
    to service_role;

-- ------------------------------------------------------------------------
-- PART 3  put the approval back, when and only when it is provably the same job
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
begin
    select * into j from public.jobs where id = jid;
    if not found then return false; end if;

    -- The price has to be back too. An approval is a price and a length.
    if q.prior_contract_total is null
       or j.contract_total is null
       or abs(j.contract_total::numeric - q.prior_contract_total::numeric) > 0.005 then
        return false;
    end if;

    select email into who_email from auth.users where id = who;

    -- Is any OTHER fence line on this job still altered? Asked BEFORE anything
    -- is marked settled: resolved_at and resolved_name mean "the customer
    -- approved again", and stamping them on a run whose job is still not the
    -- approved job would put a name against an approval that never happened,
    -- in the history the office reads.
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
    raise;
end;
$fn$;

revoke all on function public.reapp_restore_approval(uuid, uuid, public.quote_reapprovals)
    from public, anon, authenticated;
grant execute on function public.reapp_restore_approval(uuid, uuid, public.quote_reapprovals)
    to service_role;

-- ------------------------------------------------------------------------
-- PART 4  reapp_withdraw_approval also keeps the geometry
--
-- The signature gains two defaulted arguments, so the six-argument version is
-- dropped first. Its ACL is re-stated below, not assumed.
-- ------------------------------------------------------------------------

drop function if exists public.reapp_withdraw_approval(uuid, uuid, text, text, text, text);

create or replace function public.reapp_withdraw_approval(
    jid uuid, run_sync uuid, run_label text, kind text, before_fp text, after_fp text,
    before_snap text default '', after_snap text default '')
returns void
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
    j public.jobs%rowtype;
    who uuid := auth.uid();
    who_email text;
    the_reason text;
begin
    select * into j from public.jobs where id = jid;
    if not found or j.quote_approved_at is null then
        return;   -- nothing approved, nothing to withdraw
    end if;

    select email into who_email from auth.users where id = who;

    the_reason := format(
        'The drawing changed on %s after %s approved this quote%s. It needs approving again.',
        to_char(now(), 'YYYY-MM-DD'),
        coalesce(nullif(j.quote_approved_name, ''), 'the customer'),
        case when coalesce(run_label, '') = '' then '' else ' (' || run_label || ')' end);

    -- History FIRST, so a failure here cannot leave an approval cleared with
    -- no record of what it was -- and now with the drawing itself, so the
    -- change can be put back rather than only reported.
    insert into public.quote_reapprovals (
        company_id, job_id, job_sync_id, run_sync_id, run_label, change_kind,
        takeoff_before, takeoff_after, reason, actor, actor_email,
        prior_approved_at, prior_approved_name, prior_without_phone_check,
        prior_contract_total, prior_signed_at, prior_signature_path,
        run_snapshot_before, run_snapshot_after)
    values (
        j.company_id, j.id, j.sync_id, run_sync, coalesce(run_label, ''), kind,
        coalesce(before_fp, ''), coalesce(after_fp, ''), the_reason, who, who_email,
        j.quote_approved_at, coalesce(j.quote_approved_name, ''),
        coalesce(j.quote_approved_without_phone_check, false),
        j.contract_total, j.signed_at, coalesce(j.signature_storage_path, ''),
        coalesce(before_snap, ''), coalesce(after_snap, ''));

    insert into public.audit_log (
        company_id, actor, actor_email, table_name, record_id, action,
        field, old_value, new_value, label)
    values (
        j.company_id, who, who_email, 'jobs', j.sync_id::text, 'update',
        'quote_approved_at', j.quote_approved_at::text, null,
        coalesce(j.customer_name, ''));

    -- The crew's and the office's existing feed. Same table the site changes
    -- already land in, so nobody has to go looking somewhere new.
    insert into public.field_changes (
        company_id, sync_id, job_sync_id, summary, detail, changed_by, changed_by_role)
    values (
        j.company_id, gen_random_uuid()::text, j.sync_id,
        'Quote needs approving again', the_reason,
        coalesce(who_email, 'system'), '');

    -- Now take the approval away. Money columns are deliberately absent from
    -- this UPDATE; so are signed_at and signature_storage_path.
    perform set_config('app.reapproval_clear', '1', true);
    update public.jobs set
        quote_approved_at                  = null,
        quote_approved_name                = '',
        quote_approved_without_phone_check = false,
        reapproval_required_at             = now(),
        reapproval_reason                  = the_reason,
        reapproval_count                   = coalesce(reapproval_count, 0) + 1
    where id = jid;
    perform set_config('app.reapproval_clear', '0', true);
exception when others then
    perform set_config('app.reapproval_clear', '0', true);
    raise;
end;
$fn$;

-- RE-STATED, not assumed: the drop above reset this function's ACL, and a
-- SECURITY DEFINER function that clears a customer's approval must not be
-- callable as an RPC by any API role. It is reachable only through the
-- reapproval_on_drawing_change trigger, which is itself SECURITY DEFINER.
revoke all on function public.reapp_withdraw_approval(
    uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.reapp_withdraw_approval(
    uuid, uuid, text, text, text, text, text, text) to service_role;

-- ------------------------------------------------------------------------
-- PART 5  the snapshot itself
--
-- The app's own encoding, joined, so a restore writes back exactly the strings
-- FenceCodec produced. Deliberately NOT a re-derivation: anything clever here
-- would be a second encoder to keep in step with the first.
-- ------------------------------------------------------------------------

create or replace function public.reapp_run_snapshot(r public.fence_runs)
returns text
language sql
immutable
as $fn$
    select coalesce(r.points_encoded, '') || '|' || coalesce(r.gates_encoded, '')
        || '|' || case when coalesce(r.closed_loop, false) then '1' else '0' end;
$fn$;

-- ------------------------------------------------------------------------
-- PART 6  the trigger: pass the geometry through, and let a restore stand
-- ------------------------------------------------------------------------

create or replace function public.reapp_on_run_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
    j public.jobs%rowtype;
    ppf double precision;
    before_fp text := '';
    after_fp text := '';
    before_snap text := '';
    after_snap text := '';
    kind text;
    r public.fence_runs;
    restoring public.quote_reapprovals;
begin
    r := case when tg_op = 'DELETE' then old else new end;

    select * into j from public.jobs
        where sync_id = r.job_sync_id and company_id = r.company_id;

    -- An unapproved job with an unresolved withdrawal against it is the case
    -- this branch used to swallow: the approval has ALREADY been taken away, so
    -- quote_approved_at is null, and putting the drawing back would have looked
    -- like nothing worth checking. That is exactly when a restore matters.
    if not found then
        return case when tg_op = 'DELETE' then old else new end;
    end if;
    ppf := j.calibration_pixels_per_foot;

    if tg_op = 'INSERT' then
        kind := 'INSERT';
        after_fp := public.reapp_row_takeoff(new, ppf);
        after_snap := public.reapp_run_snapshot(new);
    elsif tg_op = 'DELETE' then
        kind := 'DELETE';
        before_fp := public.reapp_row_takeoff(old, ppf);
        before_snap := public.reapp_run_snapshot(old);
    else
        -- A soft delete is a delete. An undelete puts footage back, which is
        -- just as material.
        before_fp := case when old.deleted_at is not null then ''
                          else public.reapp_row_takeoff(old, ppf) end;
        after_fp  := case when new.deleted_at is not null then ''
                          else public.reapp_row_takeoff(new, ppf) end;
        before_snap := case when old.deleted_at is not null then ''
                            else public.reapp_run_snapshot(old) end;
        after_snap  := case when new.deleted_at is not null then ''
                            else public.reapp_run_snapshot(new) end;
        kind := case
            when old.deleted_at is null and new.deleted_at is not null then 'DELETE'
            when old.deleted_at is not null and new.deleted_at is null then 'INSERT'
            else 'UPDATE' end;
    end if;

    -- A restore is judged BEFORE the "nothing approved" shortcut, because a
    -- restore happens precisely when the approval is already gone.
    if j.quote_approved_at is null and coalesce(after_fp, '') <> '' then
        restoring := public.reapp_restores_approved_state(j.id, r.sync_id, after_fp);
        if restoring.id is not null then
            perform public.reapp_restore_approval(j.id, r.sync_id, restoring);
            return case when tg_op = 'DELETE' then old else new end;
        end if;
    end if;

    -- Unapproved job: nothing to protect. This is the branch that leaves
    -- ordinary quoting completely untouched.
    if j.quote_approved_at is null then
        return case when tg_op = 'DELETE' then old else new end;
    end if;

    -- An empty run arriving or leaving changes no number on the estimate.
    if coalesce(before_fp, '') = '' and public.reapp_is_empty(coalesce(after_fp, 'x')) then
        return case when tg_op = 'DELETE' then old else new end;
    end if;
    if coalesce(after_fp, '') = '' and public.reapp_is_empty(coalesce(before_fp, 'x')) then
        return case when tg_op = 'DELETE' then old else new end;
    end if;
    -- The whole point: same takeoff, same fence, approval stands.
    if before_fp = after_fp then
        return case when tg_op = 'DELETE' then old else new end;
    end if;

    perform public.reapp_withdraw_approval(
        j.id, r.sync_id, coalesce(r.label, ''), kind, before_fp, after_fp,
        before_snap, after_snap);

    return case when tg_op = 'DELETE' then old else new end;
end;
$fn$;

-- ------------------------------------------------------------------------
-- PART 7  prove what landed. Every row must read true.
-- ------------------------------------------------------------------------

select 'the two snapshot columns exist' as check,
       (select count(*) = 2 from information_schema.columns
         where table_schema = 'public' and table_name = 'quote_reapprovals'
           and column_name in ('run_snapshot_before', 'run_snapshot_after')) as ok
union all
select 'reapp_withdraw_approval now takes eight arguments',
       exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                and proname = 'reapp_withdraw_approval' and pronargs = 8)
union all
select 'and the six-argument one is gone',
       not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                    and proname = 'reapp_withdraw_approval' and pronargs = 6)
union all
-- The ACL the drop reset. If this reads false, a SECURITY DEFINER function that
-- clears a customer's approval is callable as an RPC.
select 'no API role can execute reapp_withdraw_approval',
       not exists (select 1 from pg_proc p, unnest(p.proacl::text[]) a
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname = 'reapp_withdraw_approval'
                      and (a like '=%' or a like 'anon=%' or a like 'authenticated=%'))
union all
select 'nor reapp_restore_approval, which puts one back',
       not exists (select 1 from pg_proc p, unnest(p.proacl::text[]) a
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname in ('reapp_restore_approval', 'reapp_restores_approved_state')
                      and (a like '=%' or a like 'anon=%' or a like 'authenticated=%'))
union all
select 'the drawing trigger is still attached',
       exists (select 1 from pg_trigger where tgrelid = 'public.fence_runs'::regclass
                and tgname = 'reapproval_on_drawing_change' and not tgisinternal)
union all
-- The price half of the test. If this ever reads false, a restore could put an
-- approval back on a job whose price has moved since.
select 'a restore checks the price as well as the drawing',
       (select position('prior_contract_total' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'reapp_restore_approval')
union all
-- CANARY: the lookup must be able to find NOTHING. A function that returned a
-- row for any input would restore approvals it has no business restoring.
select 'CANARY: the restore lookup finds nothing for a fingerprint nobody has',
       (public.reapp_restores_approved_state(
            '00000000-0000-0000-0000-000000000000'::uuid,
            '00000000-0000-0000-0000-000000000000'::uuid,
            'no-such-takeoff-fingerprint')).id is null;

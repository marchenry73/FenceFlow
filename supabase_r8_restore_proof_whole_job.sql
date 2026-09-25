-- ============================================================
-- FenceFlow -- the restore proof looks at the WHOLE job, not one fence line
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   ADDITIVE. One column on public.quote_reapprovals, defaulted. Three functions
--   replaced in place (same signatures, ACLs untouched). No column dropped, no
--   row deleted, no behaviour removed -- the proof only ever gets stricter.
--
-- THE HOLE
--   supabase_r8_drawing_versions.sql lets a restore put a customer's approval
--   back when the write is provably the job they approved. Its third guard is
--   "no other run on this job is still unresolved", and that guard reads
--   quote_reapprovals rows. But reapp_on_run_change returns early on a job whose
--   approval is ALREADY gone, so a run inserted or soft-deleted while the job sat
--   unapproved never writes a withdrawal row at all -- and a guard that counts
--   rows cannot see a change that wrote none.
--
--   Concretely, and a reviewer walked it through: withdraw the approval by
--   changing run A, soft-delete run B from the office, let no phone sync, then
--   restore run A. Run A's takeoff matches, contract_total still matches --
--   nothing recomputed it, because the office does not price a job whose runs
--   just changed underneath it -- and there is no unresolved row for B. The
--   approval comes back, with its original timestamp, on a job that is now
--   missing a whole fence line the customer never saw.
--
-- WHY NOT THE OBVIOUS FIX
--   The tempting version is "refuse if any run was created or deleted after
--   prior_approved_at". public.fence_runs has no created_at column (checked, 25
--   September), so an inserted run cannot be dated at all, and updated_at is
--   written by the phones rather than only by the server. A rule built on it
--   would be a rule that passes for the wrong reason.
--
-- WHAT THIS DOES INSTEAD
--   Records, on the withdrawal row, a fingerprint of the WHOLE job as it stood
--   while the approval was in force -- every live run's takeoff, sorted -- and
--   requires the whole job to match that again before an approval is handed back.
--
--   A run added, removed, undeleted or altered anywhere on the job changes that
--   fingerprint, whether or not it ever wrote a withdrawal row. It closes the
--   class rather than the one path a reviewer happened to walk.
--
--   Built from reapp_run_takeoff, the same function the single-run proof already
--   uses, so the two cannot drift apart. The changed run contributes its
--   BEFORE takeoff (it is already written by the time the trigger runs) and every
--   other live run contributes its current one. An empty before -- an INSERT,
--   where the run did not exist yet -- contributes nothing, which is exactly
--   right: the job then had one fewer fence line.
--
-- WHAT IT DOES NOT DO, said plainly
--   * Withdrawals recorded BEFORE this file carry an empty job fingerprint.
--     There is nothing to compare them against and no way to reconstruct one, so
--     they fall back to the old proof and the hole above stays open for exactly
--     those rows. Restoring from a change recorded after today is strictly safer
--     than one recorded before it. Nothing pretends otherwise.
--   * calibration_pixels_per_foot is still on the JOB. A re-calibrated grid
--     moves every run's takeoff, so the fingerprint will not match and the
--     approval will not return -- which is correct, and is why neither the app
--     nor the office may ever promise it will.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  somewhere to keep the whole job's shape
-- ------------------------------------------------------------------------

alter table public.quote_reapprovals
    add column if not exists job_takeoff_before text not null default '';

comment on column public.quote_reapprovals.job_takeoff_before is
  'A fingerprint of every live run on the job as it stood while the approval was in force: each run''s reapp_run_takeoff, sorted, newline-joined. Empty on rows written before this column existed, and an empty value means the whole-job proof cannot be applied to that row.';

-- ------------------------------------------------------------------------
-- PART 2  the fingerprint of a whole job
--
-- [skip_run] is the run whose own takeoff the caller is supplying separately,
-- because at withdrawal time its new value is already written and at restore
-- time nothing needs replacing. [extra] is that supplied takeoff, left out when
-- empty so an INSERT does not contribute a phantom line.
-- ------------------------------------------------------------------------

create or replace function public.reapp_job_takeoff(
    job_sync uuid, company uuid, ppf double precision,
    skip_run uuid default null, extra text default '')
returns text
language sql
stable
security definer
set search_path to 'public'
as $fn$
    -- Sorted, so two jobs with the same runs in a different order fingerprint
    -- the same. Newline-joined because a takeoff already contains '|' and '='.
    select string_agg(t, E'\n' order by t)
      from (
        select public.reapp_row_takeoff(r, ppf) as t
          from public.fence_runs r
         where r.job_sync_id = job_sync
           and r.company_id = company
           and r.deleted_at is null
           and (skip_run is null or r.sync_id is distinct from skip_run)
        union all
        select extra where coalesce(extra, '') <> ''
      ) parts;
$fn$;

revoke all on function public.reapp_job_takeoff(uuid, uuid, double precision, uuid, text)
    from public, anon, authenticated;
grant execute on function public.reapp_job_takeoff(uuid, uuid, double precision, uuid, text)
    to service_role;

-- ------------------------------------------------------------------------
-- PART 3  record it when the approval is withdrawn
--
-- The signature gains one defaulted argument, so the eight-argument version is
-- dropped first and the ACL is RE-STATED below -- a plain CREATE resets it, and
-- this is a SECURITY DEFINER function that clears a customer's approval.
-- ------------------------------------------------------------------------

drop function if exists public.reapp_withdraw_approval(
    uuid, uuid, text, text, text, text, text, text);

create or replace function public.reapp_withdraw_approval(
    jid uuid, run_sync uuid, run_label text, kind text, before_fp text, after_fp text,
    before_snap text default '', after_snap text default '', job_fp text default '')
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

    -- History FIRST, so a failure here cannot leave an approval cleared with no
    -- record of what it was -- with the drawing itself, so the change can be put
    -- back, and now with the whole job's shape, so putting it back can be proved
    -- to have put the whole job back.
    insert into public.quote_reapprovals (
        company_id, job_id, job_sync_id, run_sync_id, run_label, change_kind,
        takeoff_before, takeoff_after, reason, actor, actor_email,
        prior_approved_at, prior_approved_name, prior_without_phone_check,
        prior_contract_total, prior_signed_at, prior_signature_path,
        run_snapshot_before, run_snapshot_after, job_takeoff_before)
    values (
        j.company_id, j.id, j.sync_id, run_sync, coalesce(run_label, ''), kind,
        coalesce(before_fp, ''), coalesce(after_fp, ''), the_reason, who, who_email,
        j.quote_approved_at, coalesce(j.quote_approved_name, ''),
        coalesce(j.quote_approved_without_phone_check, false),
        j.contract_total, j.signed_at, coalesce(j.signature_storage_path, ''),
        coalesce(before_snap, ''), coalesce(after_snap, ''), coalesce(job_fp, ''));

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
    uuid, uuid, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.reapp_withdraw_approval(
    uuid, uuid, text, text, text, text, text, text, text) to service_role;

-- ------------------------------------------------------------------------
-- PART 4  require it when the approval is handed back
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

    -- And the WHOLE job has to be back, not just this fence line.
    --
    -- The per-run test below cannot see a run added or removed while the job was
    -- already unapproved, because no withdrawal row is written then -- so run A
    -- could be restored onto a job whose run B had quietly gone, and the
    -- approval would return naming a job the customer never saw. This compares
    -- every live run's takeoff against the shape recorded while the approval
    -- stood.
    --
    -- Empty means the withdrawal predates the column. There is nothing to
    -- compare and no way to reconstruct it, so those rows keep the older, weaker
    -- proof rather than becoming unrestorable -- and the file header says so.
    if coalesce(q.job_takeoff_before, '') <> '' then
        job_now := public.reapp_job_takeoff(
            j.sync_id, j.company_id, j.calibration_pixels_per_foot);
        if coalesce(job_now, '') is distinct from q.job_takeoff_before then
            return false;
        end if;
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
-- PART 5  the trigger passes the whole job's shape through
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

    -- The whole job as it stood a moment ago: this run's BEFORE takeoff, plus
    -- every other live run exactly as it is, since this write touched only one.
    perform public.reapp_withdraw_approval(
        j.id, r.sync_id, coalesce(r.label, ''), kind, before_fp, after_fp,
        before_snap, after_snap,
        coalesce(public.reapp_job_takeoff(
            j.sync_id, j.company_id, ppf, r.sync_id, before_fp), ''));

    return case when tg_op = 'DELETE' then old else new end;
end;
$fn$;

-- ------------------------------------------------------------------------
-- PART 6  prove what landed. Every row must read true.
-- ------------------------------------------------------------------------

select 'the job-shape column exists' as check,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'quote_reapprovals'
                  and column_name = 'job_takeoff_before') as ok
union all
select 'reapp_withdraw_approval now takes nine arguments',
       exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                and proname = 'reapp_withdraw_approval' and pronargs = 9)
union all
select 'and the eight-argument one is gone',
       not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
                    and proname = 'reapp_withdraw_approval' and pronargs = 8)
union all
-- The ACL the drop reset. If this reads false, a SECURITY DEFINER function that
-- clears a customer's approval is callable as an RPC.
select 'no API role can execute any of the three approval functions',
       not exists (select 1 from pg_proc p, unnest(p.proacl::text[]) a
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname in ('reapp_withdraw_approval', 'reapp_restore_approval',
                                        'reapp_restores_approved_state', 'reapp_job_takeoff')
                      and (a like '=%' or a like 'anon=%' or a like 'authenticated=%'))
union all
select 'the restore now consults the whole job',
       (select position('reapp_job_takeoff' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'reapp_restore_approval')
union all
select 'and the withdrawal records it',
       (select position('reapp_job_takeoff' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'reapp_on_run_change')
union all
select 'the drawing trigger is still attached',
       exists (select 1 from pg_trigger where tgrelid = 'public.fence_runs'::regclass
                and tgname = 'reapproval_on_drawing_change' and not tgisinternal)
union all
-- Read-only, against real rows: the fingerprint of a job with runs is not empty,
-- and leaving a run out of it changes the answer. If the second reads false the
-- comparison cannot notice a missing fence line, which is the entire point.
select 'a real job fingerprints to something',
       (select public.reapp_job_takeoff(j.sync_id, j.company_id, j.calibration_pixels_per_foot) is not null
          from public.jobs j
         where exists (select 1 from public.fence_runs r
                        where r.job_sync_id = j.sync_id and r.company_id = j.company_id
                          and r.deleted_at is null)
         limit 1)
union all
select 'CANARY: leaving one run out changes that fingerprint',
       (select public.reapp_job_takeoff(j.sync_id, j.company_id, j.calibration_pixels_per_foot)
               is distinct from
               public.reapp_job_takeoff(j.sync_id, j.company_id, j.calibration_pixels_per_foot,
                                        (select r.sync_id from public.fence_runs r
                                          where r.job_sync_id = j.sync_id and r.company_id = j.company_id
                                            and r.deleted_at is null limit 1))
          from public.jobs j
         where (select count(*) from public.fence_runs r
                 where r.job_sync_id = j.sync_id and r.company_id = j.company_id
                   and r.deleted_at is null) >= 1
         limit 1)
union all
select 'withdrawals recorded before today carry an empty shape, as the header says',
       (select bool_and(coalesce(job_takeoff_before, '') = '') from public.quote_reapprovals);

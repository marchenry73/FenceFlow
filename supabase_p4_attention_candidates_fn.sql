-- The detection logic itself, moved server-side, for the high-severity
-- detectors named in the audit: money already at risk or already gone, a
-- crew about to be sent to a job that is not ready, and an 811/permit/HOA
-- gap. This is a READ-ONLY function -- it does not write automation_flags,
-- automation_runs, jobs, or anything else. supabase/functions/attention-
-- sweep/index.ts calls this, writes what it returns into attention_findings
-- (supabase_p4_attention_findings.sql) with the dedup that table provides,
-- and sends push for anything newly written.
--
-- Every predicate below is copied verbatim from its ALERT_DEFS push site in
-- website/dashboard.html (line numbers as of this writing; re-check them if
-- this function is ever touched, because THE OFFICE PAGE STAYS THE SOURCE
-- OF TRUTH for what these mean -- this function mirrors it, the same
-- relationship run_automation_rule() already has with the office's own
-- automation predicates per supabase_automation.sql's header comment. If
-- the office predicate changes and this does not, the two silently
-- disagree, which is worse than neither existing):
--
--   dispute_open            dashboard.html:7700
--   no_deposit               dashboard.html:7782
--   paid_then_declined       dashboard.html:7851
--   payment_failed           dashboard.html:7985 (reads job_payments;
--                              job_payments.job_sync_id is uuid, matches
--                              jobs.sync_id directly, no cast needed)
--   materials_missing        dashboard.html:7752
--   unassigned_scheduled     dashboard.html:7815
--   hoa_missing               dashboard.html:7886
--   permit_missing            dashboard.html:7897
--   locate_never_requested   dashboard.html:7912
--
-- NOT moved -- stays office-only, on purpose:
--   scheduled_but_blocked   is a derived aggregate of jobReadiness()'s full
--     11-item checklist (dashboard.html:13013), which also covers approval,
--     signature, measured-runs and price-confirmation -- lower-urgency
--     conditions this pass does not raise individually either. Reproducing
--     the whole checklist here risks drifting from jobReadiness() itself
--     (which the job sheet's own "what's blocking this" panel calls) and
--     would double-notify on top of materials_missing/unassigned_scheduled/
--     hoa_missing/permit_missing above, which already cover its highest-
--     severity components. Left as a dashboard-only view for now; a future
--     pass could move it once jobReadiness() has a single SQL-side home.
--   uncontacted_lead, stale_quote, unsigned_approved, needs_reapproval,
--   labour_over, material_over_budget, job_overrun, clocked_in_long/
--   finished, correction_awaiting_answer/disputed, stage_stalled,
--   unverified_prices, approved_unscheduled: none of these is money already
--   moved, a crew dispatched to an unready job, or a legal/safety deadline
--   (ALERT_SEVERITY in dashboard.html already ranks every one of these
--   below the nine above) -- they stay exactly as they are today, detected
--   only while a dashboard tab is open.
--
-- Scoped to companies that have BOTH turned the sweep on
-- (attention_sweep_settings.enabled = true) AND are allowed to use the
-- product at all (company_allowed()) -- a suspended company does not get
-- FenceFlow spending FCM sends on their behalf, same reasoning
-- send-follow-ups already applies to email.
--
-- SECURITY DEFINER because this reads across every company's jobs and
-- job_payments in one pass -- RLS would otherwise restrict it to whichever
-- company happens to be the caller's own. Restricted to service_role only:
-- this returns money and legal-liability data for every company at once,
-- and must never be callable by an ordinary authenticated user.
create or replace function public.attention_sweep_candidates()
returns table (
    company_id  uuid,
    job_sync_id uuid,
    detector    text,
    severity    text,
    message     text,
    fp          text
)
language sql stable security definer set search_path to 'public'
as $$
  with eligible_companies as (
    select s.company_id
      from public.attention_sweep_settings s
     where s.enabled = true
       and public.company_allowed(s.company_id) is true
  )

  -- dispute_open -- a chargeback: the money is already gone.
  select j.company_id, j.sync_id, 'dispute_open', 'critical',
         'Chargeback on ' || coalesce(j.customer_name, 'a job')
           || case when j.dispute_amount is not null then ' (' || to_char(j.dispute_amount, 'FM999,999,990.00') || ')' else '' end,
         j.updated_at::text
    from public.jobs j
    join eligible_companies ec on ec.company_id = j.company_id
   where j.deleted_at is null and j.is_test_fixture = false
     and j.dispute_opened_at is not null and j.dispute_closed_at is null

  union all
  -- no_deposit -- approved, deposit agreed, nothing collected.
  select j.company_id, j.sync_id, 'no_deposit', 'critical',
         'Approved with no deposit collected: ' || coalesce(j.customer_name, 'a job'),
         j.updated_at::text
    from public.jobs j
    join eligible_companies ec on ec.company_id = j.company_id
   where j.deleted_at is null and j.is_test_fixture = false
     and j.quote_approved_at is not null
     and coalesce(j.deposit_amount, 0) > 0.005
     and greatest(coalesce(j.amount_paid, 0) - coalesce(j.refunded_amount, 0), 0) < 0.005

  union all
  -- paid_then_declined -- money came in, job still reads declined.
  select j.company_id, j.sync_id, 'paid_then_declined', 'critical',
         'Money collected on a declined job: ' || coalesce(j.customer_name, 'a job'),
         j.updated_at::text
    from public.jobs j
    join eligible_companies ec on ec.company_id = j.company_id
   where j.deleted_at is null and j.is_test_fixture = false
     and j.status = 'DECLINED'
     and greatest(coalesce(j.amount_paid, 0) - coalesce(j.refunded_amount, 0), 0) > 0.005

  union all
  -- payment_failed -- a real charge attempt was declined or cancelled.
  -- Bounded to the last 30 days (the office page bounds this to its own
  -- "recent" load window; the sweep runs far more often than someone opens
  -- the tab, so a wider bound here costs nothing -- dedup on (job_payments
  -- row's status, created_at) is what actually stops repeat notifications,
  -- not the window).
  select j.company_id, j.sync_id, 'payment_failed', 'critical',
         'Payment attempt ' || jp.status || ' (' || to_char(jp.amount_cents / 100.0, 'FM999,999,990.00') || '): '
           || coalesce(j.customer_name, 'a job'),
         jp.status || '|' || jp.id::text
    from public.job_payments jp
    join public.jobs j on j.sync_id = jp.job_sync_id and j.company_id = jp.company_id
    join eligible_companies ec on ec.company_id = j.company_id
   where j.deleted_at is null and j.is_test_fixture = false
     and jp.status in ('failed', 'canceled')
     and jp.created_at >= now() - interval '30 days'

  union all
  -- materials_missing -- scheduled within 7 days, materials not ready.
  select j.company_id, j.sync_id, 'materials_missing', 'critical',
         'Scheduled ' || to_char(j.scheduled_date, 'YYYY-MM-DD') || ' with materials not ready: '
           || coalesce(j.customer_name, 'a job'),
         coalesce(j.materials_status, 'NOT_ORDERED') || '|' || j.scheduled_date::text
    from public.jobs j
    join eligible_companies ec on ec.company_id = j.company_id
   where j.deleted_at is null and j.is_test_fixture = false
     and j.scheduled_date is not null
     and j.scheduled_date >= now() and j.scheduled_date < now() + interval '7 days'
     and coalesce(j.materials_status, 'NOT_ORDERED') not in ('RECEIVED', 'NOT_NEEDED')

  union all
  -- unassigned_scheduled -- a date on the calendar, nobody assigned.
  select j.company_id, j.sync_id, 'unassigned_scheduled', 'critical',
         'Scheduled ' || to_char(j.scheduled_date, 'YYYY-MM-DD') || ' with nobody assigned: '
           || coalesce(j.customer_name, 'a job'),
         j.scheduled_date::text
    from public.jobs j
    join eligible_companies ec on ec.company_id = j.company_id
   where j.deleted_at is null and j.is_test_fixture = false
     and j.scheduled_date is not null and j.scheduled_date >= now()
     and j.assigned_employee_id is null
     and j.status is distinct from 'DECLINED'

  union all
  -- hoa_missing -- scheduled, HOA not NOT_REQUIRED/APPROVED.
  select j.company_id, j.sync_id, 'hoa_missing', 'critical',
         'HOA ' || lower(replace(j.hoa_approval_status, '_', ' ')) || ' for a job scheduled '
           || to_char(j.scheduled_date, 'YYYY-MM-DD') || ': ' || coalesce(j.customer_name, 'a job'),
         coalesce(j.hoa_approval_status, '') || '|' || j.scheduled_date::text
    from public.jobs j
    join eligible_companies ec on ec.company_id = j.company_id
   where j.deleted_at is null and j.is_test_fixture = false
     and j.scheduled_date is not null
     and j.status not in ('COMPLETED', 'DECLINED')
     and j.hoa_approval_status is not null
     and j.hoa_approval_status not in ('NOT_REQUIRED', 'APPROVED')

  union all
  -- permit_missing -- same shape, for a permit.
  select j.company_id, j.sync_id, 'permit_missing', 'critical',
         'Permit ' || lower(replace(j.permit_status, '_', ' ')) || ' for a job scheduled '
           || to_char(j.scheduled_date, 'YYYY-MM-DD') || ': ' || coalesce(j.customer_name, 'a job'),
         coalesce(j.permit_status, '') || '|' || j.scheduled_date::text
    from public.jobs j
    join eligible_companies ec on ec.company_id = j.company_id
   where j.deleted_at is null and j.is_test_fixture = false
     and j.scheduled_date is not null
     and j.status not in ('COMPLETED', 'DECLINED')
     and j.permit_status is not null
     and j.permit_status not in ('NOT_REQUIRED', 'APPROVED')

  union all
  -- locate_never_requested -- 811 never called, scheduled within 7 days.
  select j.company_id, j.sync_id, 'locate_never_requested', 'critical',
         '811 never called for a job scheduled ' || to_char(j.scheduled_date, 'YYYY-MM-DD') || ': '
           || coalesce(j.customer_name, 'a job'),
         j.scheduled_date::text
    from public.jobs j
    join eligible_companies ec on ec.company_id = j.company_id
   where j.deleted_at is null and j.is_test_fixture = false
     and j.scheduled_date is not null
     and j.scheduled_date >= now() and j.scheduled_date < now() + interval '7 days'
     and j.locate_called_at is null
     and coalesce(trim(j.locate_ticket_no), '') = ''
     and j.status is distinct from 'DECLINED'
$$;

revoke execute on function public.attention_sweep_candidates() from public, anon, authenticated;
grant  execute on function public.attention_sweep_candidates() to service_role;

comment on function public.attention_sweep_candidates() is
  'Read-only. The nine high-severity detectors (money at risk, crew-to-unready-job, 811/permit/HOA) mirrored from website/dashboard.html''s ALERT_DEFS, scoped to companies with attention_sweep_settings.enabled=true and company_allowed()=true. service_role only.';

select 'attention sweep candidates function installed' as done;

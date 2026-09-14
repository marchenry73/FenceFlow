-- A PAYMENT LINK IS MONEY, AND ANYONE IN THE COMPANY COULD READ ONE.
--
-- Found by verifying the launch audit from evidence rather than from memory.
-- payment_records was closed to anyone without SEE_MONEY back on 11 September.
-- job_payments was not, and it is the more sensitive of the two: it holds
-- amount_cents and payment_url -- a LIVE checkout link for a customer's
-- deposit. Read straight from pg_policy, its select policy is
--
--     company_id = (select company_id from profiles where id = auth.uid())
--
-- and nothing else. So a crew member with their own login and any HTTP client
-- could read every open payment link their company had raised, and follow one.
--
-- The neighbouring tables were each closed in turn as they were found: jobs,
-- line items, catalog and change orders on 11 September, expenses on the 12th.
-- This is the last of that family, and the one with a URL in it.
--
-- What this costs: the phone subscribes to job_payments through realtime
-- (RealtimeWatcher.kt) purely to know when to re-sync. Realtime honours RLS,
-- so a crew handset stops receiving that nudge. Crew are shown no money
-- anywhere in the app, so the nudge was telling them about something they
-- cannot see; their other sync triggers are unaffected. An owner or manager
-- keeps it.
--
-- Not SECURITY DEFINER anywhere near this: RESTRICTIVE is ANDed with the
-- permissive policies, so it can only ever take access away, and it is on
-- SELECT only -- the webhook writes as the service role and is untouched.
--
-- To undo:  drop policy job_payments_money_hidden_from_crew on job_payments;

drop policy if exists job_payments_money_hidden_from_crew on job_payments;

create policy job_payments_money_hidden_from_crew
  on job_payments
  as restrictive
  for select
  using (has_permission('SEE_MONEY'));

select 'payment links closed to anyone without SEE_MONEY' as done;

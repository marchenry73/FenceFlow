-- Three companies to test against, each broken in its own way on purpose.
--
-- There is one test company today, and it is a healthy one. A healthy company
-- only ever proves the happy path, and every real failure this product has had
-- came from a company that was NOT in a tidy state: a phone with no signal, a
-- catalog nobody priced, a crew member with no rate, a subscription that
-- lapsed. Those are the states worth being able to reach on demand.
--
-- All three are unmistakable. Every name begins "ZZ TEST", the ids are fixed
-- and obviously synthetic, and the phone numbers are the 555-01xx block
-- reserved for fiction. Nothing here can be mistaken for a real customer, and
-- the cleanup at the bottom of this comment can never match one:
--
--   delete from companies where id in (
--     '22222222-2222-4222-8222-222222222001',
--     '22222222-2222-4222-8222-222222222002',
--     '22222222-2222-4222-8222-222222222003');
--
-- Purely additive and safe to run twice: every insert is keyed on a fixed id
-- and does nothing on conflict.

-- 1. THE BRAND NEW ONE. Signed up an hour ago and set nothing up. No catalog,
--    no tiers, no crew, no rates. This is what the setup checklist and every
--    "we cannot price this yet" path should be tested against, and it is the
--    state a stranger is actually in on day one.
insert into companies (id, name, subscription_plan, subscription_status, created_at)
values ('22222222-2222-4222-8222-222222222001',
        'ZZ TEST — Brand new, nothing set up', 'Solo', 'trialing', now())
on conflict (id) do nothing;

-- 2. THE LAPSED ONE. Was paying, is not any more. Everything it built is still
--    there, which is the point: the product must hold a company's work while
--    refusing to let them carry on, and must say which of those two it is
--    doing. A blank screen here would look like data loss.
insert into companies (id, name, subscription_plan, subscription_status,
                       suspended, suspended_reason, created_at)
values ('22222222-2222-4222-8222-222222222002',
        'ZZ TEST — Lapsed, work intact', 'Crew', 'past_due',
        true, 'ZZ TEST fixture: payment failed', now() - interval '120 days')
on conflict (id) do nothing;

-- 3. THE BUSY ONE. A company mid-season with work in every state at once.
--    Volume is not the point -- disagreement is. This is where a report that
--    silently drops a row, or a total computed from a bounded slice, shows up.
insert into companies (id, name, subscription_plan, subscription_status, created_at)
values ('22222222-2222-4222-8222-222222222003',
        'ZZ TEST — Busy season, jobs in every state', 'Pro', 'active',
        now() - interval '400 days')
on conflict (id) do nothing;

-- Jobs for the busy one, one per state the product distinguishes. Deliberately
-- spread across time so anything that bounds its reads by recency has an old
-- row to miss, and deliberately including a job with NO contract total, which
-- is the case the chase list ranks as unpriced rather than worthless.
insert into jobs (sync_id, company_id, customer_name, phone, address, status,
                  contract_total, deposit_amount, amount_paid, created_at,
                  quote_sent_at, quote_approved_at)
values
  ('33333333-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222003',
   'ZZ TEST Enquiry (no price yet)', '555-0141', '1 ZZ Test Way', 'DRAFT',
   null, 0, 0, now() - interval '9 days', null, null),
  ('33333333-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222003',
   'ZZ TEST Quote sent, gone quiet', '555-0142', '2 ZZ Test Way', 'SENT',
   12400, 2480, 0, now() - interval '40 days', now() - interval '31 days', null),
  ('33333333-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222003',
   'ZZ TEST Approved, no deposit', '555-0143', '3 ZZ Test Way', 'ACCEPTED',
   8600, 1720, 0, now() - interval '20 days', now() - interval '18 days', now() - interval '11 days'),
  ('33333333-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222003',
   'ZZ TEST Paid in full, finished', '555-0144', '4 ZZ Test Way', 'COMPLETED',
   19204, 3840, 19204, now() - interval '300 days', now() - interval '295 days', now() - interval '290 days'),
  ('33333333-0000-4000-8000-000000000005', '22222222-2222-4222-8222-222222222003',
   'ZZ TEST Declined last year', '555-0145', '5 ZZ Test Way', 'DECLINED',
   5100, 0, 0, now() - interval '380 days', now() - interval '375 days', null)
on conflict (company_id, sync_id) do nothing;

select 'three test companies installed' as done,
       (select count(*) from companies where name like 'ZZ TEST%') as zz_companies,
       (select count(*) from jobs where customer_name like 'ZZ TEST%') as zz_jobs;

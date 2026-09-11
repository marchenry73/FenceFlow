-- Fixtures the rules guard owns, instead of borrowing real jobs.
--
-- tests/live-rules-guard.test.mjs pinned itself to three real jobs in the real
-- operating company. Two of them were retired an hour ago as test data, and the
-- whole suite went red -- not because a rule broke, but because the furniture
-- moved. A test that depends on production rows is a test that fails whenever
-- the business changes, which trains everyone to ignore it.
--
-- These two live in the same company as the accounts that suite impersonates,
-- because set_production_stage and the permission checks all scope by the
-- caller's own company -- a fixture somewhere else would be invisible to them.
-- They are named so nobody mistakes them for work, and the name says out loud
-- not to retire them the way the others were.
--
-- Purely additive, and safe to run twice.
insert into jobs (sync_id, company_id, customer_name, phone, address, status,
                  contract_total, deposit_amount, amount_paid, created_at, quote_approved_at)
values
  ('44444444-0000-4000-8000-000000000001',
   (select id from companies where name = 'Fence solutions'),
   'ZZ TEST rules fixture — approved (do not retire)', '555-0191', '1 ZZ Rules Way',
   'ACCEPTED', 4200, 840, 0, now() - interval '30 days', now() - interval '28 days'),
  ('44444444-0000-4000-8000-000000000002',
   (select id from companies where name = 'Fence solutions'),
   'ZZ TEST rules fixture — unapproved (do not retire)', '555-0192', '2 ZZ Rules Way',
   'DRAFT', null, 0, 0, now() - interval '30 days', null)
on conflict (company_id, sync_id) do nothing;

select 'rules fixtures installed' as done,
       (select count(*) from jobs where customer_name like 'ZZ TEST rules fixture%'
          and deleted_at is null) as fixtures;

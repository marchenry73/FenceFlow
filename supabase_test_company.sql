-- A test company, so nothing has to be proved against a real customer's job.
--
-- Two reasons this exists. The obvious one: somewhere to exercise quote
-- pages, the office and the app without touching paperwork a homeowner is
-- holding. The less obvious one, and the better one: until now a single
-- company held nearly every row in the database, so "company A cannot see
-- company B" was being tested against a database with almost no company B in
-- it. A test that has nothing to find is not a test.
--
-- Everything is named so it cannot be mistaken for real work, and every id is
-- fixed rather than generated, so this file can be re-run and the teardown at
-- the bottom removes exactly what it created and nothing else.

-- ------------------------------------------------------------- company ---
insert into companies (id, name, phone, email, subscription_status, subscription_plan, suspended)
values ('11111111-1111-4111-8111-111111111111',
        'ZZ TEST — Sample Fence Co (not a real company)',
        '555-0100', 'test@example.invalid', 'trialing', 'crew', false)
on conflict (id) do update set name = excluded.name, suspended = false;

-- ----------------------------------------------------------- employees ---
-- A manager and an installer, so the crew money boundary has someone to be
-- tested against. Neither is linked to a login: creating credentials is not
-- something a seed file should do.
insert into employees (id, company_id, name, role, sync_id, hourly_rate, is_active)
values
  ('11111111-1111-4111-8111-111111111201', '11111111-1111-4111-8111-111111111111',
   'ZZ TEST Manager', 'Manager', '11111111-1111-4111-8111-111111111211', 32.00, true),
  ('11111111-1111-4111-8111-111111111202', '11111111-1111-4111-8111-111111111111',
   'ZZ TEST Installer', 'Fence installer', '11111111-1111-4111-8111-111111111212', 22.00, true)
on conflict (id) do update set name = excluded.name;

-- ----------------------------------------------------------- customers ---
-- Spanish and French names on purpose: the quote page now has three
-- languages and each one needs a customer to be read by.
insert into customers (id, company_id, name, address, phone, email, sync_id)
values
  ('11111111-1111-4111-8111-111111111301', '11111111-1111-4111-8111-111111111111',
   'ZZ TEST Customer (ES)', '100 Test Lane, Riverview FL 33578', '555-0111',
   'test-es@example.invalid', '11111111-1111-4111-8111-111111111311'),
  ('11111111-1111-4111-8111-111111111302', '11111111-1111-4111-8111-111111111111',
   'ZZ TEST Customer (FR)', '200 Test Lane, Riverview FL 33578', '555-0112',
   'test-fr@example.invalid', '11111111-1111-4111-8111-111111111312')
on conflict (id) do update set name = excluded.name;

-- ---------------------------------------------------------------- jobs ---
-- Fixed quote tokens so the same link works every time this is re-run. These
-- are test tokens for a test company; the real ones stay random.
insert into jobs (id, company_id, customer_id, customer_name, address, phone, email,
                  status, sync_id, quote_token, contract_total, deposit_amount,
                  tax_rate_percent, scheduled_date)
values
  ('11111111-1111-4111-8111-111111111401', '11111111-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111301', 'ZZ TEST Customer (ES)',
   '100 Test Lane, Riverview FL 33578', '555-0111', 'test-es@example.invalid',
   'SENT', '11111111-1111-4111-8111-111111111411', '11111111-1111-4111-8111-111111111501',
   4820.00, 1000.00, 7.5, now() + interval '7 days'),
  ('11111111-1111-4111-8111-111111111402', '11111111-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111302', 'ZZ TEST Customer (FR)',
   '200 Test Lane, Riverview FL 33578', '555-0112', 'test-fr@example.invalid',
   'DRAFT', '11111111-1111-4111-8111-111111111412', '11111111-1111-4111-8111-111111111502',
   2150.00, 500.00, 7.5, null)
on conflict (id) do update set
  contract_total = excluded.contract_total,
  deposit_amount = excluded.deposit_amount,
  status = excluded.status;

-- --------------------------------------------------------- line items ---
-- Enough for the quote page to have a scope section rather than the
-- "details to follow" fallback.
insert into estimate_line_items (id, company_id, job_sync_id, sync_id, description,
                                 quantity, unit, unit_price, taxable, sort_order,
                                 auto_generated)
values
  ('11111111-1111-4111-8111-111111111601', '11111111-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111411', '11111111-1111-4111-8111-111111111611', 'ZZ TEST 6 ft vinyl privacy fence',
   120, 'FT', 34.50, true, 0, false),
  ('11111111-1111-4111-8111-111111111602', '11111111-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111411', '11111111-1111-4111-8111-111111111612', 'ZZ TEST 5 ft walk gate',
   1, 'EA', 480.00, true, 1, false),
  ('11111111-1111-4111-8111-111111111603', '11111111-1111-4111-8111-111111111111',
   '11111111-1111-4111-8111-111111111412', '11111111-1111-4111-8111-111111111613', 'ZZ TEST 4 ft aluminium fence',
   60, 'FT', 28.00, true, 0, false)
on conflict (id) do update set unit_price = excluded.unit_price;

select 'test company ready' as status,
       (select count(*) from jobs      where company_id = '11111111-1111-4111-8111-111111111111') as jobs,
       (select count(*) from customers where company_id = '11111111-1111-4111-8111-111111111111') as customers,
       (select count(*) from employees where company_id = '11111111-1111-4111-8111-111111111111') as employees,
       (select count(*) from estimate_line_items where company_id = '11111111-1111-4111-8111-111111111111') as line_items;

-- ------------------------------------------------------------ teardown ---
-- Not run by this file. Kept here so removing the test data is one paste
-- rather than a hunt, and so it can never match a real company by accident.
--
--   delete from estimate_line_items where company_id = '11111111-1111-4111-8111-111111111111';
--   delete from jobs               where company_id = '11111111-1111-4111-8111-111111111111';
--   delete from customers          where company_id = '11111111-1111-4111-8111-111111111111';
--   delete from employees          where company_id = '11111111-1111-4111-8111-111111111111';
--   delete from companies          where id         = '11111111-1111-4111-8111-111111111111';

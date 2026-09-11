-- CREW CANNOT READ MONEY. The database side of a rule the app already keeps.
--
-- ALREADY RUN. This is live on the production database and has been since
-- 11 September 2026. Verified against pg_policy on that date: all four
-- RESTRICTIVE policies exist -- jobs_money_hidden_from_crew,
-- line_items_money_hidden_from_crew, materials_money_hidden_from_crew and
-- change_orders_money_hidden_from_crew.
--
-- The line above used to read DO NOT RUN THIS YET, and it stayed there after
-- the policies went live. On 11 September that stale warning convinced a
-- reader auditing notifications that crew money was still exposed, and it
-- very nearly became a reported security hole that had already been closed.
-- A warning that outlives its reason is not caution, it is misinformation
-- with a serious face on. If this file is ever rolled back, change this
-- header in the same breath.
--
-- The preconditions at the bottom were met: crew phones run 1.417 or newer,
-- which read through the money-free _crew views rather than the base tables.
--
-- ---------------------------------------------------------------- why ----
-- The crew app reads through the money-free _crew views, but nothing forces
-- it to. A crew member with their own login and any HTTP client can read the
-- base tables directly. Measured as a real crew account today:
--
--     John Beaunissant   deposit 9910   paid 38669.10
--     John               deposit 3680   paid 46974.93
--     James              deposit  160   paid 0
--
-- Their pay rates are already protected -- a crew account reads zero rows from
-- employees and zero from payment_records -- so this is the last gap, and it
-- is the customer's contract value and payment history.
--
-- --------------------------------------------------------------- how ----
-- A RESTRICTIVE policy is ANDed with the permissive ones, so it can only ever
-- take access away. On SELECT only: the crew still writes through
-- crew_save_job and crew_push_line_items, which are SECURITY DEFINER and do
-- not read these tables as the caller.
--
-- The _crew views keep working because they are SECURITY DEFINER and run as
-- their owner. That is not incidental -- it is the entire reason they are
-- definer, and setting security_invoker on them would take the crew app dark
-- the moment this file runs. Measured: base table 0 rows, definer view 23,
-- invoker view 0.
--
-- ------------------------------------------------------------ the gate ---
-- These are JOB money, so they ask SEE_MONEY. can_see_pay() used to mean the
-- same thing and this file used to call it; payroll has since been split onto
-- its own permission, and leaving the old call here would have quietly taken
-- the customer contract and payment history away from salespeople too.
--
-- Checked against every real account today:
--     OWNER true, MANAGER true, SALES true, CREW false.
-- Only the crew loses anything here.

alter table jobs                enable row level security;
alter table estimate_line_items enable row level security;
alter table material_items      enable row level security;
alter table change_orders       enable row level security;

-- jobs carries deposit_amount, amount_paid, refunded_amount, the labour rates
-- and the markup. All of it is the office's business.
create policy jobs_money_hidden_from_crew on jobs
  as restrictive for select using (has_permission('SEE_MONEY'));

-- unit_price and supplier_unit_price: what the customer pays and what the
-- company pays. The crew view carries the description and quantity, which is
-- what somebody building a fence actually needs.
create policy line_items_money_hidden_from_crew on estimate_line_items
  as restrictive for select using (has_permission('SEE_MONEY'));

-- The catalog is a price list.
create policy materials_money_hidden_from_crew on material_items
  as restrictive for select using (has_permission('SEE_MONEY'));

-- additional_cost and material_cost on a change order.
create policy change_orders_money_hidden_from_crew on change_orders
  as restrictive for select using (has_permission('SEE_MONEY'));

-- time_entries is deliberately NOT here. hourly_rate lives on it, but a crew
-- member has to read their own shifts to clock out, and time_entries_crew
-- already strips the rate. Adding a restrictive policy here would need the
-- same view routing to be proven first, and it is a smaller prize.

-- --------------------------------------------------------- afterwards ---
-- Check as a crew account. jobs must be 0 and jobs_crew must not be:
--
--   set local role authenticated;
--   set local request.jwt.claims =
--     '{"sub":"dabdbf64-8c89-4ec4-89c5-b33430462069","role":"authenticated"}';
--   select (select count(*) from jobs)      as base_must_be_zero,
--          (select count(*) from jobs_crew) as view_must_not_be_zero;
--
-- And as the owner, to prove nothing was taken from the office: jobs must
-- still be 8.

-- ------------------------------------------------------------- undo ----
--   drop policy jobs_money_hidden_from_crew          on jobs;
--   drop policy line_items_money_hidden_from_crew    on estimate_line_items;
--   drop policy materials_money_hidden_from_crew     on material_items;
--   drop policy change_orders_money_hidden_from_crew on change_orders;

-- ---------------------------------------------------- preconditions ----
-- 1. A crew phone running 1.357 or newer, signed in, opening a job, seeing the
--    fence plan and clocking in and out. Every build from 1.357 routes crew
--    reads through the _crew views; older builds read the base tables and will
--    show empty screens the moment this runs.
-- 2. Run it when the crew is not on site, so a mistake costs a re-run and not
--    a lost afternoon.
-- 3. Keep the undo block above to hand.

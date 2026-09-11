-- Clearing a payment link that asks for more than the contract.
--
-- Fence solutions, customer Marco: contract 9,300, link 10,930. The contract
-- was revised down after the link was made and the link never caught up.
-- Nothing has been paid on it.
--
-- March asked for it to be re-issued at 9,300. It CANNOT be, and quietly
-- writing 9,300 into payment_link_amount would be the worst of the options:
-- the row would claim 9,300 while payment_link_url still points at a
-- processor-side link that charges 10,930. The database would be lying about
-- what a customer would actually be asked for, which is worse than the
-- mismatch it was meant to fix.
--
-- A real link needs two things this job does not have:
--   1. An approved quote. create-payment-link refuses an unapproved job as of
--      today, because a forwarded link could otherwise raise a live checkout
--      page for work nobody had agreed to buy. This job is still a DRAFT.
--   2. A connected processor. Fence solutions has chosen Stripe and never
--      finished the connection -- external_id is empty -- so there is nothing
--      to create a link with.
--
-- Both columns are NOT NULL, so they are emptied rather than nulled: zero and
-- blank, which is what every job that has never had a link already carries.
-- Same meaning, no fight with the schema.
--
-- (was: the url column is NOT NULL, so it is emptied rather than nulled -- same
-- meaning, no link, without fighting the schema.)
--
-- So the stale link goes, and nothing takes its place until those are true.
-- The office can issue a correct one from the job in a moment, once the quote
-- is approved and Stripe is connected.
update jobs
   set payment_link_amount = 0,
       payment_link_url = ''
 where deleted_at is null
   and payment_link_amount is not null
   and contract_total is not null
   and payment_link_amount > contract_total + 0.005;

select 'stale over-contract links cleared' as done,
       (select count(*) from jobs
         where deleted_at is null and payment_link_amount is not null
           and contract_total is not null
           and payment_link_amount > contract_total + 0.005) as still_over;

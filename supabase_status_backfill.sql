-- One-off correction for rows written before two bugs were fixed.
--
-- 1. checkout.session.completed used to hardcode subscription_status='active'
--    on every new subscriber, over the 'trialing' the subscription handler had
--    just written correctly. That hardcode is fixed and deployed, so no new row
--    can get it -- but rows already carrying it stay wrong until Stripe next
--    sends an event for them, which for a trial is when it converts. Until
--    then the admin page counts a company that has never been charged as a
--    paying customer.
--
--    Guarded so it is a no-op if anything has moved: only rows whose trial is
--    still in the future, that have no recorded billing period (so Stripe has
--    never actually charged them), and that do have a Stripe subscription.
--
--    Access is unaffected: company_allowed() treats 'trialing' exactly as
--    'active', and the future trial_ends_at is what the gate reads anyway.
update companies
   set subscription_status = 'trialing'
 where subscription_status = 'active'
   and trial_ends_at is not null
   and trial_ends_at > now()
   and subscription_ends_at is null
   and stripe_subscription_id is not null;

-- 2. suspended_reason left over on a company that is not suspended. Harmless
--    but it is the field the admin row prints under the status pill, so a
--    company in good standing carried the word UNPAID next to its name.
update companies
   set suspended_reason = ''
 where not suspended
   and coalesce(suspended_reason, '') <> '';

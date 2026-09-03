-- One processor order, one payment row.
--
-- Square identifies a payment request by its order id in external_id; Stripe
-- by stripe_id, which already has a unique index. A second row for the same
-- Square order could only come from a bug -- but the webhook used to take
-- maybeSingle() on that lookup, which THROWS on two rows, so such a bug
-- would have silently stopped money being recorded. The webhook now takes the
-- first match; this makes the duplicate impossible to write in the first
-- place, so the bug shows up as a failed insert at the source instead of
-- as a payment nobody sees.
--
-- Partial: Stripe rows carry '' here (the column is not null), and the test
-- rows already in the table share it. Blanks are not an identity.
create unique index if not exists job_payments_processor_external_uidx
    on public.job_payments (processor, external_id)
    where external_id is not null and external_id <> '';

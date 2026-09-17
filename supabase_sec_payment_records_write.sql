-- F4 (P2): writes to payment_records were gated on SEE_MONEY, which is a READ
-- permission. SALES holds SEE_MONEY and nothing else money-ish, so a
-- salesperson could insert a negative amount (a refund) and edit every row of
-- the ledger. RECORD_REFUNDS and REQUEST_PAYMENT were never checked anywhere.
--
-- Additive: RESTRICTIVE policies on top of the existing permissive ones. The
-- existing rules (company scoping, SEE_MONEY, not-suspended) all still apply.
-- Nothing is relaxed; a caller must now satisfy these as well.
--
--   recording/editing a payment  -> REQUEST_PAYMENT   (OWNER, MANAGER, ACCOUNTANT)
--   a negative amount (a refund) -> RECORD_REFUNDS    (OWNER, ACCOUNTANT)
--
-- The Stripe/Square webhooks write as the service role and so are not subject
-- to RLS at all.

drop policy if exists payment_records_write_needs_request_payment on public.payment_records;
create policy payment_records_write_needs_request_payment on public.payment_records
    as restrictive for insert to authenticated
    with check (
        public.has_permission('REQUEST_PAYMENT')
        and (amount >= 0 or public.has_permission('RECORD_REFUNDS'))
    );

drop policy if exists payment_records_edit_needs_request_payment on public.payment_records;
create policy payment_records_edit_needs_request_payment on public.payment_records
    as restrictive for update to authenticated
    using (
        public.has_permission('REQUEST_PAYMENT')
        and (amount >= 0 or public.has_permission('RECORD_REFUNDS'))
    )
    with check (
        public.has_permission('REQUEST_PAYMENT')
        and (amount >= 0 or public.has_permission('RECORD_REFUNDS'))
    );

-- The last hard delete in the product.
--
-- Every business table was already stripped of its DELETE policies, so a
-- delete through the API matches nothing and the tombstone is the only way
-- a row leaves. companies was never brought into that pattern: the platform
-- admin's policy was ALL, and every child table cascades on companies.id --
-- so one DELETE on one row, from any session holding the admin flag, would
-- have taken a company's jobs, customers, ledger, crew and profiles with it,
-- with no confirmation and nothing to restore from. No screen offers that
-- button. The API honoured it anyway.
--
-- Same reach for the admin, minus the one verb. Suspension is the tool for
-- turning a company off, and it keeps everything.
drop policy if exists companies_platform_admin_all on public.companies;

create policy companies_platform_admin_read on public.companies
    for select using (is_platform_admin());
create policy companies_platform_admin_insert on public.companies
    for insert with check (is_platform_admin());
create policy companies_platform_admin_update on public.companies
    for update using (is_platform_admin()) with check (is_platform_admin());

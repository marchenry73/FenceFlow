-- The platform admin reads pricing drift across every company.
--
-- pricing_drift's read policy was company-scoped only, so the admin page's
-- drift panel could see nothing. Same shape as the admin read on companies
-- and app_errors: the flag, checked server-side. Read only; the owner of
-- each company still marks their own rows seen.
drop policy if exists pricing_drift_admin_read on public.pricing_drift;
create policy pricing_drift_admin_read on public.pricing_drift for select
    using (public.is_platform_admin());

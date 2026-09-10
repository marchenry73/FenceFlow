-- How many companies there really are, so the console can tell a complete
-- answer from a truncated one.
--
-- admin_companies() returns a set in one call. The API caps a single request
-- at a thousand rows and reports the total as unknown, which means the console
-- cannot distinguish "these are all the companies" from "these are the first
-- thousand". Every tile on the overview -- companies, paying, suspended, and
-- monthly revenue -- is summed from that one result. At six companies this is
-- theory; the first time it matters, every number on the page would be quietly
-- low and nothing would say so.
--
-- Rather than reshape admin_companies() and every caller of it, this answers
-- the one question the page cannot otherwise ask. The page compares what it
-- received against this and says plainly when it is showing a subset.
--
-- Same gate as every other admin function: is_platform_admin(), checked here
-- rather than trusted from the caller. A non-admin gets zero, not an error --
-- consistent with admin_companies() itself, which returns no rows rather than
-- raising.
create or replace function public.admin_companies_count()
returns bigint
language sql
stable
security definer
set search_path to 'public'
as $$
    select count(*) from companies where is_platform_admin();
$$;

revoke all on function public.admin_companies_count() from public, anon;
grant execute on function public.admin_companies_count() to authenticated;

comment on function public.admin_companies_count() is
  'Total company count for the admin console, so it can tell a full result from a truncated one.';

select 'admin company count installed' as done;

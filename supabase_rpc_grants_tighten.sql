-- Three functions were reachable by an anonymous caller holding nothing but
-- the public key that ships in the website's source.
--
-- None can be steered to a wrong answer -- they re-derive their values rather
-- than trusting the caller -- but "cannot currently be abused" is a weaker
-- promise than "cannot be called", and the second one is free. A signed-out
-- stranger has no business asking the database to recompute a company's totals.
--
-- Revoking from anon alone did nothing for two of them: the privilege arrives
-- through PUBLIC, which anon is a member of. So the grant is taken from PUBLIC
-- and handed back explicitly to the roles that genuinely need it -- signed-in
-- users for the button they press, and service_role for the triggers and edge
-- functions that call it server-side.
--
-- money_scope_company_id is mine, added an hour ago to guard the cost reports,
-- and it shipped with the same over-broad grant. Fixed here too.

revoke execute on function public.recompute_job_totals(uuid, uuid) from public, anon;
grant  execute on function public.recompute_job_totals(uuid, uuid) to authenticated, service_role;

revoke execute on function public.recalculate_my_job_totals() from public, anon;
grant  execute on function public.recalculate_my_job_totals() to authenticated, service_role;

revoke execute on function public.money_scope_company_id() from public, anon;
grant  execute on function public.money_scope_company_id() to authenticated, service_role;

select p.proname,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_can_still_call,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as signed_in_can_call,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') as server_can_call
from pg_proc p
where p.pronamespace='public'::regnamespace
  and p.proname in ('recompute_job_totals','recalculate_my_job_totals','money_scope_company_id')
order by p.proname;

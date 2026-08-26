-- company_allowed answered questions for anybody who asked.
--
-- Called with the publishable key and no session it returns false for a real
-- company and null for one that does not exist, so it distinguishes "this
-- company exists and is switched off" from "no such company" to a complete
-- stranger. Verified live:
--     {"cid":"2a5eaa3b-...-c7c0fd71777e"}  -> false
--     {"cid":"00000000-...-000000000000"}  -> null
--
-- Guessing a v4 uuid is not realistic, so this is not open to the world -- but
-- anybody who has ever worked at a company knows its id, and this let them
-- watch whether their old employer was suspended or behind on payment.
--
-- Nothing client-side calls it: the app and both websites call my_service_status
-- instead. Its real callers are admin_companies and my_service_status, which are
-- SECURITY DEFINER owned by the table owner, so their inner call runs with the
-- owner's rights and does not consult the caller's grants. Checked both --
-- including after two of my own queries wrongly reported it unreferenced.
revoke execute on function public.company_allowed(uuid) from public, anon;
grant  execute on function public.company_allowed(uuid) to authenticated, service_role;

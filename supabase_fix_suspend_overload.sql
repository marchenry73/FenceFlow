-- Suspending broke because there are two admin_suspend functions.
--
-- Adding the `hold` parameter with `create or replace` did not replace
-- anything: a different signature is a different function, so the old
-- two-argument version stayed. Postgres then had two equally good candidates
-- and refused to choose -- "function admin_suspend(uuid, unknown) is not
-- unique" -- so the Suspend button did nothing at all.
--
-- The three-argument version defaults `hold` to false, so every existing
-- two-argument caller keeps working once the old one is gone.
drop function if exists public.admin_suspend(uuid, text);

select p.oid::regprocedure::text as remaining
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'admin_suspend';

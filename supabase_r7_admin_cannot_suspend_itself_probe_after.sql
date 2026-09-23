-- Run straight after supabase_r7_admin_cannot_suspend_itself_probe.sql.
-- That probe really does call admin_suspend, inside a transaction it rolls back.
-- This is the separate read that proves the rollback took: a rollback nobody
-- checks is a claim, not a fact. Both rows must read true.
select 'no company was left suspended by the probe' as check,
       not exists (select 1 from companies c
                    where c.suspended and c.admin_notes like 'ZZ probe%') as ok
union all
select 'no probe audit row survives for a test company',
       not exists (select 1 from audit_log a
                    where a.table_name = 'companies' and a.label like 'ZZ TEST%')
union all
select 'CANARY: the admin own company is still allowed',
       (select public.company_allowed(c.id) from companies c
         where c.id = (select p.company_id from profiles p where p.is_platform_admin limit 1));

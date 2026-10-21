-- ============================================================
-- FenceFlow -- is any column unreadable or unwritable by accident?
-- Run in: Supabase -> SQL Editor, or
--   npx supabase db query --linked --project-ref newcrgafcptspmapacrx -f supabase_check_column_grants.sql
--
-- READ-ONLY. Grants nothing, changes nothing. Run it after ANY migration that
-- adds a column.
--
-- WHY THIS EXISTS. public.companies does not grant whole-table SELECT to
-- `authenticated`; it grants SELECT column by column, with five columns
-- deliberately left out (admin_notes, leads_token and the three stripe_* ids).
-- That list was computed once. A column added afterwards is therefore granted
-- to nobody, for ever, and Postgres refuses the WHOLE statement over one
-- ungranted column -- so a single new column takes down every query that uses
-- `select *` or happens to name it.
--
-- It has already happened twice:
--   20 Oct 2026  logo_path was added and the mail function's companies select
--                was widened to include it. Every company email stopped going
--                out for two days, reported to the owner as "something went
--                wrong on FenceFlow's side", and mail_messages had zero rows
--                because the failure was upstream of the log.
--   21 Oct 2026  the owner reported being restricted everywhere and unable to
--                save. This was NOT a grant gap -- the sweep below came up
--                clean -- but it took an hour to rule out, which is an hour
--                this file now costs nobody.
--
-- The check is not "are the grants the ones I wrote down"; a list written down
-- twice drifts twice. It is "does any table grant a privilege on SOME of its
-- columns but not all", which is the shape of the bug, and then the expected
-- exceptions are named ONCE, here.
-- ============================================================

with cols as (
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
),
granted as (
    select g.table_name, g.column_name, g.privilege_type
      from information_schema.column_privileges g
     where g.table_schema = 'public'
       and g.grantee = 'authenticated'
       and g.privilege_type in ('SELECT', 'UPDATE', 'INSERT')
),
gaps as (
    select c.table_name, p.privilege_type, c.column_name
      from cols c
      cross join (values ('SELECT'), ('UPDATE'), ('INSERT')) as p(privilege_type)
     where exists (select 1 from granted g
                    where g.table_name = c.table_name
                      and g.privilege_type = p.privilege_type)
       and not exists (select 1 from granted g
                        where g.table_name = c.table_name
                          and g.column_name = c.column_name
                          and g.privilege_type = p.privilege_type)
),
-- The ONE list of columns that are meant to be unreadable, and why. Anything
-- else turning up below is an accident.
expected as (
    select * from (values
        ('companies', 'SELECT', 'admin_notes'),            -- platform admin's private notes
        ('companies', 'SELECT', 'leads_token'),            -- public lead-form secret
        ('companies', 'SELECT', 'stripe_customer_id'),
        ('companies', 'SELECT', 'stripe_subscription_id'),
        ('companies', 'SELECT', 'stripe_account_id')
    ) as t(table_name, privilege_type, column_name)
),
unexpected as (
    select g.* from gaps g
     where not exists (select 1 from expected e
                        where e.table_name = g.table_name
                          and e.privilege_type = g.privilege_type
                          and e.column_name = g.column_name)
),
missing_expected as (
    select e.* from expected e
     where not exists (select 1 from gaps g
                        where g.table_name = e.table_name
                          and g.privilege_type = e.privilege_type
                          and g.column_name = e.column_name)
)
select 'the sweep ran at all' as check,
       case when (select count(*) from cols) > 100 then 'PASS -- ' || (select count(*) from cols)::text || ' columns examined'
            else 'FAIL -- only ' || (select count(*) from cols)::text || ' columns found, so a clean result below means nothing' end as result
union all
-- The canary. If the five known exceptions have stopped showing up, this query
-- is no longer finding gaps at all and its silence is worthless.
select 'the five known exceptions are still detected',
       case when (select count(*) from missing_expected) = 0
            then 'PASS -- all five found, so the sweep has teeth'
            else 'FAIL -- stopped detecting: ' ||
                 (select string_agg(table_name || '.' || column_name, ', ') from missing_expected) end
union all
select 'no column is ungranted by accident',
       case when (select count(*) from unexpected) = 0
            then 'PASS'
            else 'FAIL -- ' || (select string_agg(table_name || '.' || column_name || ' (' || privilege_type || ')', ', '
                                                  order by table_name, column_name)
                                 from unexpected) end;

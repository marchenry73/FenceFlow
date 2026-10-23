-- ============================================================
-- FenceFlow -- a deleted job can be destroyed for good, unless money
-- is recorded against it.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- HIS DECISION, in his words: "Permanent delete, but never money."
--
-- WHY THERE WAS NO PURGE. There used to be a "Purge forever" button. It
-- called a delete the database refuses for every role -- there is no DELETE
-- policy on these tables for anybody, owner included -- so it returned
-- success and did nothing, and whoever pressed it watched the item come back
-- on the next load. It was removed rather than fixed. This is the fixed
-- version, and the thing that makes it safe is not the confirmation dialog.
--
-- IT REFUSES ANYTHING CARRYING MONEY. A job with a payment recorded against
-- it -- card, cash, cheque, Zelle, refunded, even soft-deleted -- cannot be
-- purged, and the refusal says so. Those rows are the record of money that
-- actually moved, they are what a tax return is built from, and no
-- confirmation dialog is worth the risk of somebody tidying one away at
-- eleven at night. Restore still works on those; so does leaving them.
--
-- ONLY FROM THE BIN. The job must already be deleted. Purge is the second
-- step of a decision somebody already made and slept on, never a shortcut
-- past the first.
--
-- THE TABLE LIST IS DISCOVERED, NOT TYPED. Twenty-two tables carry a
-- job_sync_id today. A hand-written list in here would be correct until the
-- next table is added and then silently leave orphans behind -- which is
-- exactly how the backup list ended up thirteen tables short. This reads
-- information_schema at run time, so a table added next year is purged by
-- the same code.
-- ============================================================

create or replace function public.purge_job(p_job_sync_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $purge$
declare
    v_company uuid;
    v_deleted timestamptz;
    v_money int;
    v_table text;
    v_rows int;
    v_total int := 0;
    v_tables int := 0;
begin
    -- WHO. The caller's own company and their own delete right, read from the
    -- session rather than taken from the request: a job id is not a claim to
    -- anything.
    select j.company_id, j.deleted_at into v_company, v_deleted
      from jobs j
     where j.sync_id = p_job_sync_id
       and j.company_id = public.current_company_id();
    if v_company is null then
        raise exception 'No such job in your company.';
    end if;
    if not public.has_permission('DELETE_RECORDS') then
        raise exception 'Your account is not allowed to delete records.';
    end if;

    -- FROM THE BIN ONLY.
    if v_deleted is null then
        raise exception 'That job is not deleted. Delete it first, then purge it from Deleted Items.';
    end if;

    -- NEVER MONEY. Both ledgers, including rows already soft-deleted: a
    -- payment somebody removed from view is still a payment that happened.
    select (select count(*) from payment_records r
             where r.company_id = v_company and r.job_sync_id = p_job_sync_id)
         + (select count(*) from job_payments p
             where p.company_id = v_company and p.job_sync_id = p_job_sync_id)
      into v_money;
    if v_money > 0 then
        raise exception
            'That job has % payment record(s) against it. Money is never destroyed -- restore it or leave it here.',
            v_money;
    end if;

    -- EVERYTHING THAT POINTS AT IT, found rather than remembered. Base tables
    -- only: the _crew views read through to the tables below them, and
    -- deleting "from" a view either fails or does the same work twice.
    for v_table in
        select c.table_name
          from information_schema.columns c
          join information_schema.tables t
            on t.table_schema = c.table_schema and t.table_name = c.table_name
         where c.table_schema = 'public'
           and c.column_name = 'job_sync_id'
           and t.table_type = 'BASE TABLE'
         order by c.table_name
    loop
        execute format(
            'delete from public.%I where job_sync_id = $1 and (company_id = $2 or company_id is null)',
            v_table
        ) using p_job_sync_id, v_company;
        get diagnostics v_rows = row_count;
        v_total := v_total + v_rows;
        v_tables := v_tables + 1;
    end loop;

    -- Children keyed by the job's row id rather than its sync id.
    delete from expenses where job_id = (select id from jobs where sync_id = p_job_sync_id);
    delete from punch_list_items where job_id = (select id from jobs where sync_id = p_job_sync_id);
    delete from quote_reapprovals where job_id = (select id from jobs where sync_id = p_job_sync_id);

    delete from jobs where sync_id = p_job_sync_id and company_id = v_company;

    -- What was destroyed, said back, so the screen can report a fact rather
    -- than "done".
    return jsonb_build_object('purged', true, 'rows', v_total, 'tables', v_tables);
end $purge$;

revoke all on function public.purge_job(uuid) from public;
grant execute on function public.purge_job(uuid) to anon, authenticated;

-- ------------------------------------------------------------------------
-- PROOF. Nothing live is destroyed by this file.
-- ------------------------------------------------------------------------
select 'the function exists' as check,
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                          where n.nspname='public' and p.proname='purge_job')
            then 'PASS' else 'FAIL' end as result
union all
select 'it runs as its owner, which is the only way past the missing DELETE policies',
       coalesce((select case when p.prosecdef then 'PASS' else 'FAIL' end
                   from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                  where n.nspname='public' and p.proname='purge_job'), 'FAIL')
union all
select 'it refuses a job with money on it',
       case when position('payment record(s) against it' in
              (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='purge_job')) > 0
            then 'PASS' else 'FAIL -- the money guard is gone' end
union all
select 'it checks the caller''s own delete right',
       case when position('has_permission(''DELETE_RECORDS'')' in
              (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='purge_job')) > 0
            then 'PASS' else 'FAIL -- anybody signed in could destroy a job' end
union all
select 'it only purges from the bin',
       case when position('not deleted' in
              (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='public' and p.proname='purge_job')) > 0
            then 'PASS' else 'FAIL -- a live job could be destroyed in one step' end
union all
-- POSITIVE CONTROL for the discovery: it has to FIND the tables, or it would
-- purge a job row and leave twenty-two tables of orphans behind.
select 'it would find every table that points at a job',
       (select count(*)::text || ' tables carry job_sync_id today'
          from information_schema.columns c
          join information_schema.tables t
            on t.table_schema=c.table_schema and t.table_name=c.table_name
         where c.table_schema='public' and c.column_name='job_sync_id'
           and t.table_type='BASE TABLE')
union all
-- CANARY: his own live jobs with money on them, which this can never touch.
select 'jobs it must always refuse',
       (select count(distinct r.job_sync_id)::text || ' jobs have payments recorded'
          from payment_records r);

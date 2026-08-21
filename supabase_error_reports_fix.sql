-- Remove only the synthetic rows this session created to prove the grouping,
-- the RLS and the mark-handled path. Matched on an exact marker so nothing
-- real can be caught by it.
delete from app_errors where email in ('SELFTEST@x', 'SELFTEST@crew');

-- "worst_version" claimed a judgement the query never made: it is the most
-- recent version the bug was seen on, which answers "is this still happening
-- on what people are running now?". Naming it accurately now, while the only
-- caller is one line of the admin page.
drop function if exists public.admin_error_summary(int);

create or replace function public.admin_error_summary(days int default 14)
returns table (
    message        text,
    where_at       text,
    occurrences    bigint,
    devices        bigint,
    companies      bigint,
    first_seen     timestamptz,
    last_seen      timestamptz,
    latest_version text,
    sample_stack   text,
    any_unseen     boolean
)
language sql security definer set search_path = public as $$
    select e.message,
           e.where_at,
           count(*),
           count(distinct e.android),
           count(distinct e.company_id),
           min(e.at),
           max(e.at),
           (array_agg(e.version_name order by e.at desc))[1],
           (array_agg(e.stack order by e.at desc))[1],
           bool_or(not e.seen)
    from app_errors e
    where is_platform_admin()
      and e.at > now() - make_interval(days => days)
    group by e.message, e.where_at
    order by bool_or(not e.seen) desc, max(e.at) desc;
$$;

select count(*) as selftest_rows_remaining from app_errors where email like 'SELFTEST%';

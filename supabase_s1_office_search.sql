-- ============================================================================
-- s1: one search across the office.
--
-- WHAT THIS DELIBERATELY DOES NOT PRETEND.
-- The spec asks for results grouped as Customer / Lead / Estimate / Job /
-- Invoice / Email. Four of those are not things in this database:
--
--   * there is no leads table   -- a lead is a job in an early status
--   * there is no estimates table -- an estimate is line items ON a job
--   * there is no invoices table  -- an invoice is a job with is_invoiced
--   * a property/address is a column on the job, not a record
--
-- So a search for "James Bond" returning a Customer, an Estimate, a Job AND an
-- Invoice would be ONE job dressed up as four results, and clicking any of them
-- would land in the same place. That is a search that looks more capable than
-- the data behind it, which is exactly what this project refuses to ship.
--
-- Instead each job carries BADGES for what it currently is -- quoted, invoiced,
-- owing money -- so one row tells the truth about one record, and the person
-- reading it learns something a second fake row would not have told them.
--
-- SECURITY INVOKER, so RLS answers "whose records are these" exactly as it does
-- everywhere else. No company_id parameter: a function that takes one is a
-- function that can be asked for somebody else's.
-- ============================================================================
create or replace function public.search_office(
    p_query text,
    p_limit integer default 8)
returns table (
    kind       text,     -- 'customer' | 'job' | 'mail'
    id         uuid,
    title      text,
    subtitle   text,
    badges     text[],
    sort_at    timestamptz)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
    q    text := btrim(coalesce(p_query, ''));
    pat  text;
    lim  integer := least(greatest(coalesce(p_limit, 8), 1), 25);
begin
    -- Two characters is the floor. One character matches most of the database
    -- and is never what somebody meant to search for.
    if length(q) < 2 then return; end if;
    -- Escape the LIKE wildcards before wrapping our own around it, or a search
    -- for "50%" matches everything rather than the thing he typed.
    pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';

    return query
    -- ---------------------------------------------------------------- people
    select 'customer'::text,
           c.id,
           coalesce(nullif(btrim(c.name), ''), '(no name)'),
           nullif(btrim(coalesce(c.address, '')), ''),
           '{}'::text[],
           c.created_at
      from public.customers c
     where c.name ilike pat escape '\'
        or c.address ilike pat escape '\'
        or c.phone ilike pat escape '\'
        or c.email ilike pat escape '\'
     order by c.created_at desc nulls last
     limit lim;

    return query
    -- ------------------------------------------------------------------ work
    -- One row per job, with what the job IS said in badges rather than split
    -- into several results that all open the same record.
    select 'job'::text,
           j.id,
           coalesce(nullif(btrim(j.customer_name), ''), '(no name)'),
           nullif(btrim(coalesce(j.address, '')), ''),
           (
             select coalesce(array_agg(b), '{}')
             from (
               select j.status::text as b
               union all
               select 'invoiced'      where j.is_invoiced
               union all
               select 'owing'         where coalesce(j.contract_total, 0) > coalesce(j.amount_paid, 0)
                                        and coalesce(j.contract_total, 0) > 0
               union all
               select 'signed'        where j.signed_at is not null
             ) x
             where b is not null
           ),
           coalesce(j.updated_at, j.created_at)
      from public.jobs j
     where j.deleted_at is null
       and (j.customer_name ilike pat escape '\'
         or j.address       ilike pat escape '\'
         or j.phone         ilike pat escape '\'
         or j.email         ilike pat escape '\'
         or j.notes         ilike pat escape '\')
     order by coalesce(j.updated_at, j.created_at) desc nulls last
     limit lim;

    return query
    -- ------------------------------------------------------------------ mail
    -- Through the SAME tsquery the mail tab uses, not a second rule: a search
    -- that finds a thread here and not in the inbox would be two searches
    -- disagreeing about one mailbox. Filed-away threads are excluded for the
    -- same reason the inbox excludes them.
    select 'mail'::text,
           t.id,
           coalesce(nullif(btrim(t.subject), ''), '(no subject)'),
           nullif(btrim(coalesce(t.snippet, '')), ''),
           '{}'::text[],
           t.last_message_at
      from public.mail_threads t
     where t.trashed_at is null
       and exists (
             select 1 from public.mail_messages m
              where m.thread_id = t.id
                and m.server_gone_at is null
                and m.search_tsv @@ public.mail_search_query(q)
           )
     order by t.last_message_at desc nulls last
     limit lim;
end;
$$;

revoke all on function public.search_office(text, integer) from public, anon;
grant execute on function public.search_office(text, integer) to authenticated;

-- THE CREW ARE THE ONES DIGGING, SO THEY NEED THE ANSWER.
--
-- r57 added jobs.locate_not_required: somebody saying this job needs no
-- utility locate. jobs_crew's select list is explicit, so a new column does
-- not appear in it -- and a crew phone reads jobs_crew, not jobs.
--
-- Left out, the column reads as absent on every crew handset, the app's merge
-- keeps whatever that phone already had (false), and
-- LocateTicket.shouldWarnBeforeDigging keeps warning about digging on a job
-- the owner has explicitly marked as needing none. The crew member sees the
-- warning, the owner sees the box ticked, and neither can tell why they
-- disagree. The noise r57 exists to remove would land on exactly the person
-- it was removed for.
--
-- The same shape as r52: the column list is rebuilt from the view's OWN
-- current columns rather than retyped, because a hand-copied list of ninety
-- columns is how a money column ends up on a crew screen.

do $$
declare cols text;
begin
  if exists (
      select 1 from information_schema.columns
       where table_schema='public' and table_name='jobs_crew'
         and column_name='locate_not_required'
  ) then
      raise notice 'r58: jobs_crew already carries locate_not_required; nothing to do';
      return;
  end if;

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema='public' and table_name='jobs_crew';

  if cols is null then
      raise exception 'r58 FAILED: could not read jobs_crew''s columns; view not rebuilt';
  end if;

  execute format(
      -- with (security_barrier = true): a rebuild with no with-clause CLEARS
      -- the view's options, which is how jobs_crew came to be the only crew
      -- view without a barrier while its four siblings kept theirs.
      'create or replace view public.jobs_crew with (security_barrier = true) '
      'as select %s, locate_not_required '
      'from public.jobs where company_id = current_company_id() '
      'and not company_is_suspended() and not coalesce(is_test_fixture, false)',
      cols);

  raise notice 'r58: locate_not_required added to jobs_crew';
end $$;

-- ---------------------------------------------------------------------------
-- Self-test, with r52's canary: rebuilding a view from a generated column
-- list is exactly how a money column reaches a crew screen.
-- ---------------------------------------------------------------------------
do $$
declare c text; n int;
begin
  if not exists (
      select 1 from information_schema.columns
       where table_schema='public' and table_name='jobs_crew'
         and column_name='locate_not_required'
  ) then raise exception 'r58 FAILED: jobs_crew still does not carry locate_not_required'; end if;

  -- The three r52 added must still be there: this patch rebuilds the same
  -- view, so dropping one of them is the obvious way to go wrong.
  foreach c in array array['job_type','completed_at','review_email_sent_at'] loop
      if not exists (
          select 1 from information_schema.columns
           where table_schema='public' and table_name='jobs_crew' and column_name=c
      ) then raise exception 'r58 FAILED: rebuilding the view dropped %', c; end if;
  end loop;

  -- THE CANARY: money stays out, and each name checked is a real jobs column
  -- so that "absent from the view" is a guarantee and not a misspelling.
  foreach c in array array[
      'contract_total','accepted_total','markup_percent','tax_rate_percent',
      'deposit_amount','amount_paid','labor_cost','minimum_job_charge'
  ] loop
      if exists (
          select 1 from information_schema.columns
           where table_schema='public' and table_name='jobs_crew' and column_name=c
      ) then raise exception 'r58 FAILED: rebuilding the view exposed % to the crew', c; end if;
      if not exists (
          select 1 from information_schema.columns
           where table_schema='public' and table_name='jobs' and column_name=c
      ) then raise exception 'r58 FAILED: % is not a real jobs column, so checking '
        'the view for it proves nothing', c; end if;
  end loop;

  if pg_get_viewdef('public.jobs_crew'::regclass, true) not like '%current_company_id()%'
     or pg_get_viewdef('public.jobs_crew'::regclass, true) not like '%company_is_suspended()%' then
      raise exception 'r58 FAILED: the view no longer filters by company and suspension';
  end if;

  select count(*) into n from information_schema.role_table_grants
   where table_schema='public' and table_name='jobs_crew' and grantee='authenticated'
     and privilege_type='SELECT';
  if n = 0 then
      raise exception 'r58 FAILED: the rebuild dropped authenticated''s SELECT -- every '
        'crew phone would 401 on its next sync';
  end if;

  raise notice 'r58 ok: the crew can read the locate answer, money is still out, grants intact';
end $$;

select 'crew view carries the locate answer' as check,
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='jobs_crew'
                  and column_name='locate_not_required') as pass;
-- ---------------------------------------------------------------------------
-- The barrier, re-asserted. Idempotent, and deliberately AFTER the rebuild
-- above: CREATE OR REPLACE VIEW replaces a view's options with whatever the
-- statement names, so a rebuild written without a with-clause silently clears
-- it. jobs_crew spent weeks as the only crew view without one because three
-- separate rebuilds each forgot. This line means the next one cannot.
-- ---------------------------------------------------------------------------
alter view public.jobs_crew set (security_barrier = true);

do $$
begin
    if not exists (
        select 1 from pg_class c
         where c.oid = 'public.jobs_crew'::regclass
           and 'security_barrier=true' = any(coalesce(c.reloptions, '{}'))
    ) then
        raise exception 'jobs_crew has no security_barrier after this file ran';
    end if;
end $$;

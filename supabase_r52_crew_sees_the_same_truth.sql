-- THE CREW VIEW HAS TO CARRY THE NEW COLUMNS, OR IT INVITES A SECOND EMAIL.
--
-- jobs_crew is the crew-facing projection of jobs: same rows, money columns
-- left out. Its select list is explicit, so a column added to jobs does not
-- appear in it -- and three were just added (job_type in r46, completed_at
-- and review_email_sent_at in r47).
--
-- WHY THAT MATTERS more than a missing label. The job screen shows the
-- hand-written review composer only while review_email_sent_at is null. Read
-- through this view that column is ALWAYS null, so a crew member looking at a
-- job whose automatic review request went out last week sees no marker, sees
-- the composer, and asks the same customer for a review a second time. The
-- guard that stops the automation asking twice does not stop a person asking
-- again, and the thing that misled them is a column that was simply not
-- selected. Empty read as good news, one more time.
--
-- The column list is rebuilt from the view's OWN current columns rather than
-- retyped: there are about ninety of them, and a hand-copied list is how a
-- money column gets added to a crew view by accident. The three new ones are
-- appended, which is what create-or-replace allows.

do $$
declare cols text; missing text[] := '{}';
begin
  foreach cols in array array['job_type','completed_at','review_email_sent_at'] loop
      if not exists (
          select 1 from information_schema.columns
           where table_schema='public' and table_name='jobs_crew' and column_name=cols
      ) then missing := missing || cols; end if;
  end loop;

  if cardinality(missing) = 0 then
      raise notice 'r52: jobs_crew already carries all three; nothing to do';
      return;
  end if;

  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into cols
    from information_schema.columns
   where table_schema='public' and table_name='jobs_crew';

  if cols is null then
      raise exception 'r52 FAILED: could not read jobs_crew''s columns; view not rebuilt';
  end if;

  -- The WHERE is restated exactly as pg_get_viewdef reported it on
  -- 2026-10-29. If it ever drifts, this patch would silently narrow or widen
  -- what the crew can see, so it is asserted below rather than trusted.
  execute format(
      'create or replace view public.jobs_crew as select %s, %s from public.jobs '
      'where company_id = current_company_id() and not company_is_suspended() '
      'and not coalesce(is_test_fixture, false)',
      cols, array_to_string(missing, ', '));

  raise notice 'r52: added % to jobs_crew', array_to_string(missing, ', ');
end $$;

-- ---------------------------------------------------------------------------
-- Self-test. The canary here is the important half: rebuilding a view from a
-- generated column list is exactly how a money column reaches a crew screen,
-- so the money columns are checked to still be ABSENT. A test that only
-- confirmed the three arrived would be happy with a view that leaked the
-- contract total.
-- ---------------------------------------------------------------------------
do $$
declare c text; n int;
begin
  foreach c in array array['job_type','completed_at','review_email_sent_at'] loop
      if not exists (
          select 1 from information_schema.columns
           where table_schema='public' and table_name='jobs_crew' and column_name=c
      ) then raise exception 'r52 FAILED: jobs_crew still does not carry %', c; end if;
  end loop;

  -- THE CANARY: money stays out.
  foreach c in array array[
      'contract_total','accepted_total','markup_percent','tax_rate_percent',
      'deposit_amount','amount_paid','labor_cost','labor_rate_per_ft',
      'minimum_job_charge','refunded_amount'
  ] loop
      if exists (
          select 1 from information_schema.columns
           where table_schema='public' and table_name='jobs_crew' and column_name=c
      ) then
          raise exception 'r52 FAILED: rebuilding the view exposed % to the crew', c;
      end if;
      -- and the column must really exist on jobs, or "absent from the view"
      -- is just a misspelling passing itself off as a guarantee.
      if not exists (
          select 1 from information_schema.columns
           where table_schema='public' and table_name='jobs' and column_name=c
      ) then
          raise exception 'r52 FAILED: % is not a real jobs column, so checking '
            'the view for it proves nothing', c;
      end if;
  end loop;

  -- The row filter is still the one this patch restated.
  if pg_get_viewdef('public.jobs_crew'::regclass, true) not like '%current_company_id()%'
     or pg_get_viewdef('public.jobs_crew'::regclass, true) not like '%company_is_suspended()%' then
      raise exception 'r52 FAILED: the view no longer filters by company and suspension';
  end if;

  select count(*) into n from information_schema.columns
   where table_schema='public' and table_name='jobs_crew';
  raise notice 'r52 ok: three columns added, money still out, % columns in the view', n;
end $$;

select 'crew view carries the review stamp' as check,
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='jobs_crew'
                  and column_name='review_email_sent_at') as pass;

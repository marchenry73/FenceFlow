-- r43: the office reads the labour the ENGINE charged, not its own guess.
--
-- NOT APPLIED. Read the whole file before running it.
--
-- THE BUG. The office works out quoted labour itself:
--
--     labor_rate_per_ft * signed_linear_feet + labor_flat_fee, then the floor
--
-- The engine charges:
--
--     labor_flat_fee + labor_rate_per_ft * max(billable_feet - gate_feet, 0),
--     then the floor
--
-- A gate opening is not fence anybody builds, so the engine takes it out of
-- the labour footage and the office does not. On a job with gates the office
-- therefore reports MORE quoted labour than was ever charged, and the cost
-- report compares the crew's real cost against that inflated figure -- so
-- labour reads more profitable than it is. Measured on live data: 8 of 23
-- jobs carry gates, all 8 have a per-foot labour rate, and 5 of those also
-- carry signed feet, so five jobs are mis-reported today.
--
-- WHY NOT JUST SUBTRACT GATE FEET IN THE OFFICE. Because that is a THIRD copy
-- of a money rule. There are two already -- Kotlin and TypeScript -- and they
-- are held together by a parity gate precisely because two copies drift. A
-- third copy living in the browser is invisible to that gate: nothing would
-- ever tell us it had drifted. This repo has already answered this question
-- once, for the balance (A3, "One meaning now, the server's"), and this is the
-- same answer.
--
-- So: price-job stores the figure it actually charged, and the office reads
-- it. One meaning, the server's.
--
-- WHAT THIS DOES NOT DO: change any price. labor_cost is a RECORD of a figure
-- the engine already computed and already used inside contract_total. Nothing
-- reads it back into pricing, and no quote moves by a cent.

alter table public.jobs
  -- The labour the engine charged, in whole currency units, as of the last
  -- server pricing run. NULL means "never priced on the server", which is a
  -- real state -- a job priced on the phone and never re-priced has no figure
  -- here -- and the office must show nothing rather than fall back to the
  -- guess this column exists to replace.
  add column if not exists labor_cost numeric;

comment on column public.jobs.labor_cost is
  'The labour figure the pricing engine charged at the last server pricing run (price-job). NULL means never priced on the server. A record, never an input: nothing prices from this. See supabase_r43_job_labor_cost.sql.';

-- ---------------------------------------------------------------------------
-- THE PART THAT MATTERS MORE THAN THE COLUMN.
--
-- touch_updated_at() bumps jobs.updated_at on every update EXCEPT when the
-- only columns that changed are on its quiet list. updated_at is the clock
-- last-edit-wins compares on sync, so a bookkeeping write that bumps it makes
-- this server's row look NEWER than a phone's genuine unsynced edit, and that
-- edit is discarded on the next merge. price-job's own comment says the
-- columns it writes are on the quiet list "precisely so this write cannot make
-- a phone's own unsynced offline edits look older than it and lose them".
--
-- labor_cost is written by exactly that same statement, so it has to join the
-- list or this migration silently starts eating offline edits.
--
-- REBUILT FROM THE LIVE FUNCTION BODY, read out of pg_proc on 2026-10-24, not
-- from an older copy of this file. Recreating one of these from a stale source
-- is how a function quietly loses the entries added since -- the mistake
-- supabase_admin_owner_login_email.sql was one re-run away from making. If you
-- are reading this later, diff the array below against the live body BEFORE
-- running it, because anything added in between is about to be dropped.
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
declare
    quiet constant text[] := array[
        'updated_at', 'dispute_opened_at', 'dispute_closed_at', 'dispute_status', 'dispute_reason', 'dispute_amount',
        'amount_paid', 'refunded_amount', 'payment_status', 'payments_from_processor',
        'contract_total', 'accepted_total',
        'quote_viewed_at', 'site_lat', 'site_lon',
        'last_seen_at',
        'priced_by', 'priced_at', 'pricing_engine_version', 'wizard_step',
        'quote_phone_attempts', 'quote_phone_locked_until',
        'quote_approved_without_phone_check',
        'opted_out_at',
        -- r43: written by price-job in the same statement as contract_total.
        'labor_cost'
    ];
begin
    if (to_jsonb(new) - quiet) is distinct from (to_jsonb(old) - quiet) then
        new.updated_at = now();
    else
        new.updated_at = old.updated_at;
    end if;
    return new;
end
$$;

-- ---------------------------------------------------------------------------
-- PROOF, on a row this migration creates and removes itself.
--
-- Every check is written so that running it BEFORE the change above fails:
-- that is what makes it evidence rather than decoration.
-- ---------------------------------------------------------------------------
do $$
declare
  cid uuid;
  jid uuid;   -- jobs.id is a uuid on this schema, not a bigint
  was timestamptz;
  now_after timestamptz;
  ok_quiet boolean;
  ok_loud  boolean;
begin
  -- A ZZ TEST company by preference, so the row this creates and deletes
  -- never touches a real contractor's job list even for the second it exists.
  select id into cid from public.companies
   where name like 'ZZ TEST%' order by created_at limit 1;
  if cid is null then
    select id into cid from public.companies order by created_at limit 1;
  end if;
  if cid is null then raise exception 'no company to test against'; end if;

  -- is_test_fixture as well, which is the flag the office and the app already
  -- filter on, so nothing lists it even if a trigger fires mid-block.
  -- Backdated AT INSERT, which is the only moment it can be.
  --
  -- The first attempt backdated with an UPDATE and the positive control caught
  -- it: changing updated_at alone is a QUIET-only change, so the trigger wrote
  -- old.updated_at straight back over it. And now() is transaction-scoped, so
  -- every call in this block returns the same instant -- a row inserted here
  -- already carries now(), and a "bump" to now() would be indistinguishable
  -- from no bump at all. Both checks below would have passed against a trigger
  -- that had stopped working entirely.
  insert into public.jobs (company_id, sync_id, customer_name, status, is_test_fixture, updated_at)
  values (cid, gen_random_uuid(), 'ZZ R43 PROBE', 'DRAFT', true, now() - interval '7 days')
  returning id, updated_at into jid, was;

  -- THE CHECK: writing labor_cost alone must NOT move the clock.
  update public.jobs set labor_cost = 1234.56 where id = jid;
  select updated_at into now_after from public.jobs where id = jid;
  ok_quiet := (now_after = was);

  -- POSITIVE CONTROL: a column that is NOT quiet must still move it, or the
  -- check above would pass just as happily against a trigger that had stopped
  -- working altogether.
  update public.jobs set customer_name = 'ZZ R43 PROBE 2' where id = jid;
  select updated_at into now_after from public.jobs where id = jid;
  ok_loud := (now_after > was);

  delete from public.jobs where id = jid;

  if not ok_quiet then
    raise exception 'r43 FAILED: writing labor_cost bumped updated_at -- offline edits would be lost';
  end if;
  if not ok_loud then
    raise exception 'r43 FAILED: the positive control did not bump updated_at, so the quiet check proves nothing';
  end if;
  raise notice 'r43 ok: labor_cost is quiet, and a normal edit still bumps the clock';
end $$;

select 'labor_cost exists' as check,
       exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'jobs'
                 and column_name = 'labor_cost') as pass
union all
select 'labor_cost is in the quiet list',
       (select prosrc like '%''labor_cost''%' from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where p.proname = 'touch_updated_at' and n.nspname = 'public')
union all
-- jobs carries a TABLE-level SELECT grant, so a new column needs no grant of
-- its own. Asserted rather than assumed, because the companies table does NOT
-- work this way and an ungranted column there once took all company email down.
select 'authenticated may select the new column',
       has_column_privilege('authenticated', 'public.jobs', 'labor_cost', 'SELECT');

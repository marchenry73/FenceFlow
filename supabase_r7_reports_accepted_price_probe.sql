-- supabase_r7_reports_accepted_price_probe.sql -- proof for
-- supabase_r7_reports_accepted_price.sql. Run AFTER it. One transaction, rolled
-- back at the end; no job row is touched at all and no change order survives.
--
-- WHY IT HAS TO BUILD ITS OWN CASE. Checked on live data 2026-09-22: not one
-- job with an accepted price has a single change order. So production exercises
-- the accepted figure and nothing else -- every arm about orders signed after
-- the acceptance, orders the acceptance already covered, unsigned orders and
-- deleted orders is unreached, and a report that got all four wrong would look
-- perfect. The orders here are inserted against a job_sync_id that belongs to
-- no job (change_orders has no foreign key to jobs), and the jobs row the rule
-- is asked about is a COMPOSITE VALUE built with json_populate_record -- never
-- inserted -- so no trigger on jobs fires and nothing in the real ledger moves.
--
-- Expected: ok true on every row EXCEPT z_planted_failure, which must read
-- false. A probe where everything passes has not been shown to be able to fail.
begin;

create temp table _r7(arm text, ok boolean, got numeric, want numeric, detail text) on commit drop;
grant all on _r7 to authenticated;

do $probe$
declare
  co uuid; owner_id uuid;
  jid uuid := gen_random_uuid();          -- a job_sync_id no job has
  t   timestamptz := now() - interval '10 days';   -- the acceptance
  j   public.jobs;
  covered_flag boolean;
  n_real int;
  -- builds the jobs composite the rule reads: only the columns it looks at.
  function_note text := 'fields: company_id, sync_id, accepted_total, signed_at, quote_approved_at, reapproval_required_at';
begin
  -- The company is chosen by PROPERTY -- an OWNER who may see money -- never by
  -- name, so a promotion or a rename cannot quietly change what is proven.
  select p.company_id, p.id into co, owner_id
    from profiles p
   where p.role::text = 'OWNER' and p.company_id is not null
   order by (select count(*) from jobs jj where jj.company_id = p.company_id and jj.deleted_at is null) desc
   limit 1;
  if co is null then raise exception 'no owner to probe with'; end if;

  -- Positive control on the fixture: the fabricated job id must be unused, or
  -- the orders below would be attached to a real job's money.
  select count(*) into n_real from jobs jj where jj.sync_id = jid;
  insert into _r7 values ('fixture_job_id_is_free', n_real = 0, n_real, 0, jid::text);
  select count(*) into n_real from change_orders co2 where co2.job_sync_id = jid;
  insert into _r7 values ('fixture_no_orders_yet', n_real = 0, n_real, 0, null);

  -- ---------- the arms with no change order ----------
  j := json_populate_record(null::public.jobs, json_build_object(
         'company_id', co, 'sync_id', jid, 'accepted_total', null, 'signed_at', t));
  insert into _r7 values ('a_no_accepted_price', public.job_anchored_total(j) is null,
                          public.job_anchored_total(j), null, 'nothing recorded -> null, caller falls back');

  j := json_populate_record(null::public.jobs, json_build_object(
         'company_id', co, 'sync_id', jid, 'accepted_total', 1000, 'signed_at', t));
  insert into _r7 values ('b_signed_on_paper', public.job_anchored_total(j) = 1000,
                          public.job_anchored_total(j), 1000, 'drawn signature');

  j := json_populate_record(null::public.jobs, json_build_object(
         'company_id', co, 'sync_id', jid, 'accepted_total', 1000, 'quote_approved_at', t));
  insert into _r7 values ('c_approved_online', public.job_anchored_total(j) = 1000,
                          public.job_anchored_total(j), 1000, 'tapped Approve on the quote page');

  j := json_populate_record(null::public.jobs, json_build_object(
         'company_id', co, 'sync_id', jid, 'accepted_total', 1000, 'signed_at', t,
         'reapproval_required_at', t + interval '1 day'));
  insert into _r7 values ('d_reapproval_pending', public.job_anchored_total(j) is null,
                          public.job_anchored_total(j), null, 'a drawing change withdrew the approval');

  j := json_populate_record(null::public.jobs, json_build_object(
         'company_id', co, 'sync_id', jid, 'accepted_total', 0, 'signed_at', t));
  insert into _r7 values ('e_zero_accepted_price', public.job_anchored_total(j) is null,
                          public.job_anchored_total(j), null, 'zero is not a price');

  j := json_populate_record(null::public.jobs, json_build_object(
         'company_id', co, 'sync_id', jid, 'accepted_total', 1000));
  insert into _r7 values ('f_recorded_but_never_accepted', public.job_anchored_total(j) is null,
                          public.job_anchored_total(j), null, 'no signature and no online approval');

  -- ---------- the change-order arms ----------
  -- Inserted as the OWNER: latch_change_order_acceptance() only lets a caller
  -- who may see money set in_accepted_total, which arm j below needs.
  perform set_config('request.jwt.claims',
    json_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  insert into change_orders (id, company_id, sync_id, job_sync_id, description,
                             additional_feet, additional_cost, material_cost,
                             signed_at, in_accepted_total, deleted_by, created_at, updated_at)
  values (gen_random_uuid(), co, gen_random_uuid(), jid, 'ZZ probe: signed after the acceptance',
          0, 500, 0, t + interval '1 day', false, '', now(), now());

  insert into change_orders (id, company_id, sync_id, job_sync_id, description,
                             additional_feet, additional_cost, material_cost,
                             signed_at, in_accepted_total, deleted_by, created_at, updated_at)
  values (gen_random_uuid(), co, gen_random_uuid(), jid, 'ZZ probe: signed before the acceptance',
          0, 700, 0, t - interval '1 day', false, '', now(), now());

  insert into change_orders (id, company_id, sync_id, job_sync_id, description,
                             additional_feet, additional_cost, material_cost,
                             signed_at, in_accepted_total, deleted_by, created_at, updated_at)
  values (gen_random_uuid(), co, gen_random_uuid(), jid, 'ZZ probe: already inside the accepted figure',
          0, 900, 0, t + interval '2 days', true, '', now(), now());

  insert into change_orders (id, company_id, sync_id, job_sync_id, description,
                             additional_feet, additional_cost, material_cost,
                             signed_at, in_accepted_total, deleted_by, created_at, updated_at)
  values (gen_random_uuid(), co, gen_random_uuid(), jid, 'ZZ probe: never signed',
          0, 1100, 0, null, false, '', now(), now());

  insert into change_orders (id, company_id, sync_id, job_sync_id, description,
                             additional_feet, additional_cost, material_cost,
                             signed_at, in_accepted_total, deleted_by, created_at, updated_at,
                             deleted_at)
  values (gen_random_uuid(), co, gen_random_uuid(), jid, 'ZZ probe: signed after, then deleted',
          0, 1300, 0, t + interval '3 days', false, '', now(), now(), now());

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  -- Positive control on the one arm whose fixture the latch could have quietly
  -- undone: if in_accepted_total came out false, arm j would pass for the wrong
  -- reason (excluded as unsigned-before rather than as already covered).
  select co2.in_accepted_total into covered_flag from change_orders co2
   where co2.job_sync_id = jid and co2.additional_cost = 900;
  insert into _r7 values ('fixture_covered_order_is_marked', covered_flag is true,
                          null, null, 'in_accepted_total survived the latch');

  j := json_populate_record(null::public.jobs, json_build_object(
         'company_id', co, 'sync_id', jid, 'accepted_total', 1000, 'signed_at', t));
  insert into _r7 values ('g_only_the_order_signed_after_counts',
                          public.job_anchored_total(j) = 1500, public.job_anchored_total(j), 1500,
                          '1000 + 500; the 700 before, the 900 already covered, the 1100 unsigned and the 1300 deleted are all out');

  -- Each exclusion as a COUNTERFACTUAL against the same answer, so a failure
  -- names which order leaked in rather than just "the total is wrong". The four
  -- costs are 500/700/900/1100/1300 and every subset sums to its own figure, so
  -- these cannot cancel each other out.
  insert into _r7 values ('h_order_before_acceptance_excluded',
    public.job_anchored_total(j) <> 2200, public.job_anchored_total(j), 1500,
    '2200 would mean the 700 signed a day BEFORE the acceptance was added');
  insert into _r7 values ('i_covered_order_excluded',
    public.job_anchored_total(j) <> 2400, public.job_anchored_total(j), 1500,
    '2400 would mean the 900 the acceptance already contained was billed twice');
  insert into _r7 values ('j_unsigned_order_excluded',
    public.job_anchored_total(j) <> 2600, public.job_anchored_total(j), 1500,
    '2600 would mean an UNSIGNED order moved the price');
  insert into _r7 values ('k_deleted_order_excluded',
    public.job_anchored_total(j) <> 2800, public.job_anchored_total(j), 1500,
    '2800 would mean a deleted order was still counted');

  -- Re-approval beats a signed extra: the whole price is back in play.
  j := json_populate_record(null::public.jobs, json_build_object(
         'company_id', co, 'sync_id', jid, 'accepted_total', 1000, 'signed_at', t,
         'reapproval_required_at', t + interval '4 days'));
  insert into _r7 values ('l_reapproval_beats_the_extras', public.job_anchored_total(j) is null,
                          public.job_anchored_total(j), null, 'null even with a signed extra on the job');

  -- Another company's orders are never added to this job.
  j := json_populate_record(null::public.jobs, json_build_object(
         'company_id', gen_random_uuid(), 'sync_id', jid, 'accepted_total', 1000, 'signed_at', t));
  insert into _r7 values ('m_company_scoped', public.job_anchored_total(j) = 1000,
                          public.job_anchored_total(j), 1000, 'same job id, a different company: the 500 is not added');

  -- The harness must be able to fail. This row is EXPECTED false.
  j := json_populate_record(null::public.jobs, json_build_object(
         'company_id', co, 'sync_id', jid, 'accepted_total', 1000, 'signed_at', t));
  insert into _r7 values ('z_planted_failure', public.job_anchored_total(j) = 1501,
                          public.job_anchored_total(j), 1501, 'MUST read false -- proves these assertions can fail');
end
$probe$;

select arm, ok, got, want, detail from _r7 order by arm;

rollback;

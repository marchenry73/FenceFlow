-- r45: cancelling a job, and what is kept when it happens.
--
-- NOT APPLIED. One question is still open (see OPEN, below) and it decides a
-- money rule, so nothing here runs until the owner answers it.
--
-- HIS RULE, in his words: "we already ordered the material, we keep the amount
-- for the material, we keep the amount and $1 per foot for the job we didn't
-- do, but for inconvenience. Customer cannot cancel after material has been
-- ordered, you pick which option is better."
--
-- THE OPTION PICKED: allow the cancellation and keep the money, rather than
-- refusing to let a job be cancelled once materials are ordered. Refusing does
-- not stop the customer walking away; it only stops the office RECORDING that
-- they did, leaving a job the software insists is live with materials on order
-- against it and no record of what was retained. A defined retention is far
-- easier to defend in a dispute than a button that would not work.
--
-- WHY NOT A NEW JobStatus. Adding 'CANCELLED' reaches phones whose enum does
-- not know it, and every parse site falls back -- `getOrDefault(JobStatus.DRAFT)`
-- in Converters, `getOrDefault(local.status)` in JobSync. So an old phone
-- would show a cancelled job as a DRAFT and could push its stale status back
-- and UNDO the cancellation. These are new COLUMNS instead: SupabaseModule's
-- cloudJson sets ignoreUnknownKeys, so an old phone ignores them entirely --
-- it simply does not know yet, and nothing is corrupted.
--
-- WAS OPEN, ANSWERED 27 October 2026, and this is what the file now does.
--
-- The question was what is kept when materials have NOT been ordered. "We keep
-- the amount for the material" reads as nothing to keep when nothing has been
-- bought, and this file retained zero in that case. His answer: "Yes for the
-- $1/ft even if material not ordered for cancelation, for no work done."
--
-- So the two halves are split by what each is FOR. The $1 a foot is for the
-- work that will not happen now, and that work is lost whether or not anything
-- was bought, so it is charged on every cancellation. The MATERIAL is the only
-- part that turns on whether it was ordered, because that is the only part
-- that was actually spent.

alter table public.jobs
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid,
  add column if not exists cancellation_reason text,
  -- What was kept, in whole currency units, AS DECIDED AT THE MOMENT OF
  -- CANCELLATION. Stored rather than recomputed: the line items and the
  -- footage can change afterwards, and what was retained is a fact about that
  -- day, not a figure that should drift.
  add column if not exists cancellation_retained numeric;

comment on column public.jobs.cancelled_at is
  'When the job was cancelled. NULL means live. Deliberately NOT a JobStatus value: an app that predates this would parse an unknown status as DRAFT and could push it back, undoing the cancellation. See supabase_r45_job_cancellation.sql.';
comment on column public.jobs.cancellation_retained is
  'What was kept, decided at the moment of cancellation and stored, because line items and footage move afterwards and what was retained does not.';

-- ---------------------------------------------------------------------------
-- WHAT WOULD BE KEPT, asked before anything is done about it.
--
-- One function, server-side, for the same reason the labour figure moved here
-- in r43: the office computing money for itself is how the two came to
-- disagree. Nothing writes; this only answers.
--
-- Gated exactly as job_costing is, through money_scope_company_id(), so a crew
-- member who cannot see money cannot ask what a cancellation would keep. The
-- material figures are lifted from job_costing's own expressions rather than
-- rewritten, so "the material amount" means one thing in both places.
-- ---------------------------------------------------------------------------
create or replace function public.job_cancellation_terms(jsync text)
returns table (
  materials_ordered boolean,
  material_quoted   numeric,
  material_cost     numeric,
  feet              numeric,
  inconvenience     numeric,
  retained          numeric,
  paid              numeric,
  refund_due        numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with scope as (select money_scope_company_id() as cid),
  j as (
    select jb.*
      from public.jobs jb, scope s
     where jb.company_id = s.cid
       and jb.sync_id = jsync::uuid
       and jb.deleted_at is null
  ),
  mat as (
    -- job_costing's own expressions, verbatim: every non-deleted line item,
    -- sell at unit_price, cost falling back to unit_price when no supplier
    -- price is on record.
    select coalesce(sum(i.quantity * i.unit_price), 0) as sell,
           coalesce(sum(i.quantity * coalesce(i.supplier_unit_price, i.unit_price)), 0) as cost
      from public.estimate_line_items i, scope s
     where i.company_id = s.cid
       and i.job_sync_id = jsync::uuid
       and i.deleted_at is null
  ),
  money as (
    select coalesce(sum(p.amount), 0) as collected
      from public.payment_records p, scope s
     where p.company_id = s.cid
       and p.job_sync_id = jsync::uuid
       and p.deleted_at is null
  )
  select
    -- ORDERED means either signal: the timestamp the office stamps, or a
    -- status that has moved past NOT_ORDERED. Either alone is enough, because
    -- a company that tracks only one of them must not read as "not ordered".
    (j.materials_ordered_at is not null
       or upper(coalesce(j.materials_status, 'NOT_ORDERED')) in ('ORDERED', 'RECEIVED')) as materials_ordered,
    round(mat.sell::numeric, 2) as material_quoted,
    round(mat.cost::numeric, 2) as material_cost,
    coalesce(j.signed_linear_feet, 0)::numeric as feet,
    -- $1 a foot for the work that will not happen now.
    round(coalesce(j.signed_linear_feet, 0)::numeric * 1.00, 2) as inconvenience,
    -- ANSWERED 27 Oct 2026, and the per-foot term is out of the case for it:
    -- "Yes for the $1/ft even if material not ordered for cancelation, for no
    -- work done." So the inconvenience fee is charged on every cancellation,
    -- and the MATERIAL is the only part that depends on whether it was
    -- ordered -- which is the honest split: the fee is for the work that will
    -- not happen, and that work is lost whether or not anything was bought.
    round(
      coalesce(j.signed_linear_feet, 0)::numeric * 1.00
      + case when (j.materials_ordered_at is not null
                   or upper(coalesce(j.materials_status, 'NOT_ORDERED')) in ('ORDERED', 'RECEIVED'))
             then mat.sell::numeric
             else 0
        end, 2) as retained,
    round(money.collected::numeric, 2) as paid,
    -- Never negative: a job that paid less than is retained owes nothing back,
    -- it simply has nothing to refund. The shortfall is a conversation, not a
    -- negative refund.
    round(greatest(money.collected::numeric -
      (coalesce(j.signed_linear_feet, 0)::numeric * 1.00
       + case when (j.materials_ordered_at is not null
                    or upper(coalesce(j.materials_status, 'NOT_ORDERED')) in ('ORDERED', 'RECEIVED'))
              then mat.sell::numeric
              else 0
         end), 0), 2) as refund_due
  from j, mat, money;
$$;

revoke all on function public.job_cancellation_terms(text) from public;
grant execute on function public.job_cancellation_terms(text) to authenticated;

comment on function public.job_cancellation_terms(text) is
  'What a cancellation would keep and what would be owed back. Answers only; writes nothing. Gated through money_scope_company_id() exactly as job_costing is. See supabase_r45_job_cancellation.sql.';

-- ---------------------------------------------------------------------------
-- PROOF, on a job this creates and removes itself.
-- ---------------------------------------------------------------------------
do $$
declare
  cid uuid; jid uuid; js text := gen_random_uuid()::text;  -- a real uuid: the sync_id columns are uuid, not text
  t record;
begin
  select id into cid from public.companies where name like 'ZZ TEST%' order by created_at limit 1;
  if cid is null then select id into cid from public.companies order by created_at limit 1; end if;

  insert into public.jobs (company_id, sync_id, customer_name, status, is_test_fixture,
                           signed_linear_feet, materials_status)
  values (cid, js::uuid, 'ZZ R45 PROBE', 'ACCEPTED', true, 100, 'NOT_ORDERED')
  returning id into jid;

  insert into public.estimate_line_items
    (company_id, sync_id, job_sync_id, description, quantity, unit_price, supplier_unit_price, role, auto_generated)
  values (cid, gen_random_uuid(), js::uuid, 'Panels', 10, 50, 30, 'PANEL', true);

  -- Not ordered: the inconvenience fee and nothing else. Asserted exactly, so
  -- that changing what a cancelled job keeps fails here loudly rather than
  -- silently altering what customers are charged.
  select * into t from public.job_cancellation_terms(js);
  if t.materials_ordered then raise exception 'r45 FAILED: NOT_ORDERED read as ordered'; end if;
  -- 100 ft at $1 and no materials bought: the fee stands alone.
  if t.inconvenience <> 100 then raise exception 'r45 FAILED: inconvenience % with nothing ordered (expected 100)', t.inconvenience; end if;
  if t.retained <> 100 then raise exception 'r45 FAILED: retained % with no materials ordered (expected 100, the fee alone)', t.retained; end if;

  -- Ordered: materials at SELL (10 x 50 = 500) plus $1 x 100 ft = 600.
  update public.jobs set materials_status = 'ORDERED' where id = jid;
  select * into t from public.job_cancellation_terms(js);
  if not t.materials_ordered then raise exception 'r45 FAILED: ORDERED read as not ordered'; end if;
  if t.material_quoted <> 500 then raise exception 'r45 FAILED: material_quoted % (expected 500)', t.material_quoted; end if;
  if t.material_cost <> 300 then raise exception 'r45 FAILED: material_cost % (expected 300)', t.material_cost; end if;
  if t.inconvenience <> 100 then raise exception 'r45 FAILED: inconvenience % (expected 100)', t.inconvenience; end if;
  if t.retained <> 600 then raise exception 'r45 FAILED: retained % (expected 600)', t.retained; end if;
  -- Nothing paid, so nothing to refund -- and never a negative one.
  if t.refund_due <> 0 then raise exception 'r45 FAILED: refund_due % with nothing paid', t.refund_due; end if;

  delete from public.estimate_line_items where company_id = cid and job_sync_id = js::uuid;
  delete from public.jobs where id = jid;
  raise notice 'r45 ok: not-ordered keeps the $1/ft fee alone, ordered keeps materials at sell plus the fee, refund never negative';
end $$;

select 'cancelled_at exists' as check,
       exists (select 1 from information_schema.columns
                where table_schema='public' and table_name='jobs' and column_name='cancelled_at') as pass
union all
select 'the terms function exists',
       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where p.proname='job_cancellation_terms' and n.nspname='public')
union all
select 'a crew member cannot ask it (gated like job_costing)',
       (select prosrc like '%money_scope_company_id()%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where p.proname='job_cancellation_terms' and n.nspname='public');

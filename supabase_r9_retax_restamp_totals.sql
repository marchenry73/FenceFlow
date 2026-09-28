-- ============================================================
-- FenceFlow -- finish the tax re-quote: restamp the price the customer is
--              actually being asked to approve
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- WHY THIS EXISTS. supabase_r9_retax_signed_jobs.sql set
-- jobs.reapproval_required_at so the customer would be asked to approve the
-- corrected price. That is only HALF of what a phone does. The phone also
-- restamps jobs.contract_total, and _shared/quote-deposit.ts:133 returns
-- contract_total as the billable total whenever a re-approval is pending
-- ("otherwise: contract_total, exactly as before", line 118). So the quote page
-- went on sending the OLD total -- proved live, quote-view returned 15540 for
-- John Beaunissant, unchanged, underneath a notice saying the tax was short.
-- Worse, quote-view line 333 records accepted_total = figures.total when the
-- customer approves, so approving would have FROZEN the wrong price.
--
-- KEYED ON sync_id, NOT id, AND THAT IS THE POINT. The first version of this
-- file said `where id = '<uuid>'` using uuids that were in fact sync_ids, taken
-- from quote_reapprovals.job_sync_id. Every statement matched zero rows and
-- every statement SUCCEEDED. Nothing errored, nothing warned. It was caught
-- only by PART 3 reading the rows back and showing the totals unchanged -- the
-- value guards never even got a chance to fire, because the row was never
-- found. A WHERE that matches nothing is not an error, so a write is not done
-- until it has been read back. Deriving the id from sync_id below removes the
-- transcription step that caused it.
--
-- WHERE THE NUMBERS COME FROM. Not from arithmetic of mine. Each is the output
-- of the real server engine -- tests/company-golden-path.pricing-runner.mts,
-- which calls the same buildPricingInput + priceJob that price-job/index.ts
-- calls -- run over each job's own rows. Two controls were run first:
--
--   CONTROL that PASSED: John Beaunissant's OLD total was reproduced exactly.
--   Setting the vinyl-panel and PVC-gate CATALOG rows back to taxable=false in
--   the engine input returned 15540.00, with taxable_subtotal 2955.5899 and tax
--   206.8913 -- matching to the penny the pre-fix figures recorded by hand in
--   supabase_r9_retax_fix_scope_and_wording.sql. That proves the harness and the
--   column shapes.
--
--   CONTROL that FAILED, and why it does not block this: Woody's stored 3620.00
--   cannot be reproduced -- the engine returns 350.00. Its cause is unrelated to
--   tax and is recorded at the bottom of this file.
--
-- A THING I HAD WRONG, worth writing down. PART 1 of the earlier script set
-- estimate_line_items.taxable = true, and I assumed that was what changed the
-- price. It is not what a re-price reads: pricing/line-items.ts buildLineItems
-- takes a generated line's taxable from the CATALOG row every time, and
-- mergeTakeoff preserves a stored line's own fields only when
-- auto_generated = false. So for these auto-generated lines the catalog fix
-- (supabase_r9_taxable_panels.sql, 25 September) is what governs the engine;
-- the line-item update governs only the readers that sum stored rows, which
-- includes the quote page's own tax line. Both were needed, for different
-- readers -- but not for the reason I gave at the time.
--
-- Each total below is ALSO reachable a second, independent way:
-- ceil10(old total + the tax delta computed in SQL), the engine's rounding rule
-- being grandTotal = ceil(max(afterDiscount, minimumJobCharge) / 10) * 10 in
-- _shared/pricing/totals.ts. Both routes agree on all three.
--
--   James Bond         35240.00 -> 36290.00   ceil10(35240 + 1045.53) = 36290
--   John Beaunissant   15540.00 -> 16000.00   ceil10(15540 +  456.38) = 16000
--   (blank name)         870.00 ->   900.00   ceil10(  870 +   20.31) =   900
--
-- WHAT IS DELIBERATELY NOT WRITTEN
--   accepted_total. stamp_accepted_total only re-stamps it when signed_at
--   CHANGES, and signed_at is untouched here, so the figure the customer
--   originally agreed survives as the anchor. Note this also means
--   reapp_restore_approval will now REFUSE to restore these three, because it
--   requires contract_total to equal prior_contract_total -- correct, since the
--   price really did move.
--
--   deposit_amount. It is NOT set here, but it WILL move, by the
--   zz_deposit_follows_price trigger, which scales it in proportion because
--   these jobs have a re-approval pending and nothing paid. That is what he
--   asked for, asked directly: the deposit follows a re-price automatically.
--   Expected: John 5730.00 -> 5899.61, James Bond 21520.00 -> 22161.20, and the
--   blank job unchanged at 0.00 (the trigger returns early with no deposit to
--   scale). PART 3 reads them back rather than trusting that.
--
-- Every UPDATE is still guarded on the total it expects to find, so a phone that
-- restamped in the meantime makes it a no-op rather than a wrong write.

begin;

-- ---------------------------------------------------------------- PART 1
update public.jobs set contract_total = 36290.00
 where sync_id = '4598150b-9a72-49b0-a9bc-52dde4239188'
   and deleted_at is null
   and round(contract_total::numeric, 2) = 35240.00;

update public.jobs set contract_total = 16000.00
 where sync_id = '10b0407f-2322-476f-af96-0520dd84aea1'
   and deleted_at is null
   and round(contract_total::numeric, 2) = 15540.00;

update public.jobs set contract_total = 900.00
 where sync_id = '9747af55-a98b-4b7e-84c4-90c8220a0643'
   and deleted_at is null
   and round(contract_total::numeric, 2) = 870.00;

-- ---------------------------------------------------------------- PART 2
-- James (sync_id 4940d7a0-870c-404e-8d9a-3f9ed5c141d6) is put BACK, like Woody
-- before it, because there is no price here that can honestly be sent.
--
-- Its stored total of 200.00 is not a price at all -- it is the
-- minimum_job_charge floor. The job carries a real drawn polyline of roughly
-- 270 billable feet that was never priced into line items, so the engine
-- returns 5830.00 against materials of 3422.40, while the four stub line items
-- actually stored come to about 154. Its tax delta of 7.33 was computed off
-- those stale stubs, so neither figure is defensible: 210.00 is a number the
-- app itself would disagree with the moment the job is opened, and 5830.00
-- would raise the price by 5630.00 on quantities nobody has agreed to. Asking
-- the customer to approve either would be inventing a price.
--
-- So: the withdrawal is resolved, the flag cleared, and the job is left exactly
-- as it was. It needs re-pricing in the app, which is one press of the button
-- the job sheet already has -- his call, not mine.

update public.quote_reapprovals q
   set resolved_at   = now(),
       resolved_name = 'reverted 2026-09-28: no defensible price to send, needs re-pricing'
 where q.actor_email = 'tax correction 2026-09-28'
   and q.resolved_at is null
   and q.job_id = (select id from public.jobs
                    where sync_id = '4940d7a0-870c-404e-8d9a-3f9ed5c141d6'
                      and deleted_at is null);

insert into public.audit_log
       (company_id, table_name, record_id, action, field, label,
        old_value, new_value, actor_email, at)
select j.company_id, 'jobs', j.id, 'UPDATE', 'reapproval_required_at',
       'Re-approval withdrawn then put back -- needs re-pricing, not a tax fix',
       'waiting for re-approval',
       'put back: stored total is the minimum-charge floor, drawing never priced',
       'tax correction revert 2026-09-28', now()
  from public.jobs j
 where j.sync_id = '4940d7a0-870c-404e-8d9a-3f9ed5c141d6'
   and j.deleted_at is null;

update public.jobs j
   set reapproval_required_at = null,
       reapproval_reason      = '',
       reapproval_count       = greatest(coalesce(j.reapproval_count, 0) - 1, 0)
 where j.sync_id = '4940d7a0-870c-404e-8d9a-3f9ed5c141d6'
   and j.deleted_at is null
   and not exists (select 1 from public.quote_reapprovals q
                    where q.job_id = j.id and q.resolved_at is null);

commit;

-- ---------------------------------------------------------------- PART 3
-- Read back, because the first run of this file changed nothing and said so
-- only here. Three waiting at their new totals; James and Woody not waiting;
-- accepted_total unchanged on every row.
select j.customer_name,
       round(j.contract_total::numeric, 2)             as total_now,
       round(j.accepted_total::numeric, 2)             as accepted_still,
       round(coalesce(j.deposit_amount,0)::numeric, 2) as deposit_now,
       j.reapproval_required_at is not null            as waiting,
       j.reapproval_count                              as cnt
  from public.jobs j
 where j.id in (select job_id from public.quote_reapprovals
                 where actor_email = 'tax correction 2026-09-28')
 order by j.customer_name;

-- ---------------------------------------------------------------- Woody
-- Recorded here because it needs March, and because it is NOT something today's
-- tax work caused.
--
-- Woody (sync_id 93427b69-9552-4114-b25a-8e607adce480) stores contract_total
-- 3620.00 with priced_by = APP, but its single remaining fence run, labelled
-- "Water softener", has an EMPTY points_encoded and a NULL manual_linear_feet --
-- no footage of any kind. So the engine returns 350.00 and the stored price
-- cannot be reproduced from the job as it now stands. A much larger generated
-- set (52 line posts, 54 panels, a gate) was tombstoned on 24 August. None of
-- Woody's line items were touched by the tax correction.
--
-- Nothing is written for it here. Either the drawing needs restoring or the
-- price needs accepting as the smaller figure, and that is his decision, on a
-- job with nothing paid against it.

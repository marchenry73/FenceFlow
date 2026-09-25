-- ============================================================
-- FenceFlow -- the vinyl panels were the only catalog items not being taxed
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   A DATA CORRECTION, not a schema change. It sets material_items.taxable =
--   true on four rows, and estimate_line_items.taxable = true on the lines of
--   jobs the customer has NOT yet agreed to. Nothing is deleted and nothing is
--   dropped. The four ids are written down below, so it is reversible by hand.
--
-- WHAT MARCH REPORTED (25 September)
--   "the tax is not calculating right, I had put 7% and 5730 is 401.1 $, and
--    it's not even supposed to be taking it from there, It's supposed to be the
--    materials which is 9475.34 and 7% is 663.27"
--
-- WHAT IS ACTUALLY WRONG, and it is not the arithmetic
--   EstimateEngine.computeTotals does
--       taxableSubtotal = lineItems.filter { it.taxable }.sumOf { it.lineTotal }
--       tax             = taxableSubtotal * (taxRatePercent / 100)
--   and the TypeScript port does the same. Both are right. The base is small
--   because the line items say so.
--
--   Read off the live database: FOUR of ninety-two catalog items carry
--   taxable = false, and they are the three vinyl privacy panels and one PVC
--   gate panel. Everything else -- posts, concrete, caps, hinges, latches,
--   stiffeners, trim -- is taxed. The column defaults to true, so those four
--   were unticked deliberately at some point or arrived that way in an import.
--
--   Panels are the most expensive thing on a vinyl fence, so the effect is
--   enormous rather than marginal. On the job he was reading (John Beaunissant,
--   whose line items total exactly the 9,475.34 he quoted):
--
--       every line          9,475.34
--       taxed               2,955.59   <- what 7% was being taken on
--       NOT taxed           6,519.75   <- three lines, all panels
--
--   Every real job in the database shows the same two or three untaxed lines,
--   always the panels.
--
-- WHY THE CATALOG AND THE LINES BOTH NEED IT
--   An auto-generated line copies taxable from the catalog item when the takeoff
--   is built. Fixing only the catalog fixes every future job and every
--   regenerated takeoff, but leaves today's stored lines untaxed until something
--   happens to refresh them -- so the number he is looking at would not move.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
--   Line items on a job the customer has already APPROVED or SIGNED. Raising the
--   tax on one of those changes what somebody who already agreed a price owes,
--   which is the exact thing jobs.accepted_total exists to prevent. Those jobs
--   are listed by PART 3 instead, for March to decide one at a time. The signed
--   price protects the customer either way -- an accepted job bills the anchored
--   figure, not a recomputed one -- so nothing here can move a bill on its own.
--
-- WHAT WOULD MAKE THIS VISIBLE NEXT TIME
--   Nothing on the estimate says WHAT the tax was taken on. A "Tax (7% of
--   $2,955.59)" row would have made this obvious the first time he looked
--   instead of on the third pass. That is a code change, not this file, and it
--   is on the list as D4.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  the four catalog items
--
-- By sync_id, read from the live table on 25 September, so re-running this
-- cannot sweep in an item somebody has since and deliberately untaxed:
--   3ddd24c0-22d4-4631-bae2-29a1708379e5  GATE_PANEL  Regular PVC Gate 6'H x 5'W, White
--   1d647c45-1f70-4994-9cac-2b2ceadffd99  PANEL       Panel T&G Vinyl Privacy 6'H x 6'W - Gray
--   8d9ac579-26bd-43b6-af1d-fa03b1578c83  PANEL       Panel T&G Vinyl Privacy 6'H x 6'W - Tan
--   eb4555d9-fa94-4a85-affd-2d5ea36084c1  PANEL       Panel T&G Vinyl Privacy 6'H x 6'W - White
--
-- To undo: set taxable = false on these four ids.
-- ------------------------------------------------------------------------

update public.material_items
   set taxable = true
 where sync_id in (
        '3ddd24c0-22d4-4631-bae2-29a1708379e5',
        '1d647c45-1f70-4994-9cac-2b2ceadffd99',
        '8d9ac579-26bd-43b6-af1d-fa03b1578c83',
        'eb4555d9-fa94-4a85-affd-2d5ea36084c1')
   and taxable = false;

-- ------------------------------------------------------------------------
-- PART 2  the stored lines, on jobs nobody has agreed to yet
--
-- quote_approved_at and signed_at both null: a draft or a quote still out. An
-- accepted job is left exactly as it is; PART 3 lists those.
-- ------------------------------------------------------------------------

update public.estimate_line_items i
   set taxable = true
 where i.deleted_at is null
   and i.taxable = false
   and exists (
        select 1 from public.jobs j
         where j.sync_id = i.job_sync_id and j.company_id = i.company_id
           and j.deleted_at is null
           and j.quote_approved_at is null
           and j.signed_at is null);

-- ------------------------------------------------------------------------
-- PART 3  prove what landed, and say what was left alone
-- ------------------------------------------------------------------------

select 'no catalog item is untaxed any more' as check,
       not exists (select 1 from public.material_items
                    where deleted_at is null and not taxable) as ok
union all
select 'no line item on an unagreed job is untaxed any more',
       not exists (select 1 from public.estimate_line_items i
                    where i.deleted_at is null and not i.taxable
                      and exists (select 1 from public.jobs j
                                   where j.sync_id = i.job_sync_id and j.company_id = i.company_id
                                     and j.deleted_at is null
                                     and j.quote_approved_at is null and j.signed_at is null))
union all
-- CANARY: the check above must be able to fail. If every line in the table is
-- taxable then it would read true whatever the update did, so this proves there
-- is still an untaxed line somewhere -- on an agreed job, left alone on purpose.
select 'CANARY: agreed jobs still carry untaxed lines, left alone deliberately',
       exists (select 1 from public.estimate_line_items i
                where i.deleted_at is null and not i.taxable
                  and exists (select 1 from public.jobs j
                               where j.sync_id = i.job_sync_id and j.company_id = i.company_id
                                 and j.deleted_at is null
                                 and (j.quote_approved_at is not null or j.signed_at is not null)));

-- The jobs March has to decide about, one row each. Raising the tax on these
-- changes what a customer who already agreed a price owes.
select j.customer_name,
       j.quote_approved_at is not null as approved,
       j.signed_at is not null as signed,
       round(j.accepted_total::numeric, 2) as accepted_total,
       count(*) filter (where not i.taxable) as untaxed_lines,
       round(sum(case when i.taxable then 0 else i.quantity * i.unit_price end)::numeric, 2) as untaxed_value,
       round((sum(case when i.taxable then 0 else i.quantity * i.unit_price end)
              * j.tax_rate_percent / 100)::numeric, 2) as tax_it_would_add
  from public.estimate_line_items i
  join public.jobs j on j.sync_id = i.job_sync_id and j.company_id = i.company_id
 where i.deleted_at is null and j.deleted_at is null
   and (j.quote_approved_at is not null or j.signed_at is not null)
 group by j.customer_name, j.quote_approved_at, j.signed_at, j.accepted_total, j.tax_rate_percent
having count(*) filter (where not i.taxable) > 0
 order by untaxed_value desc;

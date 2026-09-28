-- Corrects two mistakes in supabase_r9_retax_signed_jobs.sql, applied earlier
-- today. Reversible facts are in the header so this file can be undone too.
--
-- MISTAKE 1 -- SCOPE. That file's loop was meant to reach only jobs whose lines
-- had just had the tax corrected under them. When I replaced a typed name list
-- with a property test, the property I wrote was "has taxable line items",
-- which is true of every priced job. The test I actually needed was "had a line
-- flipped by PART 1". Woody (4eb3cfe6-1330-40a1-a623-ecd356a05bf4) was swept in
-- on that: all three of its lines were ALREADY taxable, PART 1 changed nothing
-- on it, its contract_total is still 3620.00 and equals the prior_contract_total
-- recorded at withdrawal. Its agreed price was withdrawn for no reason. PART A
-- puts it back.
--
-- MISTAKE 2 -- WORDING, and this one went to all five. The sentence tells the
-- customer the total "was N short", and I computed N as the whole corrected tax
-- rather than the INCREASE. Some of that tax was already being charged
-- correctly, so every notice overstated the rise:
--
--     John Beaunissant   said 663.27     is 456.38    (206.89 was already taxed)
--     James Bond         said 1,505.75   is 1,045.53
--     (blank name)       said 45.68      is 20.31
--     James              said 10.80      is 7.33
--     Woody              said 3.42       is 0.00      -- reverted by PART A
--
-- PART B restates it as the increase, on both the job and the withdrawal row.
-- The increase is arithmetically certain: the only thing that changed is those
-- lines' taxability, so tax rises by rate x flipped value and nothing else
-- moves. Verified against a figure captured BEFORE the change -- John's flipped
-- value of 6519.75 is exactly the untaxed total recorded pre-fix, and
-- 9475.34 - 6519.75 = 2955.59 is exactly the pre-fix taxed base.
--
-- NOT fixed, because it cannot be: reapproval_required_at and reapproval_reason
-- are not on touch_updated_at's quiet list, so the earlier run bumped
-- jobs.updated_at on all five. An offline edit pending on a phone for one of
-- those jobs and older than that bump is already lost. Reverting Woody bumps it
-- once more.
--
-- Nothing has been paid on any of the five (amount_paid = 0.00 on all), and
-- accepted_total is left alone throughout so reapp_restore_approval stays able
-- to undo the four that remain withdrawn.

begin;

-- ---------------------------------------------------------------- PART A
-- Woody: resolve the withdrawal row FIRST, so the "no unresolved rows left"
-- test below sees the truth. reapp_restore_approval works the same way round
-- and for the same reason.

update public.quote_reapprovals
   set resolved_at   = now(),
       resolved_name = 'reverted 2026-09-28: included in error, price never moved'
 where actor_email = 'tax correction 2026-09-28'
   and job_id = '4eb3cfe6-1330-40a1-a623-ecd356a05bf4'
   and resolved_at is null;

insert into public.audit_log
       (company_id, table_name, record_id, action, field, label,
        old_value, new_value, actor_email, at)
select j.company_id, 'jobs', j.id, 'UPDATE', 'reapproval_required_at',
       'Re-approval withdrawn in error and put back',
       'waiting for re-approval',
       'approved as before -- this job had no untaxed lines, its price never moved',
       'tax correction revert 2026-09-28', now()
  from public.jobs j
 where j.id = '4eb3cfe6-1330-40a1-a623-ecd356a05bf4';

-- quote_approved_at is deliberately not written: Woody was never
-- quote-approved, only signed, and prior_approved_at on its withdrawal row
-- confirms it was null before the earlier run. There is nothing to restore
-- there, so restoring it would invent an approval.
update public.jobs
   set reapproval_required_at = null,
       reapproval_reason      = '',
       reapproval_count       = greatest(coalesce(reapproval_count, 0) - 1, 0)
 where id = '4eb3cfe6-1330-40a1-a623-ecd356a05bf4'
   and not exists (select 1 from public.quote_reapprovals q
                    where q.job_id = '4eb3cfe6-1330-40a1-a623-ecd356a05bf4'
                      and q.resolved_at is null);

-- ---------------------------------------------------------------- PART B
-- The four that genuinely changed, chosen by the property that should have
-- selected them in the first place: a line on this job was flipped to taxable
-- by PART 1. Woody has flipped_val 0.00 and so cannot be reached from here --
-- which is the whole point of writing the test this way.

create temporary table r9_fix on commit drop as
with f as (
  select j.id, j.customer_name, j.tax_rate_percent as rate,
         coalesce(sum(i.quantity * i.unit_price)
           filter (where i.taxable
                     and i.updated_at > '2026-09-28T00:00:00Z'), 0)::numeric as flipped_val
    from public.jobs j
    left join public.estimate_line_items i
           on i.job_sync_id = j.sync_id
          and i.company_id  = j.company_id
          and i.deleted_at is null
   where j.id in (select job_id from public.quote_reapprovals
                   where actor_email = 'tax correction 2026-09-28')
   group by j.id, j.customer_name, j.tax_rate_percent)
select f.id, f.customer_name,
       round(f.flipped_val * f.rate::numeric / 100.0, 2) as true_delta,
       'The sales tax on this quote was worked out on part of the materials '
         || 'instead of all of them, so the total was '
         || to_char(round(f.flipped_val * f.rate::numeric / 100.0, 2),
                    'FM999,999,990.00')
         || ' short. The corrected figure is on the quote now and it needs '
         || 'approving again.' as new_reason
  from f
 where round(f.flipped_val * f.rate::numeric / 100.0, 2) > 0.005;

update public.jobs j
   set reapproval_reason = r.new_reason
  from r9_fix r
 where j.id = r.id
   and j.reapproval_required_at is not null;

update public.quote_reapprovals q
   set reason = r.new_reason
  from r9_fix r
 where q.job_id = r.id
   and q.actor_email = 'tax correction 2026-09-28'
   and q.resolved_at is null;

commit;

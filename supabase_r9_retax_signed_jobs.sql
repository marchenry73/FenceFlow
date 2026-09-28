-- ============================================================
-- FenceFlow -- put the signed jobs whose panels had just been made taxable
--              back in front of their customers at the corrected price
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- APPLIED 28 September 2026, and then CORRECTED TWICE the same day by
-- supabase_r9_retax_fix_scope_and_wording.sql. Read that file before this one.
-- Two things this header claimed were wrong:
--
--   SCOPE. It said four jobs. FIVE were withdrawn. The loop below selects on
--   "has taxable line items", which is true of every priced job -- the test it
--   needed was "had a line flipped by PART 1". Woody was swept in with all
--   three of its lines already taxable and its price unmoved; its approval was
--   withdrawn for nothing and has been put back.
--
--   WORDING. The sentence sent to the customer said the total "was N short"
--   with N computed as the whole corrected tax instead of the INCREASE, so all
--   five overstated the rise -- John Beaunissant's said 663.27 where the real
--   increase is 456.38, the other 206.89 having been taxed correctly all along.
--
-- And "every verification row read true" was not something I read. PART 3's
-- output was never successfully parsed; the results came from separate queries
-- run by hand, which is what caught the plpgsql shadowing bug below.
--
-- Applied rather than held, on one fact that decided it: amount_paid is 0.00 on
-- all of them. No money has moved and no invoice has gone out, so correcting the
-- tax BEFORE billing is simply correcting it -- not clawing anything back from
-- anybody. The two judgement calls below are still worth his eye and are left
-- standing, but neither is a reason to hold the change.
--
-- WHAT HE ASKED FOR (28 September)
--   "Send them for approval at the new price."
--
--   These are the jobs supabase_r9_taxable_panels.sql deliberately left alone on
--   25 September, because raising the tax on a job somebody has already agreed
--   changes what they owe -- which is the whole reason jobs.accepted_total
--   exists. He has now decided they should be re-quoted.
--
-- KIND
--   A DATA CHANGE on live customer jobs, and the most consequential one in this
--   repo. It sets taxable = true on eleven line items, and it WITHDRAWS the
--   agreed price on four jobs so the corrected figure becomes the one being
--   asked for. Nothing is deleted. Every prior value is kept whole in
--   quote_reapprovals, so public.reapp_restore_approval can put any of them back.
--
-- WHAT IT DOES NOT DO
--   It sends nothing. No email, no text, no notification to any customer. All it
--   does is put each job into "waiting for the customer to approve again", which
--   is the state the quote link already knows how to present. HANDING THE LINK TO
--   THE CUSTOMER IS MARCH'S ACT, from the office's own "Send the quote again"
--   button, and that button copies a link -- it does not mail anybody either.
--
-- HOW THE NEW PRICE BECOMES THE PRICE, without a re-price run
--   job_anchored_total returns null the moment reapproval_required_at is set, so
--   billableTotal falls through to the LIVE estimate. With the tax lines
--   corrected, the live estimate already contains the corrected tax. So the quote
--   page, the phone, the office and the payment link all quote the new figure
--   from the next read, with no pricing run needed. This is exactly how job 4598
--   behaved on 24 September.
--
-- THE FIGURES, read live on 28 September
--
--   James Bond          ACCEPTED   signed, never approved online
--                       agreed 35,240.00   +1,045.53 tax   2 lines, 14,936.10
--   John Beaunissant    COMPLETED  signed AND approved online
--                       agreed 15,540.00   +  456.38 tax   3 lines,  6,519.75
--   (no customer name)  DRAFT      signed
--                       agreed    870.00   +   20.31 tax   1 line,     290.10
--   James               DRAFT      signed
--                       agreed    200.00   +    7.33 tax   1 line,     104.70
--
--   Nothing has been paid on any of the four (amount_paid is 0.00 on all), so no
--   refund arithmetic and no part-paid balance is involved. That is the single
--   biggest reason this is safe to do at all.
--
-- JUDGEMENT CALL ONE -- John Beaunissant is COMPLETED
--   The work is finished. Re-quoting it means telling a customer whose fence is
--   built that the tax was under-charged by 456.38 and asking them to agree the
--   corrected total. That is a legitimate thing to do and it is his call, not
--   mine, but it is a different conversation from re-quoting live work and he
--   should have decided it on purpose rather than as one of a batch of five.
--   PART 2 can be run without this job by removing one line; it is marked.
--
-- JUDGEMENT CALL TWO -- two of them are worth 27.64 together
--   The unnamed draft is 20.31 and James is 7.33. Putting a draft back in front
--   of a customer costs a conversation; the tax costs less than the stamp. They
--   are included because he said all of them, and they are trivially reversible,
--   but skipping them would be entirely reasonable.
--
-- DELIBERATELY EXCLUDED
--   "ZZ TEST rules fixture -- unapproved (do not retire)". A test fixture, its
--   tax rate is 0% so the correction is worth 0.00, and its name says not to
--   touch it. PART 3 proves it was left alone.
--
-- WHY NOT reapp_withdraw_approval()
--   That is the right function and it records exactly these fields, but it
--   returns early unless quote_approved_at is not null -- and three of these four
--   were SIGNED without ever being approved through the quote link. So the
--   recording is done here, in the same shape, writing the same three places it
--   writes: quote_reapprovals, audit_log and field_changes. A withdrawal that is
--   not recorded in all three is one nobody can trace or undo.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  the tax itself
--
-- By job, not globally: supabase_r9_taxable_panels.sql already fixed every
-- unagreed job, so anything still untaxed belongs to one of these four or to the
-- excluded fixture.
-- ------------------------------------------------------------------------

update public.estimate_line_items i
   set taxable = true
 where i.deleted_at is null
   and i.taxable = false
   and exists (
        select 1 from public.jobs j
         where j.sync_id = i.job_sync_id and j.company_id = i.company_id
           and j.deleted_at is null
           and coalesce(j.is_test_fixture, false) = false
           and (j.quote_approved_at is not null or j.signed_at is not null));

-- ------------------------------------------------------------------------
-- PART 2  the agreed price goes back in play, and the old one is kept whole
-- ------------------------------------------------------------------------

-- The loop variable is NOT called j, and the table IS aliased j.
--
-- It was the other way round on the first run and the loop matched nothing at
-- all, silently: the correlated `exists` below said j.sync_id, which resolved
-- to the plpgsql record rather than to a table alias, and that record is NULL
-- until the loop body starts. So the subquery compared job_sync_id against NULL,
-- came back false for every row, and the whole block reported success having
-- changed nothing. PART 3 is the only reason that was caught.
do $$
declare
    rec public.jobs%rowtype;
    the_reason text;
begin
    for rec in
        select j.* from public.jobs j
         where j.deleted_at is null
           and coalesce(j.is_test_fixture, false) = false
           and j.accepted_total is not null
           and j.reapproval_required_at is null
           and (j.quote_approved_at is not null or j.signed_at is not null)
           -- REMOVE THIS LINE to leave the completed job alone. See judgement
           -- call one in the header.
           and j.status::text in ('ACCEPTED', 'COMPLETED', 'DRAFT')
           and exists (
                select 1 from public.estimate_line_items i
                 where i.job_sync_id = j.sync_id and i.company_id = j.company_id
                   and i.deleted_at is null and i.taxable)
           -- Chosen by what is true of them rather than by typed name: one of
           -- the four has a blank customer_name, and a name list is a fixture
           -- pinned to a person -- it goes wrong the day somebody is renamed.
           -- These are exactly the jobs an agreed price is anchoring while
           -- their own line items have just had the tax corrected under them.
           and not exists (select 1 from public.quote_reapprovals q
                            where q.job_id = j.id
                              and q.actor_email = 'tax correction 2026-09-28')
    loop
        the_reason := format(
            'The sales tax on this quote was worked out on part of the materials '
            || 'instead of all of them, so the total was %s short. The corrected '
            || 'figure is on the quote now and it needs approving again.',
            to_char(
                (select coalesce(sum(i.quantity * i.unit_price), 0) * rec.tax_rate_percent / 100
                   from public.estimate_line_items i
                  where i.job_sync_id = rec.sync_id and i.company_id = rec.company_id
                    and i.deleted_at is null and i.taxable),
                'FM999,999,990.00'));

        -- History FIRST, so a failure below cannot leave a price withdrawn with
        -- no record of what it was. Same columns reapp_withdraw_approval writes.
        insert into public.quote_reapprovals (
            company_id, job_id, job_sync_id, run_sync_id, run_label, change_kind,
            takeoff_before, takeoff_after, reason, actor, actor_email,
            prior_approved_at, prior_approved_name, prior_without_phone_check,
            prior_contract_total, prior_signed_at, prior_signature_path)
        values (
            rec.company_id, rec.id, rec.sync_id, null, '', 'UPDATE',
            '', '', the_reason, null, 'tax correction 2026-09-28',
            rec.quote_approved_at, coalesce(rec.quote_approved_name, ''),
            coalesce(rec.quote_approved_without_phone_check, false),
            rec.contract_total, rec.signed_at, coalesce(rec.signature_storage_path, ''));

        insert into public.audit_log (
            company_id, actor, actor_email, table_name, record_id, action,
            field, old_value, new_value, label)
        values (
            rec.company_id, null, 'tax correction 2026-09-28', 'jobs',
            rec.sync_id::text, 'update', 'accepted_total',
            rec.accepted_total::text, null, coalesce(rec.customer_name, ''));

        insert into public.field_changes (
            company_id, sync_id, job_sync_id, summary, detail,
            changed_by, changed_by_role)
        values (
            rec.company_id, gen_random_uuid()::text, rec.sync_id,
            'Quote needs approving again -- tax corrected', the_reason,
            'tax correction 2026-09-28', '');

        -- Same escape hatch reapp_withdraw_approval uses: these columns are
        -- pinned against every ordinary caller by 11_hold_reapproval_columns.
        --
        -- accepted_total is deliberately NOT cleared. job_anchored_total already
        -- returns null while reapproval_required_at is set, so the live estimate
        -- is what gets quoted -- and keeping the figure means reapp_restore_approval
        -- can put the old agreement back exactly as it was.
        perform set_config('app.reapproval_clear', '1', true);
        update public.jobs set
            quote_approved_at                  = null,
            quote_approved_name                = '',
            quote_approved_without_phone_check = false,
            reapproval_required_at             = now(),
            reapproval_reason                  = the_reason,
            reapproval_count                   = coalesce(reapproval_count, 0) + 1
          where id = rec.id;
        perform set_config('app.reapproval_clear', '0', true);
    end loop;
end $$;

-- ------------------------------------------------------------------------
-- PART 3  prove what landed. Every row must read true.
-- ------------------------------------------------------------------------

select 'no line item on a real job is untaxed any more' as check,
       not exists (select 1 from public.estimate_line_items i
                    join public.jobs j on j.sync_id = i.job_sync_id and j.company_id = i.company_id
                   where i.deleted_at is null and j.deleted_at is null
                     and not i.taxable
                     and coalesce(j.is_test_fixture, false) = false) as ok
union all
-- The excluded fixture. If this reads false it was swept in with the rest, and
-- its name says not to touch it.
select 'CANARY: the test fixture still carries its untaxed line, left alone',
       exists (select 1 from public.estimate_line_items i
                join public.jobs j on j.sync_id = i.job_sync_id and j.company_id = i.company_id
               where i.deleted_at is null and not i.taxable
                 and coalesce(j.is_test_fixture, false) = true)
union all
select 'all four are waiting for the customer again',
       (select count(*) = 4 from public.jobs
         where deleted_at is null and coalesce(is_test_fixture, false) = false
           and reapproval_required_at is not null
           and customer_name in ('James Bond', 'John Beaunissant', 'James', ''))
union all
select 'none of them still shows an online approval',
       not exists (select 1 from public.jobs
                    where deleted_at is null and reapproval_required_at is not null
                      and quote_approved_at is not null
                      and customer_name in ('James Bond', 'John Beaunissant', 'James', ''))
union all
-- The undo. Every one of the four must have its prior figure kept, or the old
-- agreement cannot be restored and this was a one-way door.
select 'every one of them has its prior price recorded and restorable',
       (select count(*) = 4 from public.quote_reapprovals
         where actor_email = 'tax correction 2026-09-28'
           and prior_contract_total is not null
           and resolved_at is null)
union all
select 'the signature and what was paid are untouched',
       not exists (select 1 from public.jobs
                    where deleted_at is null and reapproval_required_at is not null
                      and customer_name in ('James Bond', 'John Beaunissant', 'James', '')
                      and (signed_at is null or coalesce(amount_paid, 0) <> 0))
union all
select 'the change is in the crew and office feed, not silent',
       (select count(*) = 4 from public.field_changes
         where changed_by = 'tax correction 2026-09-28')
union all
-- CANARY for the count checks above: prove the predicate can return something
-- other than 4, so "= 4" is measuring and not merely matching a constant.
select 'CANARY: the same count over every job is not 4',
       (select count(*) <> 4 from public.jobs where deleted_at is null);

-- What each customer will now be quoted, so the figures can be checked against
-- the header before anybody is contacted.
select j.customer_name,
       j.status::text as status,
       round(j.accepted_total::numeric, 2) as was_agreed,
       round((select coalesce(sum(i.quantity * i.unit_price), 0)
                from public.estimate_line_items i
               where i.job_sync_id = j.sync_id and i.company_id = j.company_id
                 and i.deleted_at is null)::numeric, 2) as materials_now,
       round((select coalesce(sum(i.quantity * i.unit_price), 0) * j.tax_rate_percent / 100
                from public.estimate_line_items i
               where i.job_sync_id = j.sync_id and i.company_id = j.company_id
                 and i.deleted_at is null and i.taxable)::numeric, 2) as tax_now,
       j.reapproval_required_at is not null as waiting_for_customer
  from public.jobs j
 where j.deleted_at is null
   and j.customer_name in ('James Bond', 'John Beaunissant', 'James', '')
 order by was_agreed desc;

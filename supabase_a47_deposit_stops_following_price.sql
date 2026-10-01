-- ============================================================
-- FenceFlow -- the deposit stops being rescaled behind everyone's back
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- NOT APPLIED. Written 2026-10-01 and left for the owner to run. It REVERSES a
-- decision he took on 2026-09-24 ("deposit must follow re-price everywhere"),
-- so it needs his yes first. Read WHY before running it.
--
-- KIND
--   Removes ONE trigger from public.jobs. No column added or dropped, no row
--   touched, no function dropped. Every deposit already stored stays exactly
--   what it is.
--
-- WHY
--   On 1 Oct 2026 the customer's quote page showed a deposit that was neither
--   what the owner had set nor what his own new rule gives. Read from the live
--   database (SELECT only):
--
--     * The page serves jobs.deposit_amount, capped at the price. It never
--       serves a suggestion. Served == stored on every quote link that could be
--       asked without stamping it as opened.
--     * zz_deposit_follows_price (supabase_r8_deposit_follows_price.sql, live
--       body read from pg_proc and identical to that file) rescales a stored
--       deposit by new_price / old_price on every change to contract_total
--       while the job is still a draft or a withdrawn approval.
--     * Jobs are re-priced often, and every re-price scales the deposit. The
--       audit_log shows one draft job's deposit rewritten about twenty times
--       on that one day: 1690, then 1028.70, 2776.43, 2312.12 each followed
--       within a quarter of a second by 1690 again (which is what a phone
--       pushing its own copy over the top looks like), and later 588.93,
--       1383.33, 1638.08, 1640.73, 1673.13. At about 21:27 UTC a batch
--       re-price (pricing_engine_version 2026.10.2, priced_at within two
--       seconds across at least five jobs) rescaled three jobs' deposits to roughly a
--       third of what they had been. The page serves whichever figure is stored
--       when it is opened. The owner's rule for the draft job's materials
--       was $3,000; the page was serving 1,673.13.
--     * The phone is not told. The trigger is named zz_ precisely so that it
--       fires AFTER touch_updated_at and does NOT move updated_at (see the
--       header of the r8 file: otherwise every re-price would look like an
--       edit that beats a phone's offline work). Observed: that draft job's
--       updated_at was still 16:19 UTC while its deposit was rewritten at
--       21:43 UTC. The phone adopts a cloud row only when the cloud's
--       updated_at is newer than its own (JobSync.kt, the
--       `cloudJob.updatedAtMillis() > local.updatedAt` branch), so it keeps
--       the figure it last had while the web serves the rescaled one. The two
--       surfaces then disagree for as long as nobody edits the job.
--
--   And the rule it scales is no longer the owner's rule. Today's deposit is
--   the materials still to be bought, rounded UP to the next $100, plus $100
--   (JobMoney.ruleDeposit / quote-deposit.ts ruleDeposit). That figure comes
--   from MATERIALS, not from a share of the price. Scaling it by the price
--   ratio turns a whole-hundred deposit into one with cents, and moves it when
--   only labour or markup changed, which cannot change what has to be bought.
--
-- WHAT STAYS TRUE AFTER THIS
--   * Readers still cap a deposit at the price that stands (depositFigures()
--     asked; the office's depositAskedOf), so a deposit can never be asked for
--     above the job -- the cap was never the trigger's job to hold alone.
--   * The deposit changes when a person changes it: typed, or tapped from the
--     phone's "Set deposit" suggestion. Then phone, database and web read one
--     figure through the normal sync, which is the point.
--   * Deposits that were already rescaled stay as they are. They are not
--     repaired here: this file never writes a row. On the phone, the "Set deposit"
--     button offers the rule's figure while the stored deposit is below the
--     job's materials (the gate in JobDetailScreen.kt). It does not yet offer it
--     to a stored figure that is above the materials but below the rule.
--
-- WHAT THE OWNER LOSES, so he can say no
--   A draft job's deposit no longer moves by itself when the price moves. If the
--   price doubles the deposit stays where it was until someone sets it again;
--   the phone's suggestion shows the new rule figure for the new materials.
--
-- WHEN YOU APPLY THIS, in the same change
--   * tests/a4-deposit.test.mjs Part 1 transcribes the old trigger and pins
--     supabase_r8_deposit_follows_price.sql by fingerprint. That file keeps
--     describing a rule that no longer runs; retire or rewrite it with this.
--   * supabase_r9_retax_restamp_totals.sql's header says the deposit "WILL move"
--     on a re-price. After this it will not.
--
-- ROLLBACK (one statement; the function is deliberately kept):
--   create trigger zz_deposit_follows_price
--     before update on public.jobs
--     for each row execute function public.deposit_follows_price();
--   The name matters; read the r8 header before using any other.
-- ============================================================

drop trigger if exists zz_deposit_follows_price on public.jobs;

-- ------------------------------------------------------------------------
-- PROOF. Every row must read true, except the one marked CANARY, which must
-- read false: it asks the same question about a trigger that never existed, so
-- a query that answers true to everything cannot pass.
-- ------------------------------------------------------------------------

select 'the deposit trigger is gone from jobs' as check,
       not exists (select 1 from pg_trigger
                    where tgrelid = 'public.jobs'::regclass
                      and tgname = 'zz_deposit_follows_price'
                      and not tgisinternal) as ok
union all
select 'the function is kept, so rollback is one statement',
       exists (select 1 from pg_proc
                where pronamespace = 'public'::regnamespace
                  and proname = 'deposit_follows_price')
union all
select 'jobs_touch_updated_at is untouched',
       exists (select 1 from pg_trigger
                where tgrelid = 'public.jobs'::regclass
                  and tgname = 'jobs_touch_updated_at'
                  and not tgisinternal)
union all
select 'the money guard on jobs is untouched',
       exists (select 1 from pg_trigger
                where tgrelid = 'public.jobs'::regclass
                  and tgname = '00_protect_job_money'
                  and not tgisinternal)
union all
select 'CANARY (must read false): a trigger that never existed',
       exists (select 1 from pg_trigger
                where tgrelid = 'public.jobs'::regclass
                  and tgname = 'zz_no_such_trigger_a47'
                  and not tgisinternal);

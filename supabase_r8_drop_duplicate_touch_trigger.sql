-- ============================================================
-- FenceFlow -- fence_runs carries the same clock trigger twice
--
-- NOT APPLIED. This one DROPS something on a live table, so it waits for March.
--
-- WHAT IS THERE
--   public.fence_runs has two BEFORE UPDATE triggers that are the same trigger:
--
--       fence_runs_touch              -> touch_updated_at()
--       fence_runs_touch_updated_at   -> touch_updated_at()
--
--   Proved rather than eyeballed, against the live catalogue on 25 September:
--   same tgfoid (so the same function), same tgtype (so both BEFORE, both on the
--   same events), tgqual null on both (no WHEN clause telling them apart), and
--   tgattr empty on both (neither is scoped to a column list). There is no input
--   for which one fires and the other does not.
--
-- WHY IT IS HARMLESS TODAY, AND WHY IT SHOULD STILL GO
--   touch_updated_at is idempotent: it sets new.updated_at from the same
--   comparison both times, so running it twice lands the same value. Nothing is
--   wrong with the data.
--
--   It should still go, for two reasons. A reader counting the triggers on this
--   table is trying to work out what moves the clock -- the offline merge turns
--   on it -- and finding the same one twice makes them wonder which of the two
--   is the real one and whether the other was meant to do something else. And a
--   later change to one of the names (a patch file that drops and recreates
--   "its" trigger) would leave the other behind still firing, which is how a
--   duplicate becomes a divergence.
--
-- WHICH ONE TO KEEP
--   fence_runs_touch_updated_at, because it is the name every other table here
--   uses (jobs_touch_updated_at, and the %I_touch_updated_at pattern in
--   supabase_full_sync_patch.sql). fence_runs_touch is the odd one out.
--
--   If you would rather I check which patch file created each before dropping
--   either, say so -- it costs one grep and this can wait.
--
-- THE ORDER RISK, and it is why this is not a one-liner
--   Postgres fires BEFORE triggers in trigger-NAME order, and this project has
--   one trigger whose correctness depends on sorting AFTER the clock trigger:
--   zz_deposit_follows_price on public.jobs (see
--   supabase_r8_deposit_follows_price.sql, which explains what breaks if it ever
--   fires first). That one is on JOBS, not fence_runs, so dropping either name
--   here cannot disturb it. Stated because "drop a trigger" and "change trigger
--   order" are the same act, and the next person should not have to work that
--   out again.
--
--   On fence_runs the remaining BEFORE UPDATE triggers are
--   enforce_delete_permission and whichever touch trigger survives. Neither
--   reads the other's work: enforce_delete_permission decides whether a soft
--   delete is allowed, touch_updated_at sets a timestamp. PART 2 checks the
--   count afterwards rather than assuming.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  the drop
-- ------------------------------------------------------------------------

drop trigger if exists fence_runs_touch on public.fence_runs;

-- ------------------------------------------------------------------------
-- PART 2  prove what is left. Every row must read true.
-- ------------------------------------------------------------------------

select 'the duplicate is gone' as check,
       not exists (select 1 from pg_trigger
                    where tgrelid = 'public.fence_runs'::regclass
                      and tgname = 'fence_runs_touch' and not tgisinternal) as ok
union all
-- The one that matters. If this reads false the table has NO clock trigger, and
-- offline merges start resolving on a timestamp nothing moves.
select 'fence_runs still has exactly one touch_updated_at trigger',
       (select count(*) = 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         where t.tgrelid = 'public.fence_runs'::regclass and not t.tgisinternal
           and p.proname = 'touch_updated_at')
union all
select 'and it is the BEFORE UPDATE one',
       (select bool_and(t.tgtype & 2 = 2 and t.tgtype & 16 = 16)
          from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         where t.tgrelid = 'public.fence_runs'::regclass and not t.tgisinternal
           and p.proname = 'touch_updated_at')
union all
select 'the reapproval trigger is untouched',
       exists (select 1 from pg_trigger where tgrelid = 'public.fence_runs'::regclass
                and tgname = 'reapproval_on_drawing_change' and not tgisinternal)
union all
select 'and so is the delete guard',
       exists (select 1 from pg_trigger where tgrelid = 'public.fence_runs'::regclass
                and tgname = 'enforce_delete_permission' and not tgisinternal)
union all
-- CANARY: the count test must be able to fail. jobs carries exactly one, so a
-- reading of 1 there proves the query counts rather than always saying 1.
select 'CANARY: the same count on jobs reads 1, not whatever fence_runs reads',
       (select count(*) = 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
         where t.tgrelid = 'public.jobs'::regclass and not t.tgisinternal
           and p.proname = 'touch_updated_at');

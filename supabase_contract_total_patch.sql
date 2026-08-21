-- The contract price, as the app works it out.
--
-- The website was totalling a job as materials + change orders and calling it
-- the contract price. That leaves out labour, markup, tax, gates, teardown and
-- the minimum charge -- every part of what the customer is actually billed. On
-- real data it read a fully-paid $19,204 job as a $10,568 job overpaid by
-- $8,636, and the app and the website disagreed about every money figure.
--
-- The fix is not to reimplement the estimating engine in SQL. There would then
-- be two engines to keep in step, and they would drift again the first time a
-- pricing rule changed. The app owns pricing; it now sends the number it
-- computed, and everything else reads it.
--
-- Additive and nullable: existing rows are null until each phone next syncs,
-- and the readers below fall back to the old materials sum for those, so
-- nothing reads as zero in the meantime.
alter table public.jobs add column if not exists contract_total numeric;

comment on column public.jobs.contract_total is
    'Grand total from the app''s estimating engine: materials, tax, labour, '
    'teardown, gates, change orders, markup, discount and minimum charge. '
    'Written by the app on sync. Never compute this in SQL -- see the patch.';

select 'contract_total added' as done;

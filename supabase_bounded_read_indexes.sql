-- INDEXES FOR THE BOUNDED READS THE OFFICE NOW DOES.
--
-- On 12 September the office stopped pulling every expense and every payment
-- a company had ever recorded, and started asking for a recent window with
-- per-job and full-table top-ups for the screens that genuinely need
-- everything. Those windowed reads filter on columns nothing indexes:
--
--   estimate_line_items  updated_at >= cutoff
--   expenses             spent_at   >= cutoff
--   time_entries         started_at >= cutoff
--   expenses             job_sync_id = ...   (the per-job top-up)
--
-- Without an index each of those is a sequential scan, so the change that was
-- meant to make a mature company's office usable would have traded one slow
-- read for another at exactly the size where it matters.
--
-- Composite with company_id first, because every one of these reads is
-- company-scoped by row-level security before the date is even considered, and
-- a company is by far the more selective of the two. payment_records already
-- has its (company_id, received_at) index, which is the shape being copied.
--
-- HONEST ABOUT THE BENEFIT: nothing here is measurable today. The expenses
-- table is empty system-wide and time_entries holds nine rows, so Postgres
-- will rightly ignore these indexes until there is data to justify them. This
-- is preparation for the volume the bounded reads were written for, not a fix
-- for a slowness anybody has felt. Claiming otherwise would be inventing a
-- result. The honest measurement needs a synthetic company of roughly 1,500
-- jobs, which does not exist yet.
--
-- Additive and reversible. To undo:
--   drop index if exists expenses_company_spent_idx;
--   drop index if exists expenses_job_idx;
--   drop index if exists estimate_line_items_company_updated_idx;
--   drop index if exists time_entries_company_started_idx;

create index if not exists expenses_company_spent_idx
  on public.expenses (company_id, spent_at);

create index if not exists expenses_job_idx
  on public.expenses (job_sync_id);

create index if not exists estimate_line_items_company_updated_idx
  on public.estimate_line_items (company_id, updated_at);

create index if not exists time_entries_company_started_idx
  on public.time_entries (company_id, started_at);

select 'indexes for the bounded reads installed' as done;

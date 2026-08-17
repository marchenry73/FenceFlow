-- The payments ledger: one row per movement of money, with the date it happened.
--
-- "Collected this month" could not be answered correctly without it. The report
-- summed each job's lifetime amount_paid and attributed the whole figure to a
-- single job timestamp -- and for an unscheduled job that timestamp was
-- updated_at, which is a sync artifact. So editing an old job dragged every
-- payment it had ever taken into the current month, and because updated_at
-- differs per device, two phones in the same company showed different numbers
-- and both were wrong.
--
-- Refunds are rows with a negative amount, so the ledger reads as a statement
-- rather than needing a second table to reconcile against.

create table if not exists payment_records (
  id uuid primary key default gen_random_uuid(),
  sync_id text not null,
  company_id uuid not null references companies(id) on delete cascade,
  job_sync_id uuid not null,
  amount double precision not null,
  method text not null default 'OTHER',
  -- When the money moved, NOT when the row was written. Reports bucket on this.
  received_at timestamptz not null default now(),
  reference text not null default '',
  note text not null default '',
  recorded_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by text not null default '',
  unique (company_id, sync_id)
);

create index if not exists payment_records_company_received_idx
  on payment_records (company_id, received_at);
create index if not exists payment_records_job_idx
  on payment_records (company_id, job_sync_id);

alter table payment_records enable row level security;

drop policy if exists payment_records_read on payment_records;
create policy payment_records_read on payment_records
  for select using (company_id = current_company_id());

drop policy if exists payment_records_write on payment_records;
create policy payment_records_write on payment_records
  for all
  using (company_id = current_company_id())
  with check (company_id = current_company_id());

drop trigger if exists payment_records_touch_updated_at on payment_records;
create trigger payment_records_touch_updated_at
  before update on payment_records
  for each row execute function touch_updated_at();

-- Money has to appear without anyone pressing anything.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='payment_records'
  ) then
    alter publication supabase_realtime add table public.payment_records;
  end if;
end $$;
alter table public.payment_records replica identity full;

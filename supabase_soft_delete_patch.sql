-- Deleting must leave a mark, or it does not stay deleted.
--
-- The bug this fixes, exactly: deleting hard-deleted the cloud row. Every
-- device's push loop reads "this exists on my phone but not in the cloud" as
-- "it hasn't been uploaded yet" and uploads it again. So a second device that
-- still held a local copy put the row straight back, and the device that did
-- the deleting pulled it down again as a brand new record. Nothing anywhere
-- said it had ever been deleted, so there was no way for either side to know.
--
-- With a tombstone the fact of the deletion is itself synced: every device can
-- see that the row is gone on purpose, and re-uploading it is no longer the
-- reasonable inference. It also means a deletion is recoverable, which is what
-- makes an owner-only trash bin possible.
--
-- Applied to every table carrying a sync_id, because EntitySync upserts all of
-- them and the resurrection is identical in each -- for line items and change
-- orders it also silently inflates job totals, which is why two devices showed
-- different money.

do $$
declare
  t text;
begin
  foreach t in array array[
    'jobs', 'fence_runs', 'estimate_line_items', 'change_orders', 'job_steps',
    'site_markers', 'time_entries', 'expenses', 'punch_list_items', 'employees',
    'manufacturers', 'material_items', 'pricing_tiers', 'customers', 'field_changes'
  ]
  loop
    execute format('alter table public.%I add column if not exists deleted_at timestamptz', t);
    execute format('alter table public.%I add column if not exists deleted_by text not null default ''''', t);
    -- Every read filters on this, so it earns an index.
    execute format(
      'create index if not exists %I on public.%I (company_id, deleted_at)',
      t || '_deleted_idx', t
    );
  end loop;
end $$;

comment on column public.jobs.deleted_at is
  'Set instead of removing the row. A hard delete is invisible to other devices, which re-upload the record they still hold locally.';

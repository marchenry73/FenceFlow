-- ============================================================
-- FenceFlow -- line items remember their fence run
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- RUN THIS BEFORE INSTALLING THE MATCHING BUILD. The app now sends
-- fence_run_sync_id with every estimate line, and Postgres rejects a write
-- naming a column that doesn't exist -- so without this, syncing estimates
-- fails outright.
--
-- Why it exists: the pull had no idea which run a line item belonged to, so
-- every line came back down as an orphan under "Other Items", sitting next to
-- the real ones. That is where the stray items nobody could account for came
-- from.
-- ============================================================

alter table estimate_line_items
    add column if not exists fence_run_sync_id text;

create index if not exists estimate_line_items_run_idx
    on estimate_line_items (fence_run_sync_id);

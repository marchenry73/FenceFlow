-- ============================================================
-- FenceFlow -- change order materials
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- Change orders can now record how much of the extra charge is materials you
-- have to buy up front, so the suggested deposit covers the extra work too
-- instead of you fronting it.
-- ============================================================

alter table change_orders add column if not exists material_cost double precision not null default 0;

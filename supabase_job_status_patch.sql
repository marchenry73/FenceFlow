-- ============================================================
-- FenceFlow -- held-up jobs
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- Records why a job could not be finished and what the customer has to clear,
-- so the office and the website see the same reason the crew wrote on site.
-- ============================================================

alter table jobs add column if not exists blocked_reason      text not null default '';
alter table jobs add column if not exists customer_must_clear text not null default '';
alter table jobs add column if not exists duration_manually_set boolean not null default false;

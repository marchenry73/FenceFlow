-- A chargeback, on the job it happened to.
--
-- Neither payment webhook handled a dispute. The bank pulls the money back, the
-- job goes on reading paid in full, and because the paid figure is latched
-- read-only once a processor has touched it, the office cannot even correct it
-- by hand. Nothing was written, logged or sent. The first anybody learned of it
-- was a bank statement.
--
-- Two separate things are recorded, because they happen at different times and
-- mean different things:
--
--   the dispute      somebody is contesting the charge. The money is usually
--                    still there. This is a warning and a deadline.
--   funds withdrawn  the money has actually gone. That belongs in the ledger
--                    as a negative row, exactly like a refund, because the
--                    ledger is what the office's figures are summed from.
--
-- This file records the first. The second reuses the refund path that already
-- exists, so there is one way money leaves a job rather than two.
alter table jobs
  add column if not exists dispute_opened_at   timestamptz,
  add column if not exists dispute_closed_at   timestamptz,
  add column if not exists dispute_status      text,
  add column if not exists dispute_reason      text,
  add column if not exists dispute_amount      numeric;

comment on column jobs.dispute_status is
  'Whatever the processor calls it: needs_response, under_review, won, lost. Stored as they send it rather than mapped, because a mapping that loses a state is worse than a word the office has to look up once.';

comment on column jobs.dispute_opened_at is
  'Set once, by webhook. A second dispute on the same job overwrites the detail but the office has already been told about the first.';

-- Undo:
--   alter table jobs
--     drop column if exists dispute_opened_at, drop column if exists dispute_closed_at,
--     drop column if exists dispute_status, drop column if exists dispute_reason,
--     drop column if exists dispute_amount;

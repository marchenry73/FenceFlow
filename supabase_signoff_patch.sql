-- The customer's sign-off on the finished work.
--
-- Kept apart from the acceptance signature on purpose: one records "I agree to
-- this price", the other records "this was built right". Collapsing them into
-- one field would mean that when a customer says a gate never latched, the only
-- signature on file is the one they gave before the work started.
alter table jobs
  add column if not exists final_sign_off_storage_path text,
  add column if not exists final_sign_off_at timestamptz;

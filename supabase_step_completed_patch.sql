-- When a checklist step was ticked.
--
-- The app records this locally but never sent it, so the cloud copy carried
-- only a bare true/false with no way to tell which side was more recent. The
-- consequence was worse than a lost timestamp: a tick saved locally, the pull
-- overwrote it with the cloud's false, and the next push then uploaded that
-- false -- so the tick could never reach the cloud and always reverted on the
-- phone. The crew ticked the walkthrough and it did not save.
--
-- Additive and safe: existing rows get null, meaning "never ticked", which is
-- exactly what a row with checked = false already means.
alter table public.job_steps
  add column if not exists completed_at timestamptz;

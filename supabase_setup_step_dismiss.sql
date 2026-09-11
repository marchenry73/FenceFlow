-- Per-user dismissal of the small, non-essential setup-checklist reminders
-- (office console launch feedback, 2026-09-11): "Finishing setting up your
-- shop... the necessary stuff needs immediate, but small stuff, I can just
-- get a reminder, I should be able to dismiss them."
--
-- my_setup_progress() (supabase_setup_progress_patch.sql) already tags each
-- step essential true/false: labour_rate, markup, min_charge and tax_rate
-- are essential (a quote is arithmetic on them), catalog, tiers and crew are
-- not. The dashboard now only ever offers a Dismiss button on a
-- non-essential step -- this column has nothing to do with whether an
-- essential step can be hidden, because it can't.
--
-- Reuses notification_prefs (supabase_notification_prefs.sql), the table
-- already built for exactly this shape: one row per user, RLS already
-- restricts every select/insert/update to `user_id = auth.uid()`, so a
-- dismissal can never hide a step from anybody else's copy of the
-- checklist. Purely additive -- no existing column, row or policy changes.
alter table public.notification_prefs
  add column if not exists dismissed_setup_steps text[] not null default '{}';

select 'setup step dismissal installed' as done;

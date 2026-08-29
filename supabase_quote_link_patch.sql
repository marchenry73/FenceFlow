-- The customer-facing quote page.
--
-- Jobber's single best weapon is the Client Hub: the homeowner opens a link,
-- sees the quote, approves it, pays the deposit. FenceFlow had no way for a
-- homeowner to see anything at all. This patch is the server half of that
-- page.
--
-- The token is the whole security model for a homeowner: unguessable uuid,
-- one per job, handed out by the contractor. Anonymous key-holders reach ONLY
-- the quote-view edge function, which serves a whitelisted set of fields --
-- RLS stays closed, supplier costs never leave the building.
alter table public.jobs
  add column if not exists quote_token uuid not null default gen_random_uuid(),
  add column if not exists quote_sent_at timestamptz,
  add column if not exists quote_viewed_at timestamptz,
  add column if not exists quote_approved_at timestamptz,
  add column if not exists quote_approved_name text not null default '';

comment on column public.jobs.quote_token is
  'Unguessable key a homeowner uses to view and approve this quote via the quote-view function. Rotating it revokes the old link.';

create index if not exists jobs_quote_token_idx on public.jobs (quote_token);

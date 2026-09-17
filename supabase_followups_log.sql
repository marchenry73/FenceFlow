-- follow_up_log -- the send record and the double-send guard.
--
-- Same shape as automation_runs (supabase_automation.sql): append-only,
-- unique constraint claimed BEFORE acting, RLS read-only for the company,
-- no client write policy at all. The edge function runs as service_role
-- and is the only writer.

create table if not exists public.follow_up_log (
    id           uuid primary key default gen_random_uuid(),
    company_id   uuid not null references public.companies(id) on delete cascade,
    job_sync_id  uuid not null,
    -- Fixed catalog, mirrors follow_up_settings' four per-kind flags. Kept
    -- in sync with the CHECK below and send-follow-ups' own switch.
    kind         text not null check (kind in (
                     'new_lead_not_contacted',
                     'quote_sent_no_view',
                     'quote_viewed_not_approved',
                     'approved_no_deposit'
                 )),
    -- The stage value the due-check was evaluated against at send time
    -- (e.g. the job's status, or a timestamp truncated to the day) --
    -- folded into the uniqueness constraint so a job that leaves and later
    -- re-enters the same kind's condition (e.g. re-quoted, re-sent) is
    -- treated as a new occurrence rather than permanently blocked by the
    -- first send. A plain (company, job, kind) unique constraint would
    -- make a job's SECOND legitimate quote-sent-no-view follow-up
    -- (after being re-quoted) impossible to ever send again.
    stage_key    text not null,
    channel      text not null default 'email',
    sent_at      timestamptz not null default now(),
    message_id   text,
    unique (company_id, job_sync_id, kind, stage_key)
);

create index if not exists follow_up_log_company_idx on public.follow_up_log(company_id, sent_at desc);

alter table public.follow_up_log enable row level security;

drop policy if exists follow_up_log_read on public.follow_up_log;
create policy follow_up_log_read on public.follow_up_log
    for select using (company_id = public.current_company_id());

-- No insert/update/delete policy for authenticated/anon at all. The unique
-- constraint above is claimed by the service-role edge function with
-- `insert ... on conflict do nothing` BEFORE sending -- see send-follow-ups
-- -- so a crash between claiming the row and the mail provider's response
-- shows up as "logged but the email may not have gone out" rather than
-- "sent twice", which is the safer failure direction for a sales nudge.

comment on table public.follow_up_log is
  'Append-only record of every follow-up email sent (or claimed-then-failed). Written only by the send-follow-ups service-role function. The unique constraint on (company_id, job_sync_id, kind, stage_key) is what makes a double-send impossible.';

select 'follow-up log installed' as done;

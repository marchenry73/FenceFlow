-- Where the attention sweep records what it found, with the dedup that
-- makes "the same finding is recorded once" a database guarantee rather
-- than a promise the edge function has to keep on its own.
--
-- Not automation_flags (supabase_automation.sql). That table's dedup is
-- borrowed from automation_runs' "this rule has fired on this job, ever"
-- unique constraint -- right for an automation that ACTS once (moves a
-- stage, and must never move it twice), wrong for a sweep that only
-- OBSERVES and must re-raise a finding if the underlying fact recurs (a
-- deposit that was missing, got collected, then the job was refunded back
-- to zero; a permit that lapses again after being fixed). The alert panel
-- itself already solved exactly this with a fingerprint
-- (website/dashboard.html's seen_alerts: "a changed fingerprint brings the
-- alert back") -- this table uses the same idea rather than inventing a
-- second one: dedup key is (company, detector, job, fingerprint), so the
-- SAME occurrence is recorded once, but a NEW occurrence of the same
-- detector on the same job is not silently swallowed by a constraint meant
-- for a different kind of table.
create table if not exists public.attention_findings (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references public.companies(id) on delete cascade,
    job_sync_id   uuid not null,
    -- Same key space as ALERT_DEFS in website/dashboard.html on purpose --
    -- see supabase/functions/attention-sweep/index.ts for exactly which
    -- keys this writes. Reusing the keys means the per-person mute list
    -- (notification_prefs.muted_alerts) already applies with no new column.
    detector      text not null,
    severity      text not null default 'critical' check (severity in ('critical','warn','info')),
    message       text not null,
    -- Whatever value identifies THIS occurrence -- usually the timestamp or
    -- status string the office's own detector fingerprints on (see the
    -- fp: ... fields next to each ALERT_DEFS push site). Never blank: a
    -- blank fingerprint would collapse every occurrence of a detector on a
    -- job into the same dedup key forever.
    fp            text not null,
    created_at    timestamptz not null default now(),
    notified_at   timestamptz,
    cleared_at    timestamptz,
    cleared_by    uuid references public.profiles(id),
    unique (company_id, detector, job_sync_id, fp)
);

create index if not exists attention_findings_company_open
    on public.attention_findings(company_id, cleared_at);

alter table public.attention_findings enable row level security;

-- Read-only for the company -- same shape as automation_flags: office
-- visibility (today: nothing on this page reads it yet, kept consistent
-- with the rest of this file's audit trail so a future screen can) without
-- ever letting a client write a finding into existence.
drop policy if exists attention_findings_read on public.attention_findings;
create policy attention_findings_read on public.attention_findings
    for select using (company_id = public.current_company_id());

-- No client-writable policy. Only the attention-sweep edge function
-- (service_role, which bypasses RLS entirely) ever inserts a row, and only
-- clear_attention_finding() below ever updates one -- append-only in the
-- same sense automation_flags is: clearing stamps cleared_at, it never
-- deletes, so "the sweep found this and nobody looked" stays provable.
create or replace function public.clear_attention_finding(p_finding_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
    co uuid := public.current_company_id();
begin
    if co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if not coalesce(public.has_permission('EDIT_JOBS'), false) then
        raise exception 'You cannot clear this finding.' using errcode = '42501';
    end if;

    update public.attention_findings
       set cleared_at = now(), cleared_by = auth.uid()
     where id = p_finding_id and company_id = co and cleared_at is null;
end;
$$;

revoke execute on function public.clear_attention_finding(uuid) from public, anon;
grant  execute on function public.clear_attention_finding(uuid) to authenticated;

comment on table public.attention_findings is
  'What the server-side attention sweep found, deduped per (company, detector, job, fingerprint). Written only by supabase/functions/attention-sweep (service_role); cleared only by clear_attention_finding().';

select 'attention findings installed' as done;

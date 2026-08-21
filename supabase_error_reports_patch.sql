-- Crashes, where you will actually see them.
--
-- When the app dies on a customer's phone you never hear about it -- they just
-- quietly stop using it. That is the failure mode that kills a product with
-- five customers, because five people leaving is all of them.
--
-- Deliberately not Crashlytics. This lands next to the companies on the admin
-- page you already open, attributed to the company it came from, instead of in
-- a separate console nobody remembers to check. One place to look beats a
-- better tool you never open.
create table if not exists public.app_errors (
    id           bigserial primary key,
    at           timestamptz not null default now(),
    company_id   uuid,                -- null when it crashed before sign-in
    reported_by  uuid,
    email        text,
    version_code int,
    version_name text,
    android      text,                -- release + device model
    fatal        boolean not null default true,
    where_at     text not null default '',   -- the screen or operation
    message      text not null default '',
    stack        text not null default '',
    seen         boolean not null default false
);

create index if not exists app_errors_at on public.app_errors (at desc);

alter table public.app_errors enable row level security;

-- Anyone signed in may REPORT a crash. That has to include somebody whose
-- company is suspended or whose trial lapsed -- their crashes are exactly the
-- ones worth seeing, and a reporting path that switches off with billing tells
-- you nothing on the day it matters.
drop policy if exists app_errors_insert on public.app_errors;
create policy app_errors_insert on public.app_errors
    for insert with check (auth.role() = 'authenticated');

-- Only the platform admin reads them. A stack trace can carry fragments of
-- whatever was on screen, so it is not a company's own record to browse.
drop policy if exists app_errors_read on public.app_errors;
create policy app_errors_read on public.app_errors
    for select using (is_platform_admin());

drop policy if exists app_errors_update on public.app_errors;
create policy app_errors_update on public.app_errors
    for update using (is_platform_admin());

/**
 * Recent crashes, grouped so twenty copies of one bug read as one problem.
 *
 * A flat list of individual crashes is unreadable the moment anything is
 * genuinely broken -- the loudest bug buries every other one.
 */
create or replace function public.admin_error_summary(days int default 14)
returns table (
    message      text,
    where_at     text,
    occurrences  bigint,
    devices      bigint,
    companies    bigint,
    first_seen   timestamptz,
    last_seen    timestamptz,
    worst_version text,
    sample_stack text,
    any_unseen   boolean
)
language sql security definer set search_path = public as $$
    select e.message,
           e.where_at,
           count(*),
           count(distinct e.android),
           count(distinct e.company_id),
           min(e.at),
           max(e.at),
           (array_agg(e.version_name order by e.at desc))[1],
           (array_agg(e.stack order by e.at desc))[1],
           bool_or(not e.seen)
    from app_errors e
    where is_platform_admin()
      and e.at > now() - make_interval(days => days)
    group by e.message, e.where_at
    order by bool_or(not e.seen) desc, max(e.at) desc;
$$;

select 'error reporting installed' as done;

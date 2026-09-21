-- ============================================================
-- FenceFlow -- an auth audit trail for the staff console
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- AUDIT_2026-09-18_PHASE1.md P1 "Auth" cluster / scratchpad/audit3/auth.md
-- P1-5: auth.audit_log_entries has 0 rows against 8 users, 16 sessions and a
-- session 36 days old -- "was this account accessed, and when" is
-- unanswerable after a week, and nothing can alert on a burst of failed
-- sign-ins against the one console that can suspend every company
-- (admin.html). This is FenceFlow's OWN event log for that console, kept in
-- a table the app controls rather than relying on hosted GoTrue log
-- retention.
--
-- Additive: one table, one index set, RLS, and two SECURITY DEFINER
-- functions. Nothing existing changes.
-- ============================================================

-- ---------- 1. The table ----------
-- One row per auth-relevant event on the staff console. user_id is nullable
-- because a failed sign-in against an email with NO matching account still
-- needs to be recorded (see record_sign_in_failure below) -- there is no
-- authenticated caller to attribute it to, and no account to point at.
create table if not exists public.auth_events (
    id          uuid primary key default gen_random_uuid(),
    user_id     uuid references auth.users(id) on delete set null,
    event_type  text not null check (event_type in (
        'sign_in_success',
        'sign_in_failure',
        'mfa_challenge_success',
        'mfa_challenge_failure',
        'mfa_enroll',
        'mfa_unenroll',
        'sign_out',
        -- Fired when a session's second factor has gone stale (more than 12h
        -- since the last code, or never given one this session -- see
        -- website/admin.html's secondFactorDue()) and the code prompt is
        -- shown again. The code entered in response is its own
        -- mfa_challenge_success/failure row; this row is the "asked again"
        -- half of P1-6.
        'mfa_reauth_required'
    )),
    success     boolean not null,
    user_agent  text,
    -- Free-text context, e.g. which reauth reason ('stale' | 'missing') or
    -- which sign-out scope ('local' | 'global'). NEVER a password, a code,
    -- or a token -- see the hard rule below, enforced by convention here
    -- since Postgres cannot inspect the caller's intent.
    detail      text,
    created_at  timestamptz not null default now()
);

create index if not exists auth_events_user_id_idx  on public.auth_events (user_id, created_at desc);
create index if not exists auth_events_created_idx  on public.auth_events (created_at desc);
create index if not exists auth_events_type_idx     on public.auth_events (event_type);

comment on table public.auth_events is
  'FenceFlow''s own auth audit trail for the staff console (admin.html) -- P1-5 in AUDIT_2026-09-18_PHASE1.md. '
  'Never store a password, a code, or a token in any column, including detail. '
  'RETENTION: no automatic purge exists yet. RLS denies update/delete to every '
  'client role (authenticated and anon) by design -- see the hard rule this file was built '
  'under -- so a client can never tamper with or thin this table. The only way to '
  'purge old rows is a service-role (or postgres-role) maintenance job, which bypasses '
  'RLS the way every Supabase migration already does; none has been written. Until one '
  'exists this table grows without bound. A reasonable default, not decided here: keep '
  '180-400 days (long enough to catch a slow-burn compromise, per the 36-day-old live '
  'session this audit already found) and add a scheduled `delete from auth_events where '
  'created_at < now() - interval ''N days''` run as service_role or via pg_cron.';

alter table public.auth_events enable row level security;

-- ---------- 2. Read: platform admins only ----------
-- is_platform_admin() already exists (supabase_platform_admin_patch.sql) and
-- is what admin.html itself gates entry on -- reusing it here means "who can
-- read the audit trail" can never drift from "who the console already lets
-- in as staff."
drop policy if exists auth_events_admin_read on public.auth_events;
create policy auth_events_admin_read on public.auth_events
    for select using (public.is_platform_admin());

-- No insert/update/delete policy is defined for ANY role, on purpose. RLS
-- denies a command with no matching policy by default, so this table has no
-- direct-write path for authenticated or anon at all, admin included --
-- writes only happen through the SECURITY DEFINER functions below, which
-- run as the function owner and are therefore not subject to grants or
-- policies on this table. That is also why there is no grant of
-- insert/update/delete to anyone below: none would do anything, and leaving
-- them out says so.
revoke all on public.auth_events from public, anon, authenticated;
grant select on public.auth_events to authenticated;

-- ---------- 3. Write, for a signed-in caller's OWN events ----------
-- Deliberately has no parameter that names a target user: the only identity
-- it ever writes is auth.uid(), so there is no argument shape through which
-- a caller could even ATTEMPT to log an event against someone else's
-- account. That is the whole of how "cannot forge events for someone else"
-- is enforced here -- not a runtime check that could be gotten wrong, but a
-- signature that has nothing to check.
--
-- Requires an authenticated caller. Per the service-role-guard-trap lesson:
-- auth.uid() is null for an anonymous caller too, so the guard below is
-- "reject when null," never "allow when null."
create or replace function public.record_auth_event(
    p_event_type text,
    p_success    boolean,
    p_user_agent text default null,
    p_detail     text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if p_event_type not in (
        'sign_in_success', 'sign_in_failure',
        'mfa_challenge_success', 'mfa_challenge_failure',
        'mfa_enroll', 'mfa_unenroll',
        'sign_out', 'mfa_reauth_required'
    ) then
        raise exception 'Unknown event_type.' using errcode = '22023';
    end if;

    insert into public.auth_events (user_id, event_type, success, user_agent, detail)
    values (
        auth.uid(),
        p_event_type,
        p_success,
        left(coalesce(p_user_agent, ''), 500),
        left(coalesce(p_detail, ''), 500)
    );
end;
$$;

revoke all on function public.record_auth_event(text, boolean, text, text) from public, anon;
grant execute on function public.record_auth_event(text, boolean, text, text) to authenticated;

-- ---------- 4. Write, for a sign-in that never produced a session ----------
-- SUPERSEDED -- see supabase_p4_auth_events_fix.sql. The version below lets
-- anon attribute a failure to ANY account (it resolves the email to a
-- user_id), leaks whether an address exists, and its per-target cap lets 20
-- fake rows mute an account. Re-running this file alone puts it back; always
-- run the fix file after it.
--
-- A failed password sign-in has no auth.uid() to attribute it to -- there is
-- no session at all -- so it cannot go through record_auth_event above. This
-- is the one deliberately anon-callable entry point in this file, and it is
-- narrow on purpose: the event_type is hardcoded to 'sign_in_failure' and
-- success to false, regardless of anything the caller sends, so it cannot be
-- repurposed to write any other kind of row.
--
-- It resolves the attempted email to a user_id server-side (this function
-- runs as its owner, which can read auth.users; the caller never can) but
-- does NOT store the email itself anywhere -- only the resolved user_id, or
-- null when the address matches no account. That keeps this table free of
-- attacker-supplied free text tied to an unauthenticated caller.
--
-- Basic flood guards only: this is a public, unauthenticated endpoint by
-- necessity, so it is capped rather than unbounded. Real rate limiting (by
-- IP, with a lockout) is out of scope for a SQL-only, admin.html-only
-- change and is called out in this track's open questions.
create or replace function public.record_sign_in_failure(
    p_email      text,
    p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    resolved_id uuid;
    recent_count integer;
begin
    if p_email is null or btrim(p_email) = '' then
        return; -- nothing to attribute; not worth a row
    end if;

    select id into resolved_id
    from auth.users
    where lower(email) = lower(btrim(p_email))
    limit 1;

    if resolved_id is not null then
        select count(*) into recent_count
        from public.auth_events
        where user_id = resolved_id
          and event_type = 'sign_in_failure'
          and created_at > now() - interval '15 minutes';
        if recent_count >= 20 then
            return; -- already well past "somebody is guessing this password"; skip logging more
        end if;
    else
        select count(*) into recent_count
        from public.auth_events
        where user_id is null
          and event_type = 'sign_in_failure'
          and created_at > now() - interval '5 minutes';
        if recent_count >= 200 then
            return; -- crude flood guard against scripted attempts with made-up addresses
        end if;
    end if;

    insert into public.auth_events (user_id, event_type, success, user_agent, detail)
    values (resolved_id, 'sign_in_failure', false, left(coalesce(p_user_agent, ''), 500), null);
end;
$$;

revoke all on function public.record_sign_in_failure(text, text) from public;
grant execute on function public.record_sign_in_failure(text, text) to anon, authenticated;

select 'auth_events installed' as done;

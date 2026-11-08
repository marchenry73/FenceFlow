-- ============================================================
-- FenceFlow -- one guest demo per device, remembered on the server
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- Owner's decision, 7 Nov 2026: a visitor who installs the app gets ONE
-- 15-minute demo, and after it they either buy or sign in. Today the clock is
-- GuestSession.DURATION_MS (1 hour) kept in the handset's own DataStore --
-- "Device-local only, never synced: guest mode never talks to the cloud" --
-- so deleting the app and reinstalling it starts a fresh hour, for ever.
--
-- WHAT THIS TABLE IS, AND WHY IT CANNOT BE device_keys. Both existing device
-- tables (device_keys, device_tokens) are scoped by company_id and tied to an
-- account. A guest has neither: no company, no user, no session. This is the
-- only record in the schema keyed on a device alone.
--
-- ------------------------------------------------------------------------
-- IT STORES A HASH, NEVER THE IDENTIFIER
-- ------------------------------------------------------------------------
-- device_hash is sha256(pepper || ANDROID_ID), computed by the edge function
-- from a secret this table never sees. The raw ANDROID_ID is never written
-- down. That matters for two reasons beyond good manners:
--   * ANDROID_ID is a persistent device identifier, and Google's rules on
--     those are tightening, not loosening. A hash with a server-side pepper
--     is not reversible by anyone who gets this table.
--   * This row says one thing only -- "this device has had its free demo".
--     It carries no account, no name, no location and no company, so it
--     cannot be joined to a person.
--
-- ANDROID_ID survives deleting the app, clearing its data and reinstalling,
-- because it is keyed to the app's signing key and the device. It does NOT
-- survive a factory reset. Surviving a reset needs Play Integrity's device
-- recall, which requires the app to be distributed through Google Play --
-- FenceFlow is a direct APK download served by apk-proxy -- and is in any
-- case still beta behind an interest form. Checked 7 Nov 2026 and parked by
-- the owner, deliberately: a factory reset wipes the whole phone to save the
-- price of one month.
--
-- ------------------------------------------------------------------------
-- NOBODY BUT THE SERVER MAY READ OR WRITE IT
-- ------------------------------------------------------------------------
-- Supabase's default privileges hand every new table in `public` to anon and
-- authenticated. That has bitten this project before, so the grants are taken
-- away explicitly here AND checked in PART 3 with a canary -- a grant check
-- that cannot fail is not a check.
--
-- RLS is on with NO policies, which denies everything to anon and
-- authenticated even if a grant comes back. The edge function reaches it with
-- the service role, which bypasses RLS by design.
--
-- Idempotent. PART 3 raises rather than reporting.
-- ============================================================

begin;

-- ------------------------------------------------------------------------
-- PART 1  the record
-- ------------------------------------------------------------------------
create table if not exists public.guest_device_trials (
    -- sha256(pepper || ANDROID_ID), hex. Never the identifier itself.
    device_hash     text primary key,
    first_seen_at   timestamptz not null default now(),
    -- When this device's one demo runs out. Set once, on the first claim, and
    -- never extended: the whole point is that it cannot be restarted.
    expires_at      timestamptz not null,
    -- Whether the first claim reached the server. An offline start gets the
    -- shorter demo (5 minutes) and is topped up to the full 15 the first time
    -- the phone can actually reach us -- so a dead spot costs the visitor a
    -- shorter look, not the whole app.
    started_online  boolean not null default true,
    -- Bookkeeping only. Never used to decide anything, so a stale value
    -- cannot change who gets a demo.
    last_seen_at    timestamptz not null default now(),
    app_version     text not null default ''
);

comment on table public.guest_device_trials is
  'One row per device that has started the guest demo. Keyed on sha256(pepper || ANDROID_ID) -- never the raw identifier. No account, no company, no name: it says only "this device has had its free demo". Written solely by the guest-trial edge function under the service role.';

-- Finding the expired ones to tidy up later, without scanning the table.
create index if not exists guest_device_trials_expires_idx
    on public.guest_device_trials (expires_at);

-- ------------------------------------------------------------------------
-- PART 2  shut it to everyone but the service role
-- ------------------------------------------------------------------------
alter table public.guest_device_trials enable row level security;

-- Deliberately NO policies. With RLS on and none defined, anon and
-- authenticated get nothing; the service role bypasses RLS and is the only
-- thing that touches this table.

revoke all on public.guest_device_trials from anon;
revoke all on public.guest_device_trials from authenticated;
revoke all on public.guest_device_trials from public;

-- ------------------------------------------------------------------------
-- PART 3  prove it. Every check raises rather than reporting.
-- ------------------------------------------------------------------------
do $$
declare n int;
begin
    if to_regclass('public.guest_device_trials') is null then
        raise exception 'r73: the table is missing';
    end if;

    if not (select relrowsecurity from pg_class
             where oid = 'public.guest_device_trials'::regclass) then
        raise exception 'r73: row level security is OFF on guest_device_trials';
    end if;

    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = 'guest_device_trials';
    if n <> 0 then
        raise exception 'r73: guest_device_trials has % policy/policies; it is meant to be reachable only by the service role', n;
    end if;

    -- THE GRANT, which is the half that comes back on its own.
    select count(*) into n from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'guest_device_trials'
       and grantee in ('anon', 'authenticated', 'PUBLIC');
    if n <> 0 then
        raise exception 'r73: % grant(s) to anon/authenticated/PUBLIC survive on guest_device_trials', n;
    end if;

    -- CANARY for the check above. If this query cannot see grants at all it
    -- returns zero for everything, and the check would pass on a table that
    -- is wide open. `companies` is granted to authenticated per-column, so a
    -- working query MUST find rows for it.
    select count(*) into n from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'companies'
       and grantee = 'authenticated';
    if n = 0 then
        raise exception 'r73: the grant query sees nothing even for companies, so the check above proved nothing';
    end if;

    raise notice 'r73 OK: one demo per device, readable only by the server';
end $$;

commit;

-- ------------------------------------------------------------------------
-- STILL OPEN after this
-- ------------------------------------------------------------------------
--   1. Nothing writes this yet. The guest-trial edge function and the app's
--      side are the next pieces; until both ship, the demo is unchanged.
--   2. A factory reset still earns a fresh demo. Play Integrity device recall
--      is the only sanctioned way to close that, and it needs the app on
--      Google Play. Parked by the owner 7 Nov 2026.
--   3. Nothing prunes expired rows. One row per device that ever tried the
--      app is small, but it grows for ever until something tidies it.

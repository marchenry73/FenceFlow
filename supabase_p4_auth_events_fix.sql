-- ============================================================
-- FenceFlow -- auth_events: an anonymous caller can no longer put a name on an event
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
-- Run AFTER supabase_p4_auth_events.sql. Re-running that file on its own puts
-- the old record_sign_in_failure back; run this one again after it.
--
-- THE HOLE (proved live, see supabase_p4_auth_events_fix_probe.sql, section C):
-- record_sign_in_failure() is callable by anon -- it has to be, a failed
-- password sign-in has no session -- and it took the attempted email, looked
-- it up in auth.users, and wrote a 'sign_in_failure' row carrying that
-- account's user_id. So anybody, signed in or not, could:
--   * fabricate failed sign-ins against ANY known account, the platform admin
--     included, with free text of their choosing in user_agent;
--   * silence the log for one account: the per-target cap (20 per 15 minutes
--     per user_id) meant 20 fake rows made the next REAL attack go unrecorded;
--   * learn whether an address has an account, from the row shape (user_id set
--     or null) and from the cost of the lookup.
-- That defeats the log's whole purpose: "was this account attacked, and when"
-- became forgeable, and a real burst could be buried or muted.
--
-- THE RULE NOW: a row written by an unauthenticated endpoint never carries a
-- user_id, and the endpoint never consults auth.users, so it cannot reveal
-- whether an address exists -- same response and same row shape either way.
-- What it stores instead:
--   client_reported = true   -- the staff panel shows these as UNVERIFIED
--   attempt_key              -- keyed hash (HMAC-SHA256) of the normalised
--                               attempted identifier, so staff can group repeat
--                               attempts at one address without the address
--                               ever being stored or guessable from the table
--   source_key               -- keyed hash of the caller's network address as
--                               the API edge reported it (best effort, below)
-- A table constraint enforces the shape, so no future function can quietly put
-- a user_id back on a client-reported row.
--
-- Signed-in events (record_auth_event) are NOT touched: they already write
-- only auth.uid() and take no argument naming a user. Its body is unchanged.
--
-- Every client-supplied text column, on every insert path, is stripped of
-- control and invisible/bidi characters and capped (a BEFORE INSERT trigger,
-- so record_auth_event's rows get it too without changing that function).
--
-- FLOOD GUARD, now per-source and global -- never per-target:
--   per source  30 per 15 minutes  (a single script cannot burn the budget)
--   global     200 per  5 minutes  (the table cannot be grown without bound)
-- Nothing counts attempts per address, so there is no longer any way to use
-- the guard to mute one account. A dropped report is not silent: it is tallied
-- per hour in auth_events_suppressed and the staff panel shows the total --
-- a flood is itself evidence of an attack.
--
-- KNOWN LIMITS, stated rather than hidden:
--   * The source is read from the request headers PostgREST exposes
--     (cf-connecting-ip, then x-real-ip, then the first x-forwarded-for hop).
--     If only x-forwarded-for reaches the database, the first hop is whatever
--     the client sent, so a scripted caller can rotate "sources". That buys
--     them their own per-source budgets and nothing else: it cannot attribute
--     a row, cannot target one account, and is still bounded by the global cap
--     (whose drops are tallied, not silent).
--   * An unauthenticated report is, by construction, unverifiable -- anyone
--     can report a failure at any address, exactly as anyone can really try
--     one. The panel says "unverified" for that reason. A server-verified
--     failure needs GoTrue's password-verification hook, not a client call.
--   * The HMAC key lives in Supabase Vault (auth_events_hmac_key), created
--     here from gen_random_bytes and never printed. Rotating it (deleting the
--     secret and re-running this file) splits grouping across the rotation.
-- ============================================================

-- ---------- 1. The key, in Vault ----------
do $$
begin
    if not exists (select 1 from vault.secrets where name = 'auth_events_hmac_key') then
        perform vault.create_secret(
            encode(extensions.gen_random_bytes(32), 'hex'),
            'auth_events_hmac_key',
            'HMAC key for public.auth_events.attempt_key / source_key (supabase_p4_auth_events_fix.sql). '
            'Never expose. Rotating it splits grouping of repeat attempts across the rotation.');
    end if;
end $$;

-- ---------- 2. Columns and the shape constraint ----------
alter table public.auth_events add column if not exists client_reported boolean not null default false;
alter table public.auth_events add column if not exists attempt_key text;
alter table public.auth_events add column if not exists source_key  text;

comment on column public.auth_events.client_reported is
  'true = written by the anonymous record_sign_in_failure endpoint. NOTHING in such a row was verified: '
  'not the address, not the user agent, not even that a sign-in was attempted. Never carries a user_id.';
comment on column public.auth_events.attempt_key is
  'Keyed hash (HMAC-SHA256, first 128 bits, hex) of the normalised attempted identifier. Groups repeat '
  'attempts at one address; the address itself is never stored. Only on client_reported rows.';
comment on column public.auth_events.source_key is
  'Keyed hash of the caller network address as the API edge reported it; best effort, may be null, and '
  'spoofable when only x-forwarded-for reaches the database. Only on client_reported rows.';

alter table public.auth_events drop constraint if exists auth_events_client_reported_shape;
alter table public.auth_events add constraint auth_events_client_reported_shape check (
    case when client_reported
         then user_id is null
              and event_type = 'sign_in_failure'
              and success = false
              and detail is null
              and attempt_key is not null
         else attempt_key is null and source_key is null
    end
);

create index if not exists auth_events_client_created_idx
    on public.auth_events (created_at desc) where client_reported;
create index if not exists auth_events_client_source_idx
    on public.auth_events (source_key, created_at desc) where client_reported;
create index if not exists auth_events_client_attempt_idx
    on public.auth_events (attempt_key, created_at desc) where client_reported;

-- ---------- 3. Where dropped reports are counted ----------
create table if not exists public.auth_events_suppressed (
    bucket     timestamptz not null,  -- the hour the reports were dropped in
    reason     text not null check (reason in ('source', 'global')),
    suppressed integer not null default 0 check (suppressed >= 0),
    primary key (bucket, reason)
);
comment on table public.auth_events_suppressed is
  'How many anonymous sign-in-failure reports the flood guard in record_sign_in_failure() dropped, per hour '
  'and reason. Read by platform admins only; written only by that function.';

alter table public.auth_events_suppressed enable row level security;
drop policy if exists auth_events_suppressed_admin_read on public.auth_events_suppressed;
create policy auth_events_suppressed_admin_read on public.auth_events_suppressed
    for select using (public.is_platform_admin());
revoke all on public.auth_events_suppressed from public, anon, authenticated;
grant select on public.auth_events_suppressed to authenticated;

-- ---------- 4. Helpers (none callable by a client) ----------
-- Strip control characters (C0, DEL, C1) and the invisible / direction-changing
-- ones that make text display as something it is not (zero-width, bidi
-- embeddings and overrides, line/paragraph separators, word joiner, BOM), then
-- cap. Bounded before the regex so a huge input costs nothing extra.
create or replace function public.auth_events_clean_text(p text, p_max integer)
returns text
language sql
immutable
set search_path = public
as $$
    select left(
        regexp_replace(
            left(p, p_max * 4),
            '[--؜᠎​-‏ -‮⁠-⁩﻿]',
            '', 'g'),
        p_max)
$$;

-- The one normal form an attempted identifier is hashed in: compatibility-
-- normalised (so a full-width lookalike groups with the plain address),
-- invisible characters removed, trimmed, lower-cased.
create or replace function public.auth_events_normalise_identifier(p text)
returns text
language sql
immutable
set search_path = public
as $$
    select lower(btrim(public.auth_events_clean_text(normalize(left(p, 1000), NFKC), 320)))
$$;

-- SECURITY INVOKER on purpose: it only works when the caller can already read
-- Vault, which inside the SECURITY DEFINER functions below is their owner.
-- Called directly by anon or authenticated it has no EXECUTE grant, and even
-- with one it could not read the secret.
create or replace function public.auth_events_hmac(p_kind text, p_value text)
returns text
language plpgsql
stable
set search_path = public
as $$
declare
    k text;
begin
    select decrypted_secret into k from vault.decrypted_secrets where name = 'auth_events_hmac_key';
    if k is null then
        raise exception 'The auth event log is not configured.' using errcode = '55000';
    end if;
    return left(encode(extensions.hmac(convert_to(p_kind || ':' || coalesce(p_value, ''), 'UTF8'),
                                       decode(k, 'hex'), 'sha256'), 'hex'), 32);
end;
$$;

-- The caller's network address as PostgREST passes it on, hashed. Best effort:
-- null when no header is there (a direct SQL connection, or an edge that
-- forwards none of these).
create or replace function public.auth_events_request_source()
returns text
language plpgsql
stable
set search_path = public
as $$
declare
    h  json;
    ip text;
begin
    begin
        h := nullif(current_setting('request.headers', true), '')::json;
    exception when others then
        return null;
    end;
    if h is null or json_typeof(h) <> 'object' then
        return null;
    end if;
    ip := coalesce(nullif(btrim(h ->> 'cf-connecting-ip'), ''),
                   nullif(btrim(h ->> 'x-real-ip'), ''),
                   nullif(btrim(split_part(h ->> 'x-forwarded-for', ',', 1)), ''));
    if ip is null then
        return null;
    end if;
    return public.auth_events_hmac('source', lower(public.auth_events_clean_text(ip, 64)));
end;
$$;

revoke all on function public.auth_events_clean_text(text, integer)        from public, anon, authenticated;
revoke all on function public.auth_events_normalise_identifier(text)       from public, anon, authenticated;
revoke all on function public.auth_events_hmac(text, text)                 from public, anon, authenticated;
revoke all on function public.auth_events_request_source()                 from public, anon, authenticated;

-- ---------- 5. Every insert path is sanitised ----------
-- A trigger rather than an edit to each function, so record_auth_event keeps
-- its exact body and still gets the same treatment. It only ever SHRINKS text;
-- it never sets or changes who a row is about.
create or replace function public.auth_events_before_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    new.user_agent := public.auth_events_clean_text(new.user_agent, 300);
    new.detail     := public.auth_events_clean_text(new.detail, 200);
    return new;
end;
$$;
revoke all on function public.auth_events_before_insert() from public, anon, authenticated;

drop trigger if exists auth_events_clean_text on public.auth_events;
create trigger auth_events_clean_text
    before insert on public.auth_events
    for each row execute function public.auth_events_before_insert();

-- ---------- 6. The anonymous endpoint, rebuilt ----------
-- Same name, same arguments, same (void) result, so website/admin.html's
-- existing call keeps working unchanged. What it no longer does: look the
-- address up, or write a user_id. The response is identical whether or not
-- the address has an account, whether the report is kept or dropped by the
-- flood guard, and whoever the caller is -- a browser still holding somebody's
-- session is treated exactly like an anonymous one, because the address it
-- names need not be its own.
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
    per_source_limit constant integer  := 30;
    per_source_span  constant interval := interval '15 minutes';
    global_limit     constant integer  := 200;
    global_span      constant interval := interval '5 minutes';
    ident     text;
    k_attempt text;
    k_source  text;
    n         integer;
    why       text;
begin
    ident := public.auth_events_normalise_identifier(p_email);
    if ident is null or ident = '' then
        return; -- nothing was attempted against anything; not worth a row
    end if;

    k_attempt := public.auth_events_hmac('identifier', ident);
    k_source  := public.auth_events_request_source();

    if k_source is not null then
        select count(*) into n
          from public.auth_events
         where client_reported
           and source_key = k_source
           and created_at > now() - per_source_span;
        if n >= per_source_limit then
            why := 'source';
        end if;
    end if;

    if why is null then
        select count(*) into n
          from public.auth_events
         where client_reported
           and created_at > now() - global_span;
        if n >= global_limit then
            why := 'global';
        end if;
    end if;

    if why is not null then
        insert into public.auth_events_suppressed (bucket, reason, suppressed)
        values (date_trunc('hour', now()), why, 1)
        on conflict (bucket, reason)
        do update set suppressed = public.auth_events_suppressed.suppressed + 1;
        return;
    end if;

    insert into public.auth_events
        (user_id, event_type, success, user_agent, detail, client_reported, attempt_key, source_key)
    values
        (null, 'sign_in_failure', false, p_user_agent, null, true, k_attempt, k_source);
end;
$$;

revoke all on function public.record_sign_in_failure(text, text) from public;
grant execute on function public.record_sign_in_failure(text, text) to anon, authenticated;

-- ---------- 7. What the staff panel needs to group ----------
-- The caller's OWN address, in the same keyed form, so the console can say
-- "these attempts were at your address". Takes no argument: it can never be
-- used to learn the key of an address that is not the caller's.
create or replace function public.my_auth_attempt_key()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    e text;
begin
    if auth.uid() is null then
        return null;
    end if;
    select email into e from auth.users where id = auth.uid();
    if e is null then
        return null;
    end if;
    return public.auth_events_hmac('identifier', public.auth_events_normalise_identifier(e));
end;
$$;
revoke all on function public.my_auth_attempt_key() from public, anon;
grant execute on function public.my_auth_attempt_key() to authenticated;

-- Unverified reports grouped by attempted address, newest first, the caller's
-- own address on top. SECURITY INVOKER: it reads auth_events under the
-- caller's own RLS, so for anyone but a platform admin it returns nothing --
-- the same rule the table already has, not a second copy of it.
create or replace function public.admin_sign_in_attempt_groups(
    p_days  integer default 7,
    p_limit integer default 20
)
returns table (
    attempt_key  text,
    attempts     bigint,
    sources      bigint,
    first_at     timestamptz,
    last_at      timestamptz,
    is_mine      boolean,
    total_groups bigint
)
language sql
stable
security invoker
set search_path = public
as $$
    with mine as (
        select public.my_auth_attempt_key() as k
    ),
    g as (
        select e.attempt_key                  as ak,
               count(*)                       as n,
               count(distinct e.source_key)   as s,
               min(e.created_at)              as f,
               max(e.created_at)              as l
          from public.auth_events e
         where e.client_reported
           and e.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 400)))
         group by e.attempt_key
    )
    select g.ak, g.n, g.s, g.f, g.l,
           coalesce(g.ak = (select k from mine), false),
           count(*) over ()
      from g
     order by coalesce(g.ak = (select k from mine), false) desc, g.l desc
     limit greatest(1, least(coalesce(p_limit, 20), 100))
$$;
revoke all on function public.admin_sign_in_attempt_groups(integer, integer) from public, anon;
grant execute on function public.admin_sign_in_attempt_groups(integer, integer) to authenticated;

-- ---------- 8. Unchanged, restated so a re-run cannot loosen them ----------
-- No insert/update/delete for any client role, admin included; read is
-- platform admins only (policy auth_events_admin_read, untouched).
revoke all on public.auth_events from public, anon, authenticated;
grant select on public.auth_events to authenticated;

notify pgrst, 'reload schema';

select 'auth_events fix installed' as done;

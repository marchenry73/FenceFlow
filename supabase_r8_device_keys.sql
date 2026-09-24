-- ============================================================
-- FenceFlow -- one device per crew login, and a key that lets another one in
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- NOT APPLIED YET ON PURPOSE. Read "THE ORDERING TRAP" before running it.
--
-- KIND
--   ADDITIVE           public.device_keys (a new table), mint_device_key(),
--                      revoke_device_key(), list_device_keys(), and one new
--                      company setting.
--   FUNCTION-REPLACING claim_device(). Its signature GAINS a defaulted second
--                      argument, which means the old one must be dropped first --
--                      and a plain CREATE resets a function's ACL, which is how
--                      anon got EXECUTE on job_costing() back once before. The
--                      grants are re-stated at the bottom for exactly that reason.
--   No row is deleted. Nothing about an existing sign-in changes until the switch
--   in PART 5 is turned on, per company, by hand.
--
-- WHAT THE OWNER ASKED FOR
--   "I'm able to login on another phone with the same account, This is not
--    supposed to happen... if someone is on crew plan, only one device unless they
--    sign out, also I want to be able to send them a key so they are able to login
--    on every new device, if not they are not able to."
--
-- WHAT IS TRUE TODAY, before this file
--   A single-device mechanism already exists and is live: profiles.active_device_id
--   plus claim_device() and device_still_mine(). But claim_device() ALWAYS wins --
--   it overwrites the holder unconditionally. So a second phone signing in is not
--   refused; the FIRST phone is evicted, and only notices the next time it is
--   opened. That was deliberate: it means losing a phone never locks anyone out.
--   Three gaps remain, and this file closes the first two:
--     1. no way to REFUSE a second device                        -- PART 3
--     2. no way to authorise one deliberately                    -- PART 2
--     3. enforcement is client-side only; nothing in RLS stops a displaced
--        device's raw API calls                                  -- NOT fixed here.
--   Gap 3 needs a policy on every table and is its own piece of work. Until it is
--   done, this is a lock on the app, not on the database. Said plainly because a
--   lock people believe in and that is not there is worse than no lock.
--
-- THE ORDERING TRAP -- why the switch defaults to OFF
--   A crew phone in the field is on build 1.279. It calls claim_device with ONE
--   argument and knows nothing about keys. If refusal were on by default, the
--   moment this file was applied that phone would be refused at its next sign-in
--   and the crew member would be locked out of his own work, with no way to let
--   himself back in. So: companies.settings -> require_device_key defaults to
--   false, refusal only happens when it is true, and it should only be turned on
--   once every crew phone is on a build that can pass a key and show a decent
--   message when refused.
--
-- THE OWNER IS NEVER REFUSED. Whatever the switch says, an OWNER always claims.
-- The person who would have to mint the key cannot be the person locked out.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  the keys themselves
-- ------------------------------------------------------------------------

create table if not exists public.device_keys (
    id            uuid primary key default gen_random_uuid(),
    company_id    uuid not null references public.companies(id) on delete cascade,
    -- What the owner reads out over the phone. Short enough to say aloud,
    -- unambiguous enough to hear: no O/0, no I/1/L.
    code          text not null,
    label         text not null default '',
    created_by    uuid,
    created_at    timestamptz not null default now(),
    expires_at    timestamptz not null default now() + interval '7 days',
    -- Set when it is used. A key is good once and once only: a code that keeps
    -- working is a password that never gets changed.
    used_at       timestamptz,
    used_by       uuid,
    used_device_id text,
    revoked_at    timestamptz
);

create unique index if not exists device_keys_company_code_idx
    on public.device_keys (company_id, upper(code));
create index if not exists device_keys_company_idx on public.device_keys (company_id);

comment on table public.device_keys is
    'One-shot codes that let an additional device claim a login when the company requires it. '
    'See supabase_r8_device_keys.sql.';

alter table public.device_keys enable row level security;

-- Read: anyone in the company who may see the crew list. Write: never directly --
-- the three functions below are the only door, and they are definer.
drop policy if exists device_keys_read on public.device_keys;
create policy device_keys_read on public.device_keys
    for select using (company_id = public.current_company_id());


-- ------------------------------------------------------------------------
-- PART 2  minting and revoking
-- ------------------------------------------------------------------------

create or replace function public.mint_device_key(p_label text default '', p_days int default 7)
 returns text
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  co uuid; me uuid := auth.uid(); my_role text; new_code text; tries int := 0;
begin
    if me is null then raise exception 'You must be signed in.'; end if;
    select p.company_id, p.role::text into co, my_role from profiles p where p.id = me;
    if co is null then raise exception 'You are not in a company.'; end if;
    -- Only the people who already decide who works here.
    if my_role not in ('OWNER', 'MANAGER') then
        raise exception 'Only an owner or a manager can give out a device key.'
          using errcode = '42501';
    end if;

    -- No O, no 0, no I, no 1, no L: this gets read out over a phone line from
    -- a van, and O/0 and I/1/L are what get heard wrong.
    --
    -- upper() FIRST, then translate. The other way round -- which is how this
    -- was written -- translates the uppercase O and I out and then upper()
    -- puts them straight back, because base64 also emits lowercase o and i.
    -- So the generator promised a code with no ambiguous characters and
    -- produced them anyway, roughly one code in three.
    loop
        new_code :=
            substr(translate(upper(encode(gen_random_bytes(12), 'base64')),
                             'O0I1L+/=', 'XYZWVUTS'), 1, 8);
        tries := tries + 1;
        exit when not exists (
            select 1 from device_keys k
             where k.company_id = co and upper(k.code) = upper(new_code));
        if tries > 20 then raise exception 'Could not make a unique code; try again.'; end if;
    end loop;

    insert into device_keys (company_id, code, label, created_by, expires_at)
    values (co, new_code, coalesce(p_label, ''), me,
            now() + make_interval(days => greatest(1, least(coalesce(p_days, 7), 30))));

    return new_code;
end;
$function$;

create or replace function public.revoke_device_key(p_code text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare co uuid; my_role text; n int;
begin
    if auth.uid() is null then raise exception 'You must be signed in.'; end if;
    select p.company_id, p.role::text into co, my_role from profiles p where p.id = auth.uid();
    if my_role not in ('OWNER', 'MANAGER') then
        raise exception 'Only an owner or a manager can revoke a device key.'
          using errcode = '42501';
    end if;
    update device_keys set revoked_at = now()
     where company_id = co and upper(code) = upper(btrim(p_code))
       and used_at is null and revoked_at is null;
    get diagnostics n = row_count;
    return n > 0;
end;
$function$;


-- ------------------------------------------------------------------------
-- PART 3  claim_device, which can now say no
--
-- The old signature is dropped so the defaulted second argument does not create
-- an ambiguous one-argument call. A phone on an older build still calls it with
-- one argument and still works -- that is what the default is for.
-- ------------------------------------------------------------------------

drop function if exists public.claim_device(text);

create or replace function public.claim_device(device_id text, key_code text default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  me uuid := auth.uid();
  co uuid; my_role text; holder text; needs_key boolean; k record;
begin
    if me is null then raise exception 'You must be signed in.'; end if;
    if coalesce(trim(device_id), '') = '' then
        return;  -- nothing to claim with; leave whatever is there alone
    end if;

    select p.company_id, p.role::text, p.active_device_id
      into co, my_role, holder
      from profiles p where p.id = me;

    -- Already this device: nothing to do, and never a reason to spend a key.
    if holder is not null and holder = device_id then
        update profiles set active_device_at = now() where id = me;
        return;
    end if;

    -- The owner always claims. The person who mints the keys cannot be the
    -- person locked out; that is not a lock, it is a trap.
    needs_key := coalesce((
        select (c.settings ->> 'require_device_key')::boolean
          from company_settings c where c.company_id = co), false)
      and my_role is distinct from 'OWNER'
      and holder is not null;

    if needs_key then
        if coalesce(btrim(key_code), '') = '' then
            raise exception 'This login is already in use on another phone. Sign out there first, or ask your office for a device key.'
              using errcode = '42501', hint = 'device_key_required';
        end if;

        select * into k from device_keys
         where company_id = co and upper(code) = upper(btrim(key_code))
           and used_at is null and revoked_at is null and expires_at > now()
         for update;

        if k.id is null then
            raise exception 'That device key is not valid, has been used already, or has expired.'
              using errcode = '42501', hint = 'device_key_invalid';
        end if;

        update device_keys
           set used_at = now(), used_by = me, used_device_id = device_id
         where id = k.id;
    end if;

    update profiles
       set active_device_id = device_id,
           active_device_at = now()
     where id = me;
end;
$function$;


-- ------------------------------------------------------------------------
-- PART 4  the office needs to see what it has handed out
-- ------------------------------------------------------------------------

create or replace function public.list_device_keys()
 returns table (code text, label text, created_at timestamptz, expires_at timestamptz,
                used_at timestamptz, used_by_email text, revoked_at timestamptz, state text)
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
    select k.code, k.label, k.created_at, k.expires_at, k.used_at,
           (select u.email from auth.users u where u.id = k.used_by),
           k.revoked_at,
           case when k.revoked_at is not null then 'revoked'
                when k.used_at is not null    then 'used'
                when k.expires_at <= now()    then 'expired'
                else 'ready' end
      from device_keys k
     where k.company_id = public.current_company_id()
       and exists (select 1 from profiles p
                    where p.id = auth.uid() and p.role::text in ('OWNER', 'MANAGER'))
     order by k.created_at desc;
$function$;


-- ------------------------------------------------------------------------
-- PART 5  the switch, OFF for everyone
--
-- Deliberately not set here. Turning it on for a company whose crew are on an
-- older build locks those crew out of their own work with no way back, because
-- their phone cannot send a key and cannot explain why it was refused. Turn it on
-- per company, by hand, once the phones are updated:
--
--   insert into public.company_settings (company_id, settings)
--   values ('<company id>', jsonb_build_object('require_device_key', true))
--   on conflict (company_id) do update
--      set settings = public.company_settings.settings
--                  || jsonb_build_object('require_device_key', true);
-- ------------------------------------------------------------------------

revoke all     on function public.mint_device_key(text, int) from public, anon;
grant  execute on function public.mint_device_key(text, int) to authenticated;
revoke all     on function public.revoke_device_key(text) from public, anon;
grant  execute on function public.revoke_device_key(text) to authenticated;
revoke all     on function public.list_device_keys() from public, anon;
grant  execute on function public.list_device_keys() to authenticated;
-- claim_device was DROPPED above, so its ACL is back to the default. Re-stated,
-- not assumed.
revoke all     on function public.claim_device(text, text) from public, anon;
grant  execute on function public.claim_device(text, text) to authenticated;


-- ------------------------------------------------------------------------
-- PART 6  prove what landed. Every row must read true.
-- ------------------------------------------------------------------------

select 'device_keys exists with RLS on' as check,
       (select relrowsecurity from pg_class where oid = 'public.device_keys'::regclass) as ok
union all
select 'a key is unique per company, case-insensitively',
       exists (select 1 from pg_indexes
                where schemaname = 'public' and indexname = 'device_keys_company_code_idx')
union all
select 'claim_device takes a key and can refuse',
       (select position('device_key_required' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'claim_device')
union all
select 'an OWNER is never refused',
       (select position('is distinct from ''OWNER''' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'claim_device')
union all
select 'claim_device still callable with one argument (older phones)',
       (select count(*) = 1 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'claim_device'
           and pronargdefaults >= 1)
union all
select 'none of the four is executable by anon or PUBLIC',
       not exists (select 1 from pg_proc p, unnest(p.proacl::text[]) a
                    where p.pronamespace = 'public'::regnamespace
                      and p.proname in ('claim_device','mint_device_key','revoke_device_key','list_device_keys')
                      and (a like '=%' or a like 'anon=%'))
union all
-- The canary. If the switch were on anywhere, applying this file would start
-- refusing real crew phones the moment it ran.
select 'CANARY: no company has require_device_key switched on yet',
       not exists (select 1 from company_settings
                    where (settings ->> 'require_device_key')::boolean is true);

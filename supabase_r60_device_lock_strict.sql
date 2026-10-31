-- r60: "Use this phone only" means the owner too, and one owner phone per company.
--
-- REPORTED: "the use this phone only was not working, I was able to sign in on
-- another phone, work on that and make it very strict".
--
-- WHY IT DID NOTHING. Four separate reasons, all read off the live database on
-- 30 October 2026 rather than taken from the code:
--
--   1. require_device_key is NULL in this company's settings, so
--      coalesce(..., false) made it false. The lock was simply off.
--   2. Nothing anywhere can turn it on. Neither website/dashboard.html nor the
--      app mentions require_device_key; it has only ever been settable by hand
--      in SQL. mint_device_key, list_device_keys and revoke_device_key have all
--      been live and unreachable. The office panel added alongside this file is
--      the switch.
--   3. claim_device exempted OWNER outright --
--      `and my_role is distinct from 'OWNER'` -- and both accounts on this
--      company are OWNER.
--   4. supabase_r9_displaced_device_push.sql, the half that tells the old phone
--      it has lost the login, was never applied: the only non-internal triggers
--      on public.profiles are profiles_queue_signup_email and
--      protect_platform_admin. The edge function it calls has been deployed and
--      idle since 23 October. Apply r9 with this file, or the displaced phone
--      still finds out only when somebody picks it up.
--
-- AND THE ONE THAT MATTERS MOST: the handset used in that test was signed in as
-- the SECOND owner account, which claimed a device at 21:49 that day. The lock
-- is per login, so no device rule of any strictness would have refused it.
-- Closing that is the owner-seat rule in PART 2, and it is the owner's explicit
-- choice: ONE owner phone active per company, not one per owner account.
--
-- WHAT CHANGES
--
--   PART 1  The OWNER exemption goes. When the switch is on, an owner moving to
--           a different handset needs a device key exactly as anyone else does.
--   PART 2  One owner phone per company. An OWNER claiming a handset while
--           ANOTHER owner account holds one is refused without a key, and on
--           success that other owner's handset is displaced too.
--
-- THE LOCKOUT QUESTION, answered deliberately. The old comment was right that
-- the person who mints the keys must not be the person locked out -- "that is
-- not a lock, it is a trap". The exemption was the wrong answer to a real
-- problem. The right answer is that keys are minted in the OFFICE, from any
-- browser, which is reachable when a phone is not: mint_device_key has been
-- live since r8 and the office panel shipped with this change exposes it. So
-- there is a way back in that does not depend on holding the locked phone, and
-- the exemption is no longer buying anything except the hole that was reported.
--
-- Two further safety valves are kept on purpose:
--   * A claim with NO current holder is always free. A fresh install, a
--     replaced phone, a first sign-in -- nothing is being displaced, so nothing
--     is being protected, and refusing it would be a trap with no upside.
--   * The switch is OFF by default and this file does not turn it on for
--     anybody. It is the owner's to flip, in the office, once the keys panel is
--     in front of them.
--
-- HOW A DISPLACED OWNER IS TOLD, without a schema change: the other owner's
-- profiles.active_device_id is set to the CLAIMING handset's id. That is what
-- device_still_mine already compares against, so their phone's next ask returns
-- false and it blocks itself -- and r9's trigger fires on that same column
-- changing and pushes them the nudge to ask now. No new column, no second
-- notion of "displaced", and the phone keeps its existing fail-open rule: only
-- a definite server answer ever stops it.
--
-- Idempotent. CREATE OR REPLACE only; no table is altered and no setting is
-- written. The self-check at the end raises rather than leaving it half done.

begin;

create or replace function public.claim_device(device_id text, key_code text default null)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  me uuid := auth.uid();
  co uuid; my_role text; holder text; needs_key boolean; k record;
  lock_on boolean;
  other_owner_device text;
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

    lock_on := coalesce((
        select (c.settings ->> 'require_device_key')::boolean
          from company_settings c where c.company_id = co), false);

    -- ---------------------------------------------------------------- PART 2
    -- One OWNER handset per company.
    --
    -- Read BEFORE the key is spent, so the refusal below can account for it,
    -- and read whatever my_role is -- a non-owner claiming does not displace an
    -- owner, so this stays null for them and costs nothing.
    if lock_on and my_role = 'OWNER' then
        select p.active_device_id into other_owner_device
          from profiles p
         where p.company_id = co
           and p.id <> me
           and p.role::text = 'OWNER'
           and p.active_device_id is not null
           and p.active_device_id <> device_id
         limit 1;
    end if;

    -- ---------------------------------------------------------------- PART 1
    -- The OWNER exemption is gone. A key is needed when the switch is on and
    -- there is something to displace: this account's own other handset, or --
    -- for an owner -- another owner account's handset.
    --
    -- `holder is not null` is kept, and is the valve that stops this being a
    -- trap: a first sign-in, a fresh install or a replaced phone displaces
    -- nobody and is never refused.
    needs_key := lock_on and (holder is not null or other_owner_device is not null);

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

    -- The other owner's handset stops. Pointing their row at the claiming
    -- device (rather than nulling it) is what makes device_still_mine answer
    -- false for them -- a null reads as "no device claimed", which that
    -- function treats as still mine, and would have left the old phone running.
    -- The same write is what r9's trigger watches, so they are pushed the nudge
    -- to re-ask rather than finding out when the phone is next picked up.
    if other_owner_device is not null then
        update profiles
           set active_device_id = device_id,
               active_device_at = now()
         where company_id = co
           and id <> me
           and role::text = 'OWNER'
           and active_device_id is not null
           and active_device_id <> device_id;
    end if;
end;
$function$;

revoke all     on function public.claim_device(text, text) from public, anon;
grant  execute on function public.claim_device(text, text) to authenticated;

-- ------------------------------------------------------------------ self-check
-- Every rule is exercised against real rows inside this transaction and undone,
-- and each one carries a control: a check that cannot be shown to fire is not a
-- check. Raises rather than leaving the file half applied.
do $check$
declare
    co        uuid;
    owner_a   uuid;
    owner_b   uuid;
    had       jsonb;
    refused   boolean;
    -- EXACTLY what each row held before this check touched it. Restoring to
    -- NULL instead would read as "no handset claimed", which device_still_mine
    -- treats as still mine -- so a check meant to prove the lock works would
    -- have quietly unlocked both owners' phones on the way out.
    had_a_dev text; had_a_at timestamptz;
    had_b_dev text; had_b_at timestamptz;
begin
    -- A company with two OWNER accounts, chosen BY THAT PROPERTY rather than by
    -- name: a fixture pinned to a person rots the moment somebody is promoted.
    select p.company_id into co
      from profiles p where p.role::text = 'OWNER'
     group by p.company_id having count(*) >= 2 limit 1;
    if co is null then
        raise notice 'r60 self-check skipped: no company has two OWNER accounts to test the seat rule with';
        return;
    end if;
    select id into owner_a from profiles where company_id = co and role::text = 'OWNER' order by id limit 1;
    select id into owner_b from profiles where company_id = co and role::text = 'OWNER' and id <> owner_a order by id limit 1;

    select settings into had from company_settings where company_id = co;
    select active_device_id, active_device_at into had_a_dev, had_a_at from profiles where id = owner_a;
    select active_device_id, active_device_at into had_b_dev, had_b_at from profiles where id = owner_b;

    -- CONTROL: with the switch OFF, nothing is refused. If this ever raises,
    -- the checks below are measuring a function that refuses everything.
    update company_settings set settings = coalesce(settings,'{}'::jsonb) - 'require_device_key'
     where company_id = co;
    update profiles set active_device_id = 'dev-A', active_device_at = now() where id = owner_a;
    update profiles set active_device_id = 'dev-B', active_device_at = now() where id = owner_b;
    perform set_config('request.jwt.claims',
        json_build_object('sub', owner_a::text, 'role','authenticated')::text, true);
    begin
        perform public.claim_device('dev-NEW');
    exception when others then
        raise exception 'r60 control failed: a claim was refused with the switch OFF (%)', sqlerrm;
    end;

    -- The switch on, and an owner moving handset is now refused without a key.
    update company_settings
       set settings = coalesce(settings,'{}'::jsonb) || '{"require_device_key": true}'::jsonb
     where company_id = co;
    update profiles set active_device_id = 'dev-A', active_device_at = now() where id = owner_a;
    update profiles set active_device_id = 'dev-B', active_device_at = now() where id = owner_b;
    refused := false;
    begin
        perform public.claim_device('dev-NEW');
    exception when others then refused := true;
    end;
    if not refused then
        raise exception 'r60: an OWNER still took a second handset with no key -- the exemption is not gone';
    end if;

    -- A first claim with nothing to displace is still free, for THIS account --
    -- the valve that keeps this a lock and not a trap. The other owner must
    -- hold nothing, or the seat rule correctly refuses.
    update profiles set active_device_id = null, active_device_at = null where id = owner_a;
    update profiles set active_device_id = null, active_device_at = null where id = owner_b;
    begin
        perform public.claim_device('dev-FIRST');
    exception when others then
        raise exception 'r60: a first claim with nothing to displace was refused -- that is a lockout, not a lock (%)', sqlerrm;
    end;
    if (select active_device_id from profiles where id = owner_a) is distinct from 'dev-FIRST' then
        raise exception 'r60: the free first claim did not actually land';
    end if;

    -- The seat rule: owner A holds nothing, owner B holds a handset, and A is
    -- still refused -- because the company already has an owner phone.
    update profiles set active_device_id = null, active_device_at = null where id = owner_a;
    update profiles set active_device_id = 'dev-B', active_device_at = now() where id = owner_b;
    refused := false;
    begin
        perform public.claim_device('dev-NEW2');
    exception when others then refused := true;
    end;
    if not refused then
        raise exception 'r60: a second OWNER account claimed a handset while another owner held one -- the seat rule is not working, which is the exact hole that was reported';
    end if;

    -- And with a valid key it goes through AND stops the other owner's phone.
    insert into device_keys (company_id, code, label, created_by, created_at, expires_at)
         values (co, 'R60SELFCHECK', 'r60 self-check', owner_a, now(), now() + interval '1 hour');
    begin
        perform public.claim_device('dev-NEW3', 'R60SELFCHECK');
    exception when others then
        raise exception 'r60: a valid device key did not let the claim through (%)', sqlerrm;
    end;
    if (select active_device_id from profiles where id = owner_b) is distinct from 'dev-NEW3' then
        raise exception 'r60: the displaced owner''s phone was not pointed at the new handset, so device_still_mine would still answer "yes, still yours" and it would keep running';
    end if;

    -- Undo everything this check touched, back to the exact values it found.
    -- The transaction is committed, so this is not optional -- and it must be
    -- the ORIGINAL handset ids, not null: see the declarations above.
    delete from device_keys where code = 'R60SELFCHECK';
    update profiles set active_device_id = had_a_dev, active_device_at = had_a_at where id = owner_a;
    update profiles set active_device_id = had_b_dev, active_device_at = had_b_at where id = owner_b;
    update company_settings set settings = had where company_id = co;
    perform set_config('request.jwt.claims', '', true);

    -- And prove the restore actually happened, rather than trusting it.
    if (select active_device_id from profiles where id = owner_a) is distinct from had_a_dev
       or (select active_device_id from profiles where id = owner_b) is distinct from had_b_dev then
        raise exception 'r60 self-check could not put the owners'' handsets back as it found them';
    end if;
end $check$;

commit;

-- ============================================================
-- FenceFlow -- "use this phone" stops the other phone NOW, not when it is
-- next picked up.
--
-- UNAPPLIED. Nothing in this file has been run against the live database.
-- Deploy supabase/functions/notify-device-displaced FIRST, or the first claim
-- after this runs POSTs to a URL that is not there yet (it loses only the
-- nudge; the claim itself is never affected -- see NEVER BREAKS A CLAIM below).
--
-- WHAT IS BROKEN TODAY, read off the live database on 28 September rather than
-- taken from the list:
--
--   * claim_device (SECURITY DEFINER, supabase_r8_device_keys.sql) is the only
--     thing that writes profiles.active_device_id. Confirmed live: the only
--     non-internal trigger on public.profiles is protect_platform_admin, and it
--     does not look at that column. Nothing observes the write.
--   * The displaced handset learns it lost the login only when something calls
--     device_still_mine -- which the app reaches from ServiceGate.holdsLogin,
--     driven from MainActivity's ON_RESUME. So the old phone keeps working, and
--     keeps syncing, until somebody physically picks it up.
--   * There is already a push path for jobs: the "job-change-push" trigger on
--     public.jobs (AFTER INSERT OR UPDATE OF status, assigned_employee_id, WHEN
--     pg_trigger_depth() = 0) POSTing to notify-job-change, which addresses
--     chosen PEOPLE through device_tokens. This file follows that pattern
--     rather than inventing a second one.
--
-- THE THING THAT WAS MISSING, and why this is more than a trigger: device_tokens
-- is (token, user_id, company_id, platform, updated_at) -- confirmed live. It
-- records WHOSE a phone is, never WHICH phone. ServiceGate's install id (a uuid
-- written once into the app's own preferences) is what active_device_id holds,
-- and nothing ever sent it to the server. So today it is impossible to address
-- the one displaced handset: the only choices available are "every phone this
-- login has registered" or nothing. PART 1 and PART 2 add that one missing
-- link, so PART 5's push can go to exactly one phone.
--
-- HOW IT WORKS, end to end:
--   1. The app registers its FCM token together with its install id
--      (register_device_install, PART 2). The old one-argument
--      register_device_token is untouched and still works; a phone on an older
--      build simply has no install id recorded and cannot be nudged.
--   2. A claim moves profiles.active_device_id. The trigger in PART 5 fires
--      only when the value actually changed and only when there WAS a previous
--      holder, and POSTs the OLD install id and the account to
--      notify-device-displaced.
--   3. That function looks up that ONE device's token and sends it a data
--      message carrying a kind and nothing else -- no words, no verdict.
--   4. The phone re-asks device_still_mine itself. The push is a nudge to ask,
--      never the answer. Anyone who could forge one still cannot sign anybody
--      out, because the server's answer is the only thing the phone acts on.
--
-- WHO MAY CALL THE FUNCTION: this trigger. Same door as send-welcome-email --
-- the trigger reads a secret from Vault (generated here from random bytes and
-- never printed) and sends it in a header; the function asks
-- displaced_push_ok(), executable by the service role only, before it reads the
-- body. Nobody handles the value and there is nothing to copy into the
-- function's secrets. This is deliberately NOT the job-change-push shape, where
-- the secret sits in plain text inside the trigger definition and had to be
-- rotated once because it was read aloud while somebody hunted for it
-- (supabase_join_alert_patch.sql records that).
--
-- NEVER BREAKS A CLAIM: queue_displaced_device_push catches every error and
-- turns it into a warning. A missing secret, pg_net refusing, the function
-- being down -- the claim still lands and the new phone still works. The only
-- cost is that the old phone finds out on its next resume, exactly as it does
-- today. That direction matters: the failure mode of this whole file is
-- "no better than today", never "somebody is locked out".
--
-- WHAT THIS DELIBERATELY DOES NOT DO:
--   * It does not decide anything. The push carries no verdict, and the
--     function is incapable of blocking a phone -- it has no way to write
--     active_device_id and does not try. Only the phone's own
--     device_still_mine call can set its displaced flag, and that call already
--     fails OPEN (ServiceGate: "Only ever false on a definite answer from the
--     server. Offline, or any failure, leaves it true -- a crew member in a
--     dead spot must not be thrown out of the app on a guess."). Nothing here
--     changes that sentence or the code under it.
--   * It does not drop or alter register_device_token, claim_device,
--     device_still_mine, any policy, or the job-change-push trigger.
--   * It does not touch RLS, plan gates, quote security, server-side pricing,
--     the payment ledger, signatures or offline sync, and it moves no money
--     and no job row.
--   * It does not add a company filter to the device lookup. The lookup lives
--     in the edge function, and its header names the house rule it departs from
--     ("Both filters, always", in _shared/push-recipients.ts) and why: that rule
--     protects company WORDS from a phone whose device row carries an old
--     employer, and this message has no words. Filtering on a stamp that can be
--     stale could only make the stop signal go missing.
--   * It does not turn on require_device_key for anybody. That switch stays
--     where supabase_r8_device_keys.sql left it: off, per company, by hand.
--   * It sends nothing to the NEW phone. That phone just claimed; it knows.
-- ============================================================


-- ------------------------------------------------------------------------
-- PART 1  which phone, not just whose
--
-- Additive and nullable. Every existing row keeps working: the senders that
-- fan out by user_id and company_id (notify-job-change, the payment webhooks,
-- quote-view through _shared/push-recipients.ts) never look at this column, so
-- nothing they do changes.
--
-- WHY NOT REUSE token AS THE INSTALL ID: an FCM token rotates on its own --
-- FenceFlowMessagingService.onNewToken exists for exactly that -- and
-- active_device_id must survive a rotation or a reinstall-free token change
-- would look like a new phone and displace nobody. ServiceGate's own comment on
-- its install id says the same thing from the other side: "Not the FCM token,
-- which changes on its own, and not the Android id, which is shared across a
-- user's apps."
--
-- WHAT THE RLS POLICIES DO NOT CONSTRAIN: device_tokens_own_insert and
-- device_tokens_own_update (supabase_device_token_tenancy_patch.sql) bind
-- user_id and company_id to the caller. They say nothing about device_id,
-- because the server has no way to know what a handset's install id is. So a
-- signed-in person could PATCH their OWN device row to carry a different
-- install id. What that buys them: their own other handset stops being nudged,
-- so it finds out on its next resume -- today's behaviour. It cannot make
-- somebody else's phone stop, because both write policies still require
-- user_id = auth.uid(), and it cannot read anything, because
-- device_tokens_own_select is also user_id = auth.uid(). Not worth a guard that
-- would have to guess.
-- ------------------------------------------------------------------------

alter table public.device_tokens add column if not exists device_id text;

comment on column public.device_tokens.device_id is
  'Which handset this push token belongs to: the install id ServiceGate keeps in the app''s own '
  'preferences, the same value claim_device stores in profiles.active_device_id. Written by '
  'register_device_install (supabase_r9_displaced_device_push.sql). Null means a phone that has '
  'not sent one yet -- an older build, or one that has not been opened with a live session since '
  'this shipped -- and such a phone cannot be told it was displaced, so it falls back to finding '
  'out on its next resume.';

-- The lookup notify-device-displaced makes, and the only one this column has.
create index if not exists device_tokens_install_idx
    on public.device_tokens (user_id, device_id);


-- ------------------------------------------------------------------------
-- PART 2  registering the token AND the install id
--
-- A new function rather than a second argument on register_device_token.
-- Adding a defaulted argument means dropping the one-argument version first,
-- or the call is ambiguous (supabase_r8_device_keys.sql did exactly that to
-- claim_device and says why). Dropping a function that every phone in the
-- field calls at sign-in, to add a column nothing yet depends on, is a risk
-- with no payoff: the old path keeps working untouched and the new one is
-- additive.
--
-- The upsert never ERASES a known install id. register_device_token's own
-- ON CONFLICT does not mention device_id, so a plain sign-in registration
-- leaves whatever is there alone; and a call here with no id coalesces to the
-- stored value rather than writing null over it. That matters because the two
-- calls race at startup -- SessionManager registers at sign-in, the app
-- registers again once it has an install id -- and whichever lands second must
-- not undo the other. (The PostgREST trap this avoids is the same one as ever:
-- an explicit null wins over what is already in the column.)
-- ------------------------------------------------------------------------

create or replace function public.register_device_install(
    device_token text,
    p_device_id  text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then
        raise exception 'Must be signed in to register a device.';
    end if;
    -- Nothing to address with; leave whatever is there alone. The same
    -- guard claim_device has for a blank device id, for the same reason.
    if coalesce(btrim(device_token), '') = '' then
        return;
    end if;

    insert into device_tokens (token, user_id, company_id, device_id, updated_at)
        values (device_token, auth.uid(), current_company_id(),
                nullif(btrim(coalesce(p_device_id, '')), ''), now())
    on conflict (token) do update
        set user_id    = excluded.user_id,
            company_id = excluded.company_id,
            device_id  = coalesce(excluded.device_id, device_tokens.device_id),
            updated_at = now();
end $$;

revoke all     on function public.register_device_install(text, text) from public, anon;
grant  execute on function public.register_device_install(text, text) to authenticated;


-- ------------------------------------------------------------------------
-- PART 3  the function's door
--
-- True only for the exact secret. Digests are compared rather than the values,
-- so how long the comparison takes says nothing about how much of a guess was
-- right. Copied in shape from welcome_email_trigger_ok, which is live and
-- working, so there is one way this product authenticates a trigger and not
-- two.
-- ------------------------------------------------------------------------

create or replace function public.displaced_push_ok(p_secret text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    stored text;
begin
    if p_secret is null or length(p_secret) <> 64 then
        return false;
    end if;
    select decrypted_secret into stored from vault.decrypted_secrets
     where name = 'displaced_device_trigger_secret';
    if stored is null then
        -- No secret configured is NOT "let everyone in".
        return false;
    end if;
    return extensions.digest(convert_to(p_secret, 'UTF8'), 'sha256')
         = extensions.digest(convert_to(stored, 'UTF8'), 'sha256');
end;
$$;

revoke all     on function public.displaced_push_ok(text) from public, anon, authenticated;
grant  execute on function public.displaced_push_ok(text) to service_role;


-- ------------------------------------------------------------------------
-- PART 4  the secret, in Vault
--
-- Generated here from random bytes and never printed. Nobody handles the
-- value; there is nothing to paste into the function's secrets. Rotate by
-- deleting the row and re-running this file -- nothing else holds a copy.
-- ------------------------------------------------------------------------

do $$
begin
    if not exists (select 1 from vault.secrets where name = 'displaced_device_trigger_secret') then
        perform vault.create_secret(
            encode(extensions.gen_random_bytes(32), 'hex'),
            'displaced_device_trigger_secret',
            'Shared secret between the profiles_push_displaced_device trigger and the '
            'notify-device-displaced edge function (supabase_r9_displaced_device_push.sql). '
            'Never expose. Rotate by deleting it and re-running that file; nothing else holds '
            'a copy. Leaking it costs one content-free nudge to one phone, which that phone '
            'answers by asking the server -- it cannot sign anybody out.');
    end if;
end $$;


-- ------------------------------------------------------------------------
-- PART 5  the trigger
--
-- NARROW, for the reason supabase_narrow_push_trigger.sql gives about jobs:
-- that trigger fired on INSERT OR DELETE OR UPDATE, so "every sync pass that
-- touched a job -- a payment landing, a stamp being written, a device pushing
-- an unchanged row -- sent a push notification", and narrowing it to the two
-- columns worth telling somebody about was half the fix for a notification
-- burst. The same discipline here, three ways:
--
--   * UPDATE OF active_device_id, so an ordinary profile edit -- a name, a
--     role, last_seen_at -- never reaches pg_net at all.
--   * WHEN the value actually CHANGED. Postgres fires an UPDATE OF trigger when
--     the column merely appears in the statement's target list, changed or not,
--     and claim_device writes active_device_id every time it is called --
--     including the re-claim a phone makes for itself at each sign-in. Without
--     this clause every sign-in on the CURRENT phone would push that same
--     phone a nudge to go and ask whether it is still itself.
--   * WHEN there WAS a previous holder. The first claim a login ever makes
--     moves null to a device id; there is no displaced phone to tell.
--
-- NO pg_trigger_depth() GUARD, unlike job-change-push, and that is deliberate
-- rather than an oversight. That guard exists to stop a cascade of nested
-- writes each sending its own push. This column has exactly one writer --
-- claim_device, called directly by the app as an RPC, verified live as the only
-- thing in the schema that sets it -- so there is no cascade to suppress, and a
-- depth guard could only ever throw away the one message this file exists to
-- send.
-- ------------------------------------------------------------------------

create or replace function public.queue_displaced_device_push()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    secret text;
begin
    begin
        select decrypted_secret into secret from vault.decrypted_secrets
         where name = 'displaced_device_trigger_secret';
        if secret is null then
            raise warning 'displaced-device push not queued for %: Vault secret displaced_device_trigger_secret is missing', new.id;
            return null;
        end if;

        -- pg_net queues inside the transaction and sends after commit, so the
        -- function always reads committed data and a rolled-back claim sends
        -- nothing.
        --
        -- The body carries the OLD install id -- the phone that just lost the
        -- login -- and never the new one. company_id is here for the function's
        -- log line only; it is not a filter, and nothing downstream may treat
        -- it as one.
        perform net.http_post(
            url     := 'https://newcrgafcptspmapacrx.supabase.co/functions/v1/notify-device-displaced',
            body    := jsonb_build_object(
                           'user_id',       new.id,
                           'company_id',    new.company_id,
                           'old_device_id', old.active_device_id),
            headers := jsonb_build_object(
                           'Content-Type', 'application/json',
                           'x-fenceflow-displaced', secret),
            timeout_milliseconds := 5000);
    exception when others then
        -- A claim must never fail over its nudge. "Use this phone" has to work
        -- when the notification path does not, or the button that exists to
        -- rescue somebody off a blocked screen becomes the button that keeps
        -- them there.
        raise warning 'displaced-device push not queued for %: %', new.id, sqlerrm;
    end;
    return null;
end;
$$;

revoke all on function public.queue_displaced_device_push() from public, anon, authenticated;

drop trigger if exists profiles_push_displaced_device on public.profiles;
create trigger profiles_push_displaced_device
    after update of active_device_id on public.profiles
    for each row
    when (new.active_device_id is distinct from old.active_device_id
          and old.active_device_id is not null)
    execute function public.queue_displaced_device_push();


-- ------------------------------------------------------------------------
-- PART 6  prove every claim above, one row at a time
--
-- Read the `ok` column. Every row must be true EXCEPT the one marked CANARY,
-- which must be FALSE -- it asks the same question about a column that was
-- never added, so a true there means the check above it cannot tell the
-- difference and proves nothing. The row marked CONTROL must be true for the
-- same reason in reverse: two checks that a door refuses bad secrets are
-- worthless until something proves the door accepts a good one.
--
-- No row prints a secret. The Vault check counts rows; the CONTROL row passes a
-- value into a function and never selects it.
--
-- Every query SHAPE in here was run read-only against objects that already
-- exist before this file was written, with a deliberately wrong twin beside it
-- that had to come back false. That is how the identity-arguments comparison
-- below got caught: written the obvious way it would have read FALSE on a
-- perfectly correct migration.
-- ------------------------------------------------------------------------

select 'device_tokens now records which handset a token belongs to' as check,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'device_tokens'
                  and column_name = 'device_id' and is_nullable = 'YES') as ok

union all
select 'CANARY: the same question about a column that was never added (must be FALSE)',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'device_tokens'
                  and column_name = 'device_id_zzz' and is_nullable = 'YES')

union all
select 'the lookup notify-device-displaced makes has an index',
       exists (select 1 from pg_indexes
                where schemaname = 'public' and tablename = 'device_tokens'
                  and indexname = 'device_tokens_install_idx')

union all
-- pg_get_function_identity_arguments includes the argument NAMES, not just the
-- types: it answers 'device_token text' for register_device_token, never
-- 'text'. Checked against that live function before this row was written,
-- because a comparison against 'text, text' reads FALSE on a perfectly correct
-- migration and sends somebody hunting a fault that is not there.
select 'register_device_install takes a token and an install id',
       (select pg_get_function_identity_arguments(oid) = 'device_token text, p_device_id text'
          from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'register_device_install')

union all
select 'register_device_install is callable with one argument, so the install id is optional',
       (select pronargdefaults = 1 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'register_device_install')

union all
select 'the OLD one-argument register_device_token is untouched, so phones in the field still register',
       exists (select 1 from pg_proc
                where pronamespace = 'public'::regnamespace and proname = 'register_device_token'
                  and pg_get_function_identity_arguments(oid) = 'device_token text')

union all
select 'register_device_install never writes null over an install id it already knows',
       (select prosrc like '%coalesce(excluded.device_id, device_tokens.device_id)%'
          from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'register_device_install')

union all
select 'the door exists and refuses a blank secret',
       public.displaced_push_ok('') is false

union all
select 'the door refuses a wrong secret of exactly the right length',
       public.displaced_push_ok(repeat('0', 64)) is false

union all
-- POSITIVE CONTROL for the two refusals above. A door hardwired to return
-- false would pass both of them and stop every real caller too, including the
-- trigger -- so the feature would be silently dead while the proof read clean.
-- This asks with the real secret and must come back TRUE. The value is passed
-- into the call and never selected into the output, so nothing prints it.
--
-- This exact shape was run against the live welcome_email_trigger_ok before it
-- was written here: it answered true for that door's own secret and false for
-- 64 zeroes, so the row is known to be able to say both things.
select 'CONTROL: the door SAYS YES to the real secret, so the two refusals above are not a door that says no to everything',
       public.displaced_push_ok(
           (select decrypted_secret from vault.decrypted_secrets
             where name = 'displaced_device_trigger_secret')) is true

union all
select 'nobody but the service role may ask the door',
       not has_function_privilege('authenticated', 'public.displaced_push_ok(text)', 'execute')
       and not has_function_privilege('anon', 'public.displaced_push_ok(text)', 'execute')
       and has_function_privilege('service_role', 'public.displaced_push_ok(text)', 'execute')

union all
select 'the Vault secret is present (counted, never printed)',
       (select count(*) = 1 from vault.secrets where name = 'displaced_device_trigger_secret')

union all
select 'no signed-in caller can fire the push function by hand',
       not has_function_privilege('authenticated', 'public.queue_displaced_device_push()', 'execute')
       and not has_function_privilege('anon', 'public.queue_displaced_device_push()', 'execute')

union all
select 'the trigger is installed on profiles, after the write',
       exists (select 1 from pg_trigger
                where tgrelid = 'public.profiles'::regclass
                  and tgname = 'profiles_push_displaced_device'
                  and not tgisinternal)

union all
select 'it watches active_device_id and nothing else',
       (select pg_get_triggerdef(oid) like '%UPDATE OF active_device_id%'
          from pg_trigger
         where tgrelid = 'public.profiles'::regclass
           and tgname = 'profiles_push_displaced_device')

union all
select 'it fires only when the value actually changed, and only when there was a phone to displace',
       (select pg_get_triggerdef(oid) ilike '%is distinct from%'
           and pg_get_triggerdef(oid) ilike '%old.active_device_id IS NOT NULL%'
          from pg_trigger
         where tgrelid = 'public.profiles'::regclass
           and tgname = 'profiles_push_displaced_device')

union all
select 'it does not fire on INSERT, so a brand new profile sends nothing',
       (select pg_get_triggerdef(oid) not ilike '%INSERT%'
          from pg_trigger
         where tgrelid = 'public.profiles'::regclass
           and tgname = 'profiles_push_displaced_device')

union all
select 'job-change-push on jobs is exactly as it was -- this file changed no existing trigger',
       exists (select 1 from pg_trigger
                where tgrelid = 'public.jobs'::regclass and tgname = 'job-change-push'
                  and pg_get_triggerdef(oid) like '%UPDATE OF status, assigned_employee_id%')

union all
select 'claim_device and device_still_mine are untouched',
       (select count(*) = 2 from pg_proc
         where pronamespace = 'public'::regnamespace
           and proname in ('claim_device', 'device_still_mine'));


-- How many phones can actually be reached the moment this lands, and how many
-- still have to be opened once with a live session before they can be.
--
-- Expect every row to start with no install id. That is not a fault: a phone
-- records one the next time the app starts and the session is live, and until
-- then it is no worse off than it is today -- it finds out on resume. Re-run
-- this after a day to watch the second number fall.
select count(*)                                       as phones_registered,
       count(*) filter (where device_id is not null)   as addressable_now,
       count(*) filter (where device_id is null)       as waiting_for_an_app_start
  from public.device_tokens;

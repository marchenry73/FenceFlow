-- F9 (P2): the quote-view phone gate read quote_phone_attempts and then wrote
-- it back, with nothing atomic in between. N requests fired in parallel all
-- read the same count, so "5 tries per 15 minutes" did not bound a burst --
-- and there are only 10,000 four-digit codes.
--
-- Counting moves into one UPDATE. The row lock that UPDATE takes is what makes
-- concurrent guesses queue up instead of overlapping, so the Nth guess in a
-- burst sees the count the previous N-1 left behind.
--
-- Called BEFORE the digits are compared, so an attempt is spent whether or not
-- it turns out to be right; quote_phone_clear() gives it back on a correct
-- answer, which is what the old code did too.
--
-- Returns 'LOCKED' when the job is inside its lockout window (nothing is
-- consumed), 'OK' when an attempt was consumed, and 'NOT_FOUND' for an
-- unknown job. A caller must treat anything that is not 'OK' as refused.

create or replace function public.quote_phone_try(jid uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    max_attempts constant int := 5;
    locked_now boolean;
    n int;
begin
    if jid is null then return 'NOT_FOUND'; end if;

    update jobs j
       set quote_phone_attempts =
               case when j.quote_phone_locked_until is not null
                         and j.quote_phone_locked_until > now() then j.quote_phone_attempts
                    when j.quote_phone_attempts + 1 >= max_attempts then 0
                    else j.quote_phone_attempts + 1 end,
           quote_phone_locked_until =
               case when j.quote_phone_locked_until is not null
                         and j.quote_phone_locked_until > now() then j.quote_phone_locked_until
                    when j.quote_phone_attempts + 1 >= max_attempts then now() + interval '15 minutes'
                    else j.quote_phone_locked_until end
     where j.id = jid
    returning (j.quote_phone_locked_until is not null and j.quote_phone_locked_until > now())
      into locked_now;

    get diagnostics n = row_count;
    if n = 0 then return 'NOT_FOUND'; end if;
    -- locked_now reads the row AFTER the update, so the guess that trips the
    -- limit is itself refused rather than being the last one that counted.
    if locked_now then return 'LOCKED'; end if;
    return 'OK';
end;
$function$;

create or replace function public.quote_phone_clear(jid uuid)
returns void
language sql
security definer
set search_path to 'public'
as $function$
    update jobs set quote_phone_attempts = 0, quote_phone_locked_until = null
     where id = jid and (quote_phone_attempts <> 0 or quote_phone_locked_until is not null);
$function$;

-- Only the quote-view edge function (service role) may call these. The service
-- role does not go through GRANT, so revoking from everyone else costs nothing.
revoke all on function public.quote_phone_try(uuid) from public, anon, authenticated;
revoke all on function public.quote_phone_clear(uuid) from public, anon, authenticated;

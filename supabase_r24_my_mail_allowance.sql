-- ============================================================
-- FenceFlow -- how many emails a company has left today
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- ADDITIVE. One new SECURITY DEFINER function. No policy, grant, column or
-- existing function is changed, and nothing is written or deleted.
--
-- WHY. "I also want to see the amount that have left after I send the mail on
-- the app and on the websites" -- March, 20 October 2026. The counts exist:
-- every send writes a row to mail_events, and mail-send reads them back
-- through mail_event_count() before it will send another. But that function
-- refuses anybody who is not the service role (mail_is_backend), so the office
-- -- signed in as a person -- could never ask the question. A cap you cannot
-- see is a cap you only ever meet by being refused.
--
-- WHAT IT ANSWERS, and only this: how many sends THIS COMPANY has made in the
-- last hour and the last day, per provider, with the caps alongside. It reads
-- the same mail_events rows and the same windows the sender does, so the
-- number on screen and the number that refuses a send cannot disagree.
--
-- WHAT IT DOES NOT DO. It does not reveal another company's usage, it does not
-- reveal the platform-wide counters (company_id is null rows, which belong to
-- FenceFlow's own sends), and it cannot send, change a cap or clear a count.
-- mail_event_count() is left exactly as it is: the backend's own guard stays
-- service-role only.
--
-- THE CAPS ARE WRITTEN TWICE, here and in supabase/functions/_shared/mail/
-- limits.ts, and that is a real hazard -- two numbers that mean one thing drift
-- apart and the screen starts lying about a limit the server is still
-- enforcing. The SQL cannot import the TypeScript, so instead
-- tests/a120-mail-allowance.test.mjs reads BOTH files and fails if they ever
-- disagree. The duplication is allowed; the drift is not.
-- ============================================================

create or replace function public.my_mail_allowance()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
    co uuid := public.current_company_id();
begin
    if co is null then
        raise exception 'You are not part of a business yet.'
            using errcode = '42501';
    end if;

    -- The same permission the sender asks for. Somebody who cannot send mail
    -- has no business reading how much sending is left, and this keeps the two
    -- answers from ever disagreeing about who may ask.
    if not coalesce(public.can_use_company_mail(), false) then
        raise exception 'Sending company email is not switched on for your account.'
            using errcode = '42501';
    end if;

    return jsonb_build_object(
        -- The caps, mirrored from limits.ts. See the note at the top.
        'hour_cap',     60,
        'day_cap',      300,
        -- Counted the way spendSend() counts: per kind, over a rolling window,
        -- for this company only. Never the company_id-is-null rows, which are
        -- FenceFlow's own platform sends and nobody's business here.
        'smtp_hour',   (select count(*) from public.mail_events
                         where company_id = co and kind = 'send_smtp'
                           and at > now() - interval '1 hour'),
        'smtp_day',    (select count(*) from public.mail_events
                         where company_id = co and kind = 'send_smtp'
                           and at > now() - interval '1 day'),
        'resend_hour', (select count(*) from public.mail_events
                         where company_id = co and kind = 'send_resend'
                           and at > now() - interval '1 hour'),
        'resend_day',  (select count(*) from public.mail_events
                         where company_id = co and kind = 'send_resend'
                           and at > now() - interval '1 day')
    );
end;
$function$;

-- REVOKED FROM anon BY NAME, not just from PUBLIC.
--
-- The first version of this file revoked from PUBLIC and granted to
-- authenticated, and the proof below still reported that a signed-out
-- visitor could execute it: Supabase's default privileges on the public
-- schema grant EXECUTE to anon and authenticated DIRECTLY, and revoking from
-- PUBLIC does not touch a direct grant. Nothing leaked -- current_company_id()
-- is null for anon, so the function's own first check refuses it -- but a
-- guard that holds only because of what is inside the function is one edit
-- away from not holding at all.
revoke all on function public.my_mail_allowance() from public;
revoke all on function public.my_mail_allowance() from anon;
grant execute on function public.my_mail_allowance() to authenticated;

-- ------------------------------------------------------------------------
-- PROOF. Read back, never trusted from the statement's own success.
-- ------------------------------------------------------------------------
select 'the function exists' as check,
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'public' and p.proname = 'my_mail_allowance')
            then 'PASS' else 'FAIL' end as result
union all
select 'it runs as its owner, so it can read mail_events',
       coalesce((select case when p.prosecdef then 'PASS' else 'FAIL -- not SECURITY DEFINER' end
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'my_mail_allowance'), 'FAIL')
union all
select 'it cannot write anything',
       coalesce((select case when p.provolatile = 's' then 'PASS'
                             else 'FAIL -- volatility is ' || p.provolatile::text end
                   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'my_mail_allowance'), 'FAIL')
union all
select 'a signed-in person may call it',
       case when has_function_privilege('authenticated', 'public.my_mail_allowance()', 'execute')
            then 'PASS' else 'FAIL -- authenticated cannot execute it' end
union all
select 'anon may not',
       case when has_function_privilege('anon', 'public.my_mail_allowance()', 'execute')
            then 'FAIL -- a signed-out visitor can read send counts' else 'PASS' end
union all
-- The canary for the whole file: the backend's own counter must stay shut.
select 'mail_event_count is still service-role only',
       case when position('mail_is_backend' in
              (select pg_get_functiondef(p.oid) from pg_proc p
                 join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'mail_event_count')) > 0
            then 'PASS' else 'FAIL -- the backend guard is gone' end
union all
-- NOT a call to the function. This file is run by the CLI as postgres, where
-- auth.uid() is null, current_company_id() is null and the function correctly
-- refuses -- which would fail the migration for doing its job. The behaviour
-- for a real caller is checked by impersonating one, not from here.
select 'the caps are in the body, where the test can read them',
       case when (select pg_get_functiondef(p.oid) from pg_proc p
                    join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.proname = 'my_mail_allowance')
                 like '%''day_cap'',      300%'
            then 'PASS' else 'FAIL -- the day cap is not 300 in the function body' end;

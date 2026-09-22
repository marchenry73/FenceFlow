-- ============================================================
-- Proof for supabase_r6_welcome_email.sql. Run it AFTER that file.
-- Nothing survives it: every statement runs inside one transaction that
-- ends in ROLLBACK -- the probe companies, their updates and the requests
-- the trigger queues all vanish, and pg_net only sends after a COMMIT, so
-- no email goes anywhere. The probe companies are named "ZZ TEST", which
-- send-welcome-email refuses as well, belt and braces.
--
-- Every row's "ok" should read true. Row 3 is the positive control: if the
-- trigger queued nothing there, every "0 queued" row above and below it
-- proves nothing, because a trigger that never fires passes them all.
-- ============================================================
begin;
set local lock_timeout = '3s';
set local statement_timeout = '30s';

create temp table r6_ids (tag text primary key, id uuid not null) on commit drop;
insert into r6_ids values
    ('trial_second', gen_random_uuid()),
    ('details_second', gen_random_uuid()),
    ('already_sent', gen_random_uuid());
create temp table r6_probe (n int, check_name text, ok boolean, detail text) on commit drop;

-- Requests queued for one probe company, at the function's exact URL.
create function pg_temp.r6_queued(p_tag text) returns bigint language sql as $$
    select count(*) from net.http_request_queue q
     where q.url = 'https://newcrgafcptspmapacrx.supabase.co/functions/v1/send-welcome-email'
       and convert_from(q.body, 'UTF8')::jsonb ->> 'company_id' = (select id::text from r6_ids where tag = p_tag)
$$;

-- ---- A: details first, then the trial (the invited-company path) ----
insert into public.companies (id, name)
select id, 'ZZ TEST r6 welcome probe A' from r6_ids where tag = 'trial_second';
insert into r6_probe select 1, 'creating a company queues nothing', pg_temp.r6_queued('trial_second') = 0,
       pg_temp.r6_queued('trial_second') || ' queued';

update public.companies set details_completed_at = now()
 where id = (select id from r6_ids where tag = 'trial_second');
insert into r6_probe select 2, 'details alone (no plan, no trial) queue nothing', pg_temp.r6_queued('trial_second') = 0,
       pg_temp.r6_queued('trial_second') || ' queued';

update public.companies set trial_ends_at = now() + interval '14 days'
 where id = (select id from r6_ids where tag = 'trial_second');
insert into r6_probe select 3, 'POSITIVE CONTROL: becoming set up queues exactly one',
       pg_temp.r6_queued('trial_second') = 1, pg_temp.r6_queued('trial_second') || ' queued';

update public.companies set name = 'ZZ TEST r6 welcome probe A (renamed)'
 where id = (select id from r6_ids where tag = 'trial_second');
update public.companies set details_completed_at = now()
 where id = (select id from r6_ids where tag = 'trial_second');
insert into r6_probe select 4, 'later updates to a set-up company queue no second one',
       pg_temp.r6_queued('trial_second') = 1, pg_temp.r6_queued('trial_second') || ' queued';

-- ---- The door: the trigger's own header opens it; nothing else does ----
insert into r6_probe
select 5, 'the queued request carries the secret, and the door accepts it',
       coalesce(bool_and(public.welcome_email_trigger_ok(q.headers ->> 'x-fenceflow-welcome')), false),
       count(*) || ' request(s) checked; the value itself is not shown'
  from net.http_request_queue q
 where q.url = 'https://newcrgafcptspmapacrx.supabase.co/functions/v1/send-welcome-email'
   and convert_from(q.body, 'UTF8')::jsonb ->> 'company_id' = (select id::text from r6_ids where tag = 'trial_second');

insert into r6_probe select 6, 'the door refuses a wrong secret, a short one and null',
       not public.welcome_email_trigger_ok(repeat('0', 64))
   and not public.welcome_email_trigger_ok('abc')
   and not coalesce(public.welcome_email_trigger_ok(null), false),
       'three refusals expected';

insert into r6_probe select 7, 'only the service role may ask the door',
       not has_function_privilege('anon', 'public.welcome_email_trigger_ok(text)', 'execute')
   and not has_function_privilege('authenticated', 'public.welcome_email_trigger_ok(text)', 'execute')
   and has_function_privilege('service_role', 'public.welcome_email_trigger_ok(text)', 'execute'),
       'anon no, authenticated no, service_role yes';

-- ---- B: the subscription first, then the details (paid before naming it) ----
insert into public.companies (id, name, subscription_status)
select id, 'ZZ TEST r6 welcome probe B', 'trialing' from r6_ids where tag = 'details_second';
update public.companies set details_completed_at = now()
 where id = (select id from r6_ids where tag = 'details_second');
insert into r6_probe select 8, 'details arriving second also queue exactly one',
       pg_temp.r6_queued('details_second') = 1, pg_temp.r6_queued('details_second') || ' queued';

-- ---- C: a company already welcomed is never asked for again ----
insert into public.companies (id, name, welcome_sent_at)
select id, 'ZZ TEST r6 welcome probe C', now() from r6_ids where tag = 'already_sent';
update public.companies set details_completed_at = now(), trial_ends_at = now() + interval '14 days'
 where id = (select id from r6_ids where tag = 'already_sent');
insert into r6_probe select 9, 'an already-welcomed company queues nothing',
       pg_temp.r6_queued('already_sent') = 0, pg_temp.r6_queued('already_sent') || ' queued';

-- ---- The guard: a signed-in caller cannot move welcome_sent_at ----
select set_config('request.jwt.claims',
                  json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
update public.companies set welcome_sent_at = now()
 where id = (select id from r6_ids where tag = 'trial_second');
insert into r6_probe
select 10, 'a signed-in caller cannot set welcome_sent_at', c.welcome_sent_at is null,
       coalesce(c.welcome_sent_at::text, 'still empty')
  from public.companies c where c.id = (select id from r6_ids where tag = 'trial_second');

select set_config('request.jwt.claims', '', true);
update public.companies set welcome_sent_at = now()
 where id = (select id from r6_ids where tag = 'trial_second');
insert into r6_probe
select 11, 'with no signed-in user (the service role) it can', c.welcome_sent_at is not null,
       coalesce(c.welcome_sent_at::text, 'still empty')
  from public.companies c where c.id = (select id from r6_ids where tag = 'trial_second');

select n, check_name, ok, detail from r6_probe order by n;

rollback;

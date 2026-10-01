-- supabase_r18_join_door.sql
--
-- ############################################################################
-- #  STATUS: NOT APPLIED.  Written 2026-09-30.                               #
-- #                                                                          #
-- #  Running this file as it stands changes NOTHING. PART 1 is a dry run:    #
-- #  one transaction that installs the change, attacks it, proves the        #
-- #  legitimate paths still work, and ends in ROLLBACK. PART 2 (apply) and   #
-- #  PART 3 (reverse) are inside block comments and do not run.              #
-- #                                                                          #
-- #  This one changes WHO CAN JOIN A COMPANY. If it were wrong, nobody could #
-- #  be added to any company, the owner included. Read it, run PART 1, read  #
-- #  what comes back, and only then apply PART 2 by hand.                    #
-- ############################################################################
--
-- THE HOLE. Anybody can sign up. Anybody who holds a company's id could call
-- join_company(<that id>) and be that company's CREW at once, with nobody's
-- approval: read every customer's name, address, phone and site notes (gate
-- codes included), mark a job COMPLETED, edit a customer record. Money stayed
-- hidden and nothing could be deleted; those two rules held and this file does
-- not touch them. The company id is not a secret. It travels in every invite
-- email, it is on every member's own profile row, and it is the first path
-- segment of every job-file URL.
--
-- HOW JOINING WORKED, read on 2026-09-30 from the live catalogue and the code:
--   The invitation. invite-crew emails: the company name, who added them, the
--     recipient's own address, a download link, and "team code" = companies.id.
--     Nothing else. There is NO per-invite token. invite_sends (the send counter)
--     keeps the company, the sender, an md5 of the address and a time; nothing
--     reads it back to a joiner.
--   What the joiner submits. The app's join screen calls
--     join_company(target_company_id, member_name, requested_role_in). Nothing
--     about the invitation goes with it, only their login.
--   What creates the profile row. join_company itself (SECURITY DEFINER):
--     insert into profiles (id = the caller, company_id = the argument) ... role
--     always CREW. No trigger on auth.users makes a profile, and no policy lets
--     a client insert or move one into a company (profiles has no INSERT policy,
--     and its two UPDATE policies require you to be in the company already; the
--     dry run below attacks both and shows them refused).
--   What ties the two together. NOTHING. join_company never looks at the
--     caller's address, never at an invitation. The company id is the only
--     credential, and it is not secret.
--   The other doors into a company are sound for this purpose and are not
--     touched: claim_company_setup (a one-time code), claim_invited_company (the
--     company's invited_email must match the caller), create_company_with_owner.
--
-- WHAT WAS CHOSEN, AND WHY. Design (a): a separate join code, rotatable. There
-- was no existing per-invite token to reuse (see above), so nothing parallel is
-- being added beside a real one. The id identifies; the code authorises;
-- replacing the code kills every old invitation without changing the company.
--   * The code is a random uuid (122 bits), not a short word. The installed app
--     sends whatever is typed into the join field as a uuid parameter, so a
--     uuid-shaped code keeps the shipped app's join screen working unchanged,
--     and a code that long cannot be guessed, so no attempt limiter is needed.
--     A friendlier short code is possible later with a text overload and an app
--     change; it would then need an attempt limiter.
--   * It lives in its own table (company_join_codes): RLS on, no policy, every
--     grant revoked. Only the SECURITY DEFINER functions below can touch it.
--   * Nothing is written into any company's data by applying this. A company's
--     row appears the first time an entitled person asks for its code.
--   * join_company keeps its name, parameters, defaults and grants. Its first
--     argument now means "team code". A company id matches no code and is
--     refused in the same words as any wrong value.
--
-- WHO MAY DO WHAT
--   crew_join_code()             show the code       SHARE_INVITE_CODE (owner; a
--                                                    manager only if granted by name)
--   crew_join_code_for_invite()  invite-crew's read  owner or manager (as before);
--                                                    also says whether the caller may SEE it
--   rotate_join_code()           replace the code    owner only
--   join_company(code, ...)      join                any signed-in person holding the
--                                                    current code; unchanged otherwise
--
-- WHAT THIS FILE DOES NOT DO (each needs a change outside this file)
--   1. The Android Account screen still shows profile.companyId as "Team invite
--      code" with Copy and Share. After this is applied that value is refused.
--      It must show crew_join_code() instead (and offer rotate_join_code()).
--      Until it does, the owner's way to a working code is an invitation through
--      invite-crew (email, or the no-mail fallback that shows the code). Apply
--      this, deploy invite-crew, and ship the Account screen before release.
--   2. The dashboard's comments (dashboard.html near lines 10786 and 23058) and
--      supabase/functions/_shared/invite-crew-email.ts (comments only) still
--      describe the company id as the code. A "Team code" panel with a Replace
--      button on the dashboard's Crew tab is the natural place for the owner.
--   3. Deploy the new invite-crew IMMEDIATELY after applying: the old one still
--      emails the company id, which this refuses. The new one fails closed (500,
--      nothing sent) if this file has not been applied.
--   4. A leaked code still lets a stranger join until it is replaced, and no
--      push or email tells the owner when somebody joins (there is no database
--      webhook on profiles in production). Approval (design b) can be added on
--      top later.
--   5. Crew job scope (supabase_crew_job_scope.sql) is not applied in
--      production, so any crew login, including a legitimate joiner, sees every
--      customer. That is a separate decision from who may join.
--   6. tests/a25-tenant-isolation.test.mjs will go red for the RIGHT reason
--      after this is applied: its KNOWN_FINDINGS still list the join_company/*
--      pairs as leaks, and its catalogue check does not know company_join_codes
--      (a table nobody but the definer functions can reach). Strike F1 there.
--      supabase/dev/apply-order.txt should list this file.
--
-- THE REVERSE is PART 3: it puts the deployed join_company back byte for byte
-- (checked by md5) and drops the three new functions. It deletes no data. It
-- leaves company_join_codes in place; the line that would drop it is commented.
-- Reversing re-opens the hole.
--
-- DRY-RUN RESULT, 2026-09-30, against production, rolled back (nothing left
-- behind: users, companies, profiles, jobs, payments, queued HTTP calls all zero;
-- company_join_codes does not exist afterwards; join_company is byte-identical):
--   109 of 109 checks pass. The deployed function let a stranger holding only a
--   company's id become its crew, read its customers, mark its job COMPLETED and
--   edit a customer record (the "baseline" rows). With the change in, the same
--   attack is refused, word for word like any wrong code, and the legitimate
--   joiner, the invite path, an existing member and a code replacement all work.
--   Planted-failure runs (tests/a26-join-door.test.mjs, A26_LIVE=1): putting the old
--   join_company back turns the attack rows red; giving the new one an unqualified
--   table name and no pg_temp on its path turns the shadow-table row red.
--
-- USING THIS FILE
--   Dry run:  npx --no-install supabase@2.115.0 db query --linked \
--               --project-ref newcrgafcptspmapacrx -f supabase_r18_join_door.sql --output json
--             One row per check with PASS or FAIL, and a SUMMARY row last.
--             Rows marked "baseline" are the hole itself, reproduced on the
--             deployed function before the change goes in; they are recorded, not
--             scored. Every attack row has a CONTROL beside it: the same call that
--             must work, so a refusal is never just a typo.
--   Apply:    delete the two marker lines that open and close the PART 2 block
--             comment, run PART 2 alone, then put the markers back.
--   Reverse:  the same, for PART 3.
--
-- PART 1 -- DRY RUN. Rolled back. Names the bypass role nowhere: every attack
-- runs as the anonymous or the signed-in role, with a specific user's claims.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

create temp table r(n serial primary key, subject text, pair text, role text, k text, got text, want text);
grant all on r to authenticated, anon;
grant usage on sequence r_n_seq to authenticated, anon;
create temp table snap(k text primary key, v text);

-- The caller's JWT and role are set INLINE in each helper: once the role is
-- switched, another pg_temp function may not be callable, so nothing is called
-- between "set local role" and "reset role". A null "who" is the anon key. Every
-- attack runs as authenticated or anon, never as anything that bypasses row
-- level security. q: one scalar back (gk: also keep it in a session setting so a
-- later call can present it). x: run for effect, the real affected-row count.
-- s: the database owner READS BACK what an attack did or did not do; it never attacks.
create function pg_temp.q(sj text, pr text, ro text, kk text, who uuid, sq text, wt text, gk text default null) returns void language plpgsql as $fn$
declare v text;
begin
  if who is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub',who,'role','authenticated','aud','authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  begin execute sq into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  if gk is not null then perform set_config('a26.' || gk, v, true); end if;
  insert into r(subject,pair,role,k,got,want) values (sj,pr,ro,kk,v,wt);
end $fn$;

create function pg_temp.x(sj text, pr text, ro text, kk text, who uuid, sq text, wt text) returns void language plpgsql as $fn$
declare c int; v text;
begin
  if who is null then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub',who,'role','authenticated','aud','authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
  begin execute sq; get diagnostics c = row_count; v := 'rows=' || c;
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(subject,pair,role,k,got,want) values (sj,pr,ro,kk,v,wt);
end $fn$;

create function pg_temp.s(sj text, pr text, ro text, kk text, sq text, wt text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute sq into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,140); end;
  insert into r(subject,pair,role,k,got,want) values (sj,pr,ro,kk,v,wt);
end $fn$;

-- want: an exact string; 'ERR <sqlstate>' (prefix); '>=N'; '~<regex>'; 'info'
-- (recorded, never fails); or several of those joined with '|'.
create function pg_temp.ok(got text, want text) returns boolean language sql immutable as $fn$
  select coalesce((
    select bool_or(case
      when alt = 'info' then true
      when alt like '>=%' then case when got ~ '^[0-9]+$' then got::numeric >= substr(alt,3)::numeric else false end
      when alt like 'ERR %' then got like alt || '%'
      when alt like '~%' then got ~ substr(alt,2)
      else got = alt end)
    from unnest(string_to_array(want, '|')) as alt), false)
$fn$;

do $probe_before$
begin
  perform set_config('request.jwt.claims','',true);
  -- Everything below is synthetic: ids a26xxxxx-0000-4000-8000-..., names PROBE-A26-..., addresses @probe.invalid.
  insert into auth.users(id,email) values ('a2610000-0000-4000-8000-000000000001','a26-bo@probe.invalid'),('a2610000-0000-4000-8000-000000000002','a26-bm@probe.invalid'),('a2610000-0000-4000-8000-000000000003','a26-bmo@probe.invalid'),('a2610000-0000-4000-8000-000000000004','a26-bc@probe.invalid'),('a2610000-0000-4000-8000-000000000005','a26-w0@probe.invalid'),('a2610000-0000-4000-8000-000000000006','a26-w@probe.invalid'),('a2610000-0000-4000-8000-000000000007','a26-w2@probe.invalid'),('a2610000-0000-4000-8000-000000000008','a26-w3@probe.invalid'),('a2610000-0000-4000-8000-000000000009','a26-l@probe.invalid'),('a2610000-0000-4000-8000-00000000000a','a26-l2@probe.invalid'),('a2610000-0000-4000-8000-00000000000b','a26-rx@probe.invalid'),('a2610000-0000-4000-8000-00000000000c','a26-so@probe.invalid'),('a2610000-0000-4000-8000-00000000000d','a26-sj@probe.invalid'),('a2610000-0000-4000-8000-00000000000e','a26-ao@probe.invalid'),('a2610000-0000-4000-8000-00000000000f','a26-l3@probe.invalid'),('a2610000-0000-4000-8000-000000000010','a26-ex@probe.invalid');
  insert into public.companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason) values
    ('a2600000-0000-4000-8000-000000000001','PROBE-A26-VICTIM','active','pro',false,now()+interval '30 days','','a26f0000-0000-4000-8000-000000000001','cus_A26','',''), ('a2600000-0000-4000-8000-000000000002','PROBE-A26-SOLO-FULL','active','solo',false,now()+interval '30 days','','a26f0000-0000-4000-8000-000000000002','cus_A26','',''), ('a2600000-0000-4000-8000-000000000003','PROBE-A26-OTHER','active','pro',false,now()+interval '30 days','','a26f0000-0000-4000-8000-000000000003','cus_A26','','');
  insert into public.profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides,removed_from_company_id) values
    ('a2610000-0000-4000-8000-000000000001','a2600000-0000-4000-8000-000000000001','A26 Owner B','OWNER',false,'',null), ('a2610000-0000-4000-8000-000000000002','a2600000-0000-4000-8000-000000000001','A26 Manager B','MANAGER',false,'',null),
    ('a2610000-0000-4000-8000-000000000003','a2600000-0000-4000-8000-000000000001','A26 Manager B with the code','MANAGER',false,'+SHARE_INVITE_CODE',null), ('a2610000-0000-4000-8000-000000000004','a2600000-0000-4000-8000-000000000001','A26 Crew B','CREW',false,'',null),
    ('a2610000-0000-4000-8000-00000000000b',null,'A26 Removed B','CREW',false,'','a2600000-0000-4000-8000-000000000001'), ('a2610000-0000-4000-8000-000000000007',null,'A26 No Company','CREW',false,'',null),
    ('a2610000-0000-4000-8000-00000000000c','a2600000-0000-4000-8000-000000000002','A26 Owner S','OWNER',false,'',null),
    ('a2610000-0000-4000-8000-00000000000e','a2600000-0000-4000-8000-000000000003','A26 Owner A','OWNER',false,'',null), ('a2610000-0000-4000-8000-000000000010','a2600000-0000-4000-8000-000000000003','A26 Crew A','CREW',false,'',null);
  insert into public.jobs(id,company_id,sync_id,customer_name,address,phone,email,status,contract_total,quote_token,is_test_fixture,notes,hoa_name,permit_number,priced_by,pricing_engine_version,estimated_duration_hours,waste_percent,updated_at) values ('a2620000-0000-4000-8000-000000000001','a2600000-0000-4000-8000-000000000001','a2620000-0000-4000-8000-000000000001','A26 CUSTOMER','1 Probe Way','555-0100','a26@probe.invalid','ACCEPTED',5000,gen_random_uuid(),false,'','','','','',4,10,'2026-01-01 00:00:00+00');
  insert into public.jobs(id,company_id,sync_id,customer_name,address,phone,email,status,contract_total,quote_token,is_test_fixture,notes,hoa_name,permit_number,priced_by,pricing_engine_version,estimated_duration_hours,waste_percent,updated_at) values ('a2620000-0000-4000-8000-000000000002','a2600000-0000-4000-8000-000000000001','a2620000-0000-4000-8000-000000000002','A26 CUSTOMER','1 Probe Way','555-0100','a26@probe.invalid','ACCEPTED',5000,gen_random_uuid(),false,'','','','','',4,10,'2026-01-01 00:00:00+00');
  insert into public.jobs(id,company_id,sync_id,customer_name,address,phone,email,status,contract_total,quote_token,is_test_fixture,notes,hoa_name,permit_number,priced_by,pricing_engine_version,estimated_duration_hours,waste_percent,updated_at) values ('a2620000-0000-4000-8000-000000000003','a2600000-0000-4000-8000-000000000001','a2620000-0000-4000-8000-000000000003','A26 CUSTOMER','1 Probe Way','555-0100','a26@probe.invalid','ACCEPTED',5000,gen_random_uuid(),false,'','','','','',4,10,'2026-01-01 00:00:00+00');
  insert into public.jobs(id,company_id,sync_id,customer_name,address,phone,email,status,contract_total,quote_token,is_test_fixture,notes,hoa_name,permit_number,priced_by,pricing_engine_version,estimated_duration_hours,waste_percent,updated_at) values ('a2620000-0000-4000-8000-000000000004','a2600000-0000-4000-8000-000000000003','a2620000-0000-4000-8000-000000000004','A26 CUSTOMER','1 Probe Way','555-0100','a26@probe.invalid','ACCEPTED',5000,gen_random_uuid(),false,'','','','','',4,10,'2026-01-01 00:00:00+00');
  insert into public.customers(id,company_id,name,address,phone,email,notes,sync_id) values ('a2630000-0000-4000-8000-000000000001','a2600000-0000-4000-8000-000000000001','A26 CUSTOMER','1 Probe Way','555-0100','a26@probe.invalid','','a2630000-0000-4000-8000-000000000001');
  insert into public.customers(id,company_id,name,address,phone,email,notes,sync_id) values ('a2630000-0000-4000-8000-000000000002','a2600000-0000-4000-8000-000000000001','A26 CUSTOMER','1 Probe Way','555-0100','a26@probe.invalid','','a2630000-0000-4000-8000-000000000002');
  insert into public.customers(id,company_id,name,address,phone,email,notes,sync_id) values ('a2630000-0000-4000-8000-000000000003','a2600000-0000-4000-8000-000000000001','A26 CUSTOMER','1 Probe Way','555-0100','a26@probe.invalid','','a2630000-0000-4000-8000-000000000003');
  insert into public.customers(id,company_id,name,address,phone,email,notes,sync_id) values ('a2630000-0000-4000-8000-000000000004','a2600000-0000-4000-8000-000000000003','A26 CUSTOMER','1 Probe Way','555-0100','a26@probe.invalid','','a2630000-0000-4000-8000-000000000004');
  insert into public.payment_records(id,sync_id,company_id,job_sync_id,amount,method,received_at,note,recorded_by) values ('a2640000-0000-4000-8000-000000000001','a2640000-0000-4000-8000-000000000001','a2600000-0000-4000-8000-000000000001','a2620000-0000-4000-8000-000000000002',100,'check',now(),'','A26');
  insert into public.job_payments(id,company_id,job_sync_id,kind,amount_cents,currency,status) values ('a2650000-0000-4000-8000-000000000001','a2600000-0000-4000-8000-000000000001','a2620000-0000-4000-8000-000000000002','deposit',1000,'usd','paid');
  -- ---------------- BEFORE THE CHANGE: the deployed function, the attack as it was proven ----------------
  insert into snap values ('policies', (select md5(coalesce(string_agg(md5(concat_ws('|',schemaname,tablename,policyname,cmd,roles::text,qual,with_check)), ',' order by schemaname,tablename,policyname),'')) from pg_policies));
  insert into snap values ('relacls', (select md5(coalesce(string_agg(c.relname||':'||coalesce(c.relacl::text,''), ',' order by c.relname),'')) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','m','p','S') and c.relname <> 'company_join_codes'));
  insert into snap values ('otherfns', (select md5(coalesce(string_agg(p.oid::regprocedure::text||md5(p.prosrc), ',' order by p.oid::regprocedure::text),'')) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('claim_company_setup','claim_invited_company','create_company_with_owner','allow_rejoin','release_seat','set_member_role','note_invite_send','company_members','has_permission','current_user_role','crew_save_job','company_allowed')));
  insert into snap values ('joinbody', (select md5(p.prosrc) from pg_proc p where p.proname='join_company' and p.pronamespace='public'::regnamespace));
  insert into snap values ('applied', (to_regclass('public.company_join_codes') is not null)::text);
  perform pg_temp.s('REVERSE','exact','control','the join_company that is live is the one this file''s REVERSE restores (or this file is already applied)',$q$select case when (select v from snap where k='applied')='true' then 'applied' when (select v from snap where k='joinbody')='7283468b880d459cb46fe1036405eee3' then 'true' else 'false' end$q$,'true|applied');
  perform pg_temp.x('join_company','before','baseline','a signed-in stranger who holds only company B''s id joins B (the hole, deployed function)','a2610000-0000-4000-8000-000000000005'::uuid,$q$select public.join_company('a2600000-0000-4000-8000-000000000001', 'A26 baseline stranger', '')$q$,'info');
  perform pg_temp.s('join_company','before','baseline','...and is now a CREW member of B',$q$select (company_id = 'a2600000-0000-4000-8000-000000000001' and role::text = 'CREW')::text from public.profiles where id = 'a2610000-0000-4000-8000-000000000005'$q$,'info');
  perform pg_temp.q('join_company','before','baseline','...and reads B''s customers table','a2610000-0000-4000-8000-000000000005'::uuid,$q$select count(*)::text from public.customers where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'info');
  perform pg_temp.q('join_company','before','baseline','...and marks B''s job COMPLETED through the crew door','a2610000-0000-4000-8000-000000000005'::uuid,$q$select public.crew_save_job(jsonb_build_object('sync_id', 'a2620000-0000-4000-8000-000000000001', 'status', 'COMPLETED'))::text$q$,'info');
  perform pg_temp.s('join_company','before','baseline','...B''s job status now',$q$select status::text from public.jobs where sync_id = 'a2620000-0000-4000-8000-000000000001'$q$,'info');
  perform pg_temp.x('join_company','before','baseline','...and edits one of B''s customer records','a2610000-0000-4000-8000-000000000005'::uuid,$q$update public.customers set notes = 'A26 BASELINE' where id = 'a2630000-0000-4000-8000-000000000001'$q$,'info');
end $probe_before$;

-- ==== THE CHANGE: BEGIN ====

-- 1. WHERE THE CODES LIVE. A table of its own, not a column on companies: a
--    column would ride along in every "select *" view and every sync of the
--    companies row, and a secret must not. RLS is on with NO policy and every
--    grant is revoked, so no client role can read or write a row here; only the
--    SECURITY DEFINER functions below (which run as the table's owner) can.
--    One row per company, created the first time somebody entitled asks for the
--    code -- so applying this writes nothing into any company's data.
create table if not exists public.company_join_codes (
    company_id  uuid primary key references public.companies(id) on delete cascade,
    code        uuid not null unique default gen_random_uuid(),
    created_at  timestamptz not null default now(),
    rotated_at  timestamptz,
    rotated_by  uuid
);
alter table public.company_join_codes enable row level security;
revoke all on table public.company_join_codes from public, anon, authenticated;
comment on table public.company_join_codes is
    'The secret that lets somebody join a company as crew. Distinct from companies.id, which identifies and authorises nothing. Written only by crew_join_code(), crew_join_code_for_invite() and rotate_join_code().';

-- 2. SHOW THE CODE. For the screen that displays it and shares it. Gated by the
--    same SHARE_INVITE_CODE permission the apps already use (an owner has it; a
--    manager does not unless the owner grants it by name).
create or replace function public.crew_join_code()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    co uuid;
    c  uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in.' using errcode = '42501';
    end if;
    select p.company_id into co from public.profiles p where p.id = auth.uid();
    if co is null then
        raise exception 'You are not part of a business.' using errcode = '42501';
    end if;
    if not public.has_permission('SHARE_INVITE_CODE') then
        raise exception 'You are not allowed to see the team code. Ask the owner.' using errcode = '42501';
    end if;
    insert into public.company_join_codes (company_id) values (co)
        on conflict (company_id) do nothing;
    select j.code into c from public.company_join_codes j where j.company_id = co;
    return c;
end;
$function$;

-- 3. THE INVITE PATH. invite-crew emails the code to the address the office
--    typed. An office role may send that email, exactly as before, so this is
--    gated by role (the same gate invite-crew and note_invite_send already use),
--    not by SHARE_INVITE_CODE. may_show says whether the caller may ALSO be shown
--    the code on their own screen (the no-mail fallback); a manager without the
--    permission can send the invitation but is not handed the secret.
create or replace function public.crew_join_code_for_invite()
returns table (join_code uuid, may_show boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    co uuid;
    c  uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in.' using errcode = '42501';
    end if;
    select p.company_id into co from public.profiles p where p.id = auth.uid();
    if co is null then
        raise exception 'You are not part of a business.' using errcode = '42501';
    end if;
    if public.current_user_role()::text not in ('OWNER', 'MANAGER') then
        raise exception 'Office roles only.' using errcode = '42501';
    end if;
    insert into public.company_join_codes (company_id) values (co)
        on conflict (company_id) do nothing;
    select j.code into c from public.company_join_codes j where j.company_id = co;
    return query select c, public.has_permission('SHARE_INVITE_CODE');
end;
$function$;

-- 4. REPLACE THE CODE. Owner only, like removing a person or changing a role.
--    Every earlier code stops working at once; nobody already in is removed.
create or replace function public.rotate_join_code()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    co uuid;
    c  uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in.' using errcode = '42501';
    end if;
    select p.company_id into co from public.profiles p
     where p.id = auth.uid() and p.role = 'OWNER';
    if co is null then
        raise exception 'Only the owner can replace the team code.' using errcode = '42501';
    end if;
    insert into public.company_join_codes (company_id, code, rotated_at, rotated_by)
    values (co, gen_random_uuid(), now(), auth.uid())
    on conflict (company_id) do update
        set code       = excluded.code,
            rotated_at = excluded.rotated_at,
            rotated_by = excluded.rotated_by
    returning code into c;
    return c;
end;
$function$;

-- 5. THE DOOR. Same name, same three parameters, same names, same defaults, same
--    grants: the shipped app calls join_company(target_company_id, member_name,
--    requested_role_in) and keeps working. What changed is what the first
--    argument MEANS. It used to be the company's id; it is now the team code, and
--    a company id matches no code, so it is refused with the same words as any
--    other wrong value. Everything else the old body did is still done, in the
--    same order: not for somebody already in a business, not for somebody the
--    owner removed, the plan's seat cap (failing closed), always CREW.
--    Every table is schema-qualified and pg_temp is last on the search path, so a
--    caller cannot shadow a table with a temp table of their own.
create or replace function public.join_company(
    target_company_id uuid,
    member_name text,
    requested_role_in text default ''::text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    joining_company uuid;
    seat_cap int;
    seats_used int;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to join a business.';
    end if;

    -- What arrives in target_company_id is the TEAM CODE (the parameter keeps its
    -- old name so the installed app still binds). A company id is looked up as a
    -- code, finds nothing, and is refused like any wrong value: nothing here
    -- tells a caller whether a given uuid is a company.
    select j.company_id into joining_company
      from public.company_join_codes j
     where j.code = target_company_id;
    if joining_company is null then
        raise exception 'That team code is not valid, or the owner has replaced it. Ask the owner for the current one.';
    end if;

    -- Somebody who already has a business must be moved by an owner, never by
    -- themselves.
    if exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.company_id is not null) then
        raise exception 'You already belong to a business. Ask an owner to move you.';
    end if;

    -- A removal is remembered, and it blocks the return trip. The owner lifts it
    -- deliberately with allow_rejoin.
    if exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.removed_from_company_id = joining_company) then
        raise exception 'You no longer have access to this business. Ask the owner to add you back.';
    end if;

    select case lower(coalesce(c.subscription_plan, ''))
             when 'solo' then 1
             when 'crew' then 6
             when 'pro'  then null   -- unlimited logins is what Pro is sold as
             else 1                  -- unknown or blank plan: tightest cap, never none
           end
      into seat_cap
      from public.companies c where c.id = joining_company;

    if not found then
        raise exception 'That team code is not valid, or the owner has replaced it. Ask the owner for the current one.';
    end if;

    if seat_cap is not null then
        select count(*) into seats_used
          from public.profiles p
         where p.company_id = joining_company and p.id <> auth.uid();
        if seats_used >= seat_cap then
            raise exception 'Your plan is full — upgrade to add more crew.';
        end if;
    end if;

    insert into public.profiles (id, company_id, full_name, role, requested_role)
    values (auth.uid(), joining_company,
            coalesce(nullif(trim(member_name), ''), ''),
            -- Always the lowest role, whatever they asked for.
            'CREW',
            coalesce(nullif(requested_role_in, ''), ''))
    on conflict (id) do update
        set company_id     = excluded.company_id,
            full_name      = coalesce(nullif(excluded.full_name, ''), public.profiles.full_name),
            role           = 'CREW',
            requested_role = excluded.requested_role;
end;
$function$;

-- 6. WHO MAY CALL WHAT. New functions start with the platform's default grants,
--    which include the anonymous role; take that away, then give signed-in users
--    the door and nothing more. join_company keeps the grants it already has
--    (create or replace does not touch them).
revoke all on function public.crew_join_code()            from public, anon;
revoke all on function public.crew_join_code_for_invite() from public, anon;
revoke all on function public.rotate_join_code()          from public, anon;
grant execute on function public.crew_join_code()            to authenticated;
grant execute on function public.crew_join_code_for_invite() to authenticated;
grant execute on function public.rotate_join_code()          to authenticated;

-- ==== THE CHANGE: END ====


do $probe_after$
begin
  -- ---------------- AFTER THE CHANGE ----------------
  perform pg_temp.s('unchanged','policies','control','no row-level-security policy anywhere in the database changed',$q$select ((select md5(coalesce(string_agg(md5(concat_ws('|',schemaname,tablename,policyname,cmd,roles::text,qual,with_check)), ',' order by schemaname,tablename,policyname),'')) from pg_policies) = (select v from snap where k='policies'))::text$q$,'true');
  perform pg_temp.s('unchanged','relacls','control','no table, view or sequence privilege in public changed (the new table aside)',$q$select ((select md5(coalesce(string_agg(c.relname||':'||coalesce(c.relacl::text,''), ',' order by c.relname),'')) from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','m','p','S') and c.relname <> 'company_join_codes') = (select v from snap where k='relacls'))::text$q$,'true');
  perform pg_temp.s('unchanged','otherfns','control','the other doors into a company, the crew door and the money/role helpers are byte-for-byte what they were',$q$select ((select md5(coalesce(string_agg(p.oid::regprocedure::text||md5(p.prosrc), ',' order by p.oid::regprocedure::text),'')) from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('claim_company_setup','claim_invited_company','create_company_with_owner','allow_rejoin','release_seat','set_member_role','note_invite_send','company_members','has_permission','current_user_role','crew_save_job','company_allowed')) = (select v from snap where k='otherfns'))::text$q$,'true');
  perform pg_temp.s('join_company','surface','control','join_company keeps its name, its three parameter names and the default on the last',$q$select (pg_get_function_arguments(p.oid) = 'target_company_id uuid, member_name text, requested_role_in text DEFAULT ''''::text')::text from pg_proc p where p.proname='join_company' and p.pronamespace='public'::regnamespace$q$,'true');
  perform pg_temp.s('company_join_codes','surface','control','row-level security is on and there is no policy',$q$select (c.relrowsecurity and not exists (select 1 from pg_policies where schemaname='public' and tablename='company_join_codes'))::text from pg_class c where c.oid = 'public.company_join_codes'::regclass$q$,'true');
  perform pg_temp.s('company_join_codes','surface','control','neither the anonymous nor the signed-in role holds any privilege on it',$q$select (not has_table_privilege('anon','public.company_join_codes','select,insert,update,delete') and not has_table_privilege('authenticated','public.company_join_codes','select,insert,update,delete'))::text$q$,'true');
  perform pg_temp.s('crew_join_code()','surface','control','the anonymous role cannot execute crew_join_code()',$q$select has_function_privilege('anon','public.crew_join_code()','execute')::text$q$,'false');
  perform pg_temp.s('crew_join_code()','surface','control','the signed-in role can execute crew_join_code()',$q$select has_function_privilege('authenticated','public.crew_join_code()','execute')::text$q$,'true');
  perform pg_temp.s('crew_join_code_for_invite()','surface','control','the anonymous role cannot execute crew_join_code_for_invite()',$q$select has_function_privilege('anon','public.crew_join_code_for_invite()','execute')::text$q$,'false');
  perform pg_temp.s('crew_join_code_for_invite()','surface','control','the signed-in role can execute crew_join_code_for_invite()',$q$select has_function_privilege('authenticated','public.crew_join_code_for_invite()','execute')::text$q$,'true');
  perform pg_temp.s('rotate_join_code()','surface','control','the anonymous role cannot execute rotate_join_code()',$q$select has_function_privilege('anon','public.rotate_join_code()','execute')::text$q$,'false');
  perform pg_temp.s('rotate_join_code()','surface','control','the signed-in role can execute rotate_join_code()',$q$select has_function_privilege('authenticated','public.rotate_join_code()','execute')::text$q$,'true');
  perform pg_temp.s('join_company(uuid,text,text)','surface','control','the anonymous role cannot execute join_company(uuid,text,text)',$q$select has_function_privilege('anon','public.join_company(uuid,text,text)','execute')::text$q$,'false');
  perform pg_temp.s('join_company(uuid,text,text)','surface','control','the signed-in role can execute join_company(uuid,text,text)',$q$select has_function_privilege('authenticated','public.join_company(uuid,text,text)','execute')::text$q$,'true');
  perform pg_temp.s('surface','search_path','control','the four functions pin search_path and put pg_temp last',$q$select (count(*) = 4 and bool_and(exists (select 1 from unnest(p.proconfig) c where c ~ '^search_path=.*pg_temp$')))::text from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('crew_join_code','crew_join_code_for_invite','rotate_join_code','join_company')$q$,'true');
  -- A caller cannot stand a table of their own in front of the code table: the function names public.company_join_codes and pg_temp is last on its search path.
  -- This goes FIRST among the calls to join_company on purpose. Postgres keeps a function's query plans for the session, and a table stood in front of one that has
  -- already been planned is not noticed; an attacker's first call on a fresh connection is exactly this one, so it is tried while the plan is fresh.
  perform pg_temp.x('join_company','shadow','setup','the stranger makes a temporary table called company_join_codes (the signed-in role may not be allowed to: either answer is fine)','a2610000-0000-4000-8000-000000000006'::uuid,$q$create temp table company_join_codes(company_id uuid, code uuid)$q$,'info');
  perform pg_temp.x('join_company','shadow','setup','...and, if it exists, files B''s id and a code of their own choosing in it','a2610000-0000-4000-8000-000000000006'::uuid,$q$insert into pg_temp.company_join_codes values ('a2600000-0000-4000-8000-000000000001', 'a26f0000-0000-4000-8000-00000000004d')$q$,'info');
  perform pg_temp.x('join_company','shadow','probe','...then presents that code: it opens nothing','a2610000-0000-4000-8000-000000000006'::uuid,$q$select public.join_company('a26f0000-0000-4000-8000-00000000004d', 'A26 shadow', '')$q$,'ERR P0001');
  perform pg_temp.s('join_company','shadow','readback','...the stranger still has no company',$q$select (not exists (select 1 from public.profiles where id = 'a2610000-0000-4000-8000-000000000006'))::text$q$,'true');
  perform pg_temp.x('join_company','door','control','the call is live: a uuid that is neither a code nor a company is refused','a2610000-0000-4000-8000-000000000006'::uuid,$q$select public.join_company('a26f0000-0000-4000-8000-000000000063', 'A26 stranger', '')$q$,'ERR P0001');
  perform pg_temp.x('join_company','door','probe','a signed-in stranger who holds only company B''s id tries to join B','a2610000-0000-4000-8000-000000000006'::uuid,$q$select public.join_company('a2600000-0000-4000-8000-000000000001', 'A26 stranger', '')$q$,'ERR P0001');
  perform pg_temp.s('join_company','door','readback','...and the two refusals are word for word the same (a company id is not told apart from any wrong value)',$q$select (count(distinct got) = 1 and count(*) = 2)::text from r where subject='join_company' and pair='door' and role in ('probe','control')$q$,'true');
  perform pg_temp.s('join_company','door','readback','...the stranger has no company',$q$select (not exists (select 1 from public.profiles where id = 'a2610000-0000-4000-8000-000000000006'))::text$q$,'true');
  perform pg_temp.x('join_company','door_profile_row','probe','the same, from an account whose profile row exists but has no company','a2610000-0000-4000-8000-000000000007'::uuid,$q$select public.join_company('a2600000-0000-4000-8000-000000000001', 'A26 stranger two', 'MANAGER')$q$,'ERR P0001');
  perform pg_temp.s('join_company','door_profile_row','readback','...that account still has no company and is still CREW',$q$select (company_id is null and role::text = 'CREW')::text from public.profiles where id = 'a2610000-0000-4000-8000-000000000007'$q$,'true');
  perform pg_temp.q('join_company','reads_jobs','probe','...so it reads no job of B''s (name, address, phone, email, notes)','a2610000-0000-4000-8000-000000000006'::uuid,$q$select count(*)::text from public.jobs_crew where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.q('join_company','reads_jobs','control','B''s own crew member reads B''s jobs through the same view (the query works)','a2610000-0000-4000-8000-000000000004'::uuid,$q$select count(*)::text from public.jobs_crew where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'>=1');
  perform pg_temp.q('join_company','reads_customers','probe','...reads none of B''s customers','a2610000-0000-4000-8000-000000000006'::uuid,$q$select count(*)::text from public.customers where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.q('join_company','reads_customers','control','B''s own crew member reads B''s customers','a2610000-0000-4000-8000-000000000004'::uuid,$q$select count(*)::text from public.customers where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'>=1');
  perform pg_temp.q('join_company','reads_members','probe','...lists none of B''s members','a2610000-0000-4000-8000-000000000006'::uuid,$q$select count(*)::text from public.company_members() where id = 'a2610000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.q('join_company','reads_members','control','B''s own crew member lists B''s members','a2610000-0000-4000-8000-000000000004'::uuid,$q$select count(*)::text from public.company_members() where id = 'a2610000-0000-4000-8000-000000000001'$q$,'1');
  perform pg_temp.q('join_company','writes_jobs','probe','...cannot mark B''s job COMPLETED through the crew door','a2610000-0000-4000-8000-000000000006'::uuid,$q$select public.crew_save_job(jsonb_build_object('sync_id', 'a2620000-0000-4000-8000-000000000002', 'status', 'COMPLETED'))::text$q$,'false|ERR 42501');
  perform pg_temp.s('join_company','writes_jobs','readback','...B''s job is still ACCEPTED',$q$select status::text from public.jobs where sync_id = 'a2620000-0000-4000-8000-000000000002'$q$,'ACCEPTED');
  perform pg_temp.q('join_company','writes_jobs','control','B''s own crew member marks another of B''s jobs COMPLETED through the same door','a2610000-0000-4000-8000-000000000004'::uuid,$q$select public.crew_save_job(jsonb_build_object('sync_id', 'a2620000-0000-4000-8000-000000000003', 'status', 'COMPLETED'))::text$q$,'true');
  perform pg_temp.x('join_company','writes_customers','probe','...cannot edit a customer record of B''s','a2610000-0000-4000-8000-000000000006'::uuid,$q$update public.customers set notes = 'A26 STRANGER' where id = 'a2630000-0000-4000-8000-000000000002'$q$,'rows=0');
  perform pg_temp.s('join_company','writes_customers','readback','...B''s customer record is untouched',$q$select (notes = '')::text from public.customers where id = 'a2630000-0000-4000-8000-000000000002'$q$,'true');
  perform pg_temp.x('join_company','writes_customers','control','B''s own crew member edits another of B''s customer records','a2610000-0000-4000-8000-000000000004'::uuid,$q$update public.customers set notes = 'A26 CREW' where id = 'a2630000-0000-4000-8000-000000000003'$q$,'rows=1');
  perform pg_temp.x('join_company','guessing','probe','another company''s id, and the id of the company the stranger sits in, open nothing either','a2610000-0000-4000-8000-000000000010'::uuid,$q$select public.join_company('a2600000-0000-4000-8000-000000000001', 'A26 member of A', '')$q$,'ERR P0001');
  perform pg_temp.x('profiles','other_ways_in','probe','a stranger writes their own profile row straight into B as its OWNER','a2610000-0000-4000-8000-000000000006'::uuid,$q$insert into public.profiles(id, company_id, full_name, role) values ('a2610000-0000-4000-8000-000000000006', 'a2600000-0000-4000-8000-000000000001', 'A26 direct', 'OWNER')$q$,'ERR 42501');
  perform pg_temp.s('profiles','other_ways_in','readback','...no row was made',$q$select (not exists (select 1 from public.profiles where id = 'a2610000-0000-4000-8000-000000000006'))::text$q$,'true');
  perform pg_temp.x('profiles','other_ways_in','probe','an account whose profile has no company points it at B and makes itself OWNER','a2610000-0000-4000-8000-000000000007'::uuid,$q$update public.profiles set company_id = 'a2600000-0000-4000-8000-000000000001', role = 'OWNER' where id = 'a2610000-0000-4000-8000-000000000007'$q$,'rows=0');
  perform pg_temp.s('profiles','other_ways_in','readback','...it still has no company and is still CREW',$q$select (company_id is null and role::text = 'CREW')::text from public.profiles where id = 'a2610000-0000-4000-8000-000000000007'$q$,'true');
  perform pg_temp.x('profiles','other_ways_in','control','B''s owner edits a member of B through the same table (the update path is live)','a2610000-0000-4000-8000-000000000001'::uuid,$q$update public.profiles set full_name = 'A26 Crew B renamed' where id = 'a2610000-0000-4000-8000-000000000004'$q$,'rows=1');
  perform pg_temp.x('company_join_codes','direct','probe','B''s owner reads the table directly','a2610000-0000-4000-8000-000000000001'::uuid,$q$select * from public.company_join_codes$q$,'ERR 42501');
  perform pg_temp.x('company_join_codes','direct','probe','the anonymous key reads the table directly',null::uuid,$q$select * from public.company_join_codes$q$,'ERR 42501');
  perform pg_temp.x('company_join_codes','direct','probe','B''s owner writes a code of their own choosing','a2610000-0000-4000-8000-000000000001'::uuid,$q$insert into public.company_join_codes(company_id, code) values ('a2600000-0000-4000-8000-000000000001', 'a2600000-0000-4000-8000-000000000001')$q$,'ERR 42501');
  perform pg_temp.q('crew_join_code','who','control','B''s owner is shown B''s code (saved for the calls below)','a2610000-0000-4000-8000-000000000001'::uuid,$q$select public.crew_join_code()::text$q$,'~^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','code_b');
  perform pg_temp.s('crew_join_code','who','readback','...it is B''s row in the table, and it is not B''s company id',$q$select (j.code::text = current_setting('a26.code_b') and j.code <> j.company_id)::text from public.company_join_codes j where j.company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'true');
  perform pg_temp.q('crew_join_code','who','probe','B''s manager, who does not hold SHARE_INVITE_CODE, is not shown it','a2610000-0000-4000-8000-000000000002'::uuid,$q$select public.crew_join_code()::text$q$,'ERR 42501');
  perform pg_temp.q('crew_join_code','who','control','B''s manager to whom the owner granted SHARE_INVITE_CODE by name is shown the same code','a2610000-0000-4000-8000-000000000003'::uuid,$q$select (public.crew_join_code()::text = current_setting('a26.code_b'))::text$q$,'true');
  perform pg_temp.q('crew_join_code','who','probe','B''s crew member is not shown it','a2610000-0000-4000-8000-000000000004'::uuid,$q$select public.crew_join_code()::text$q$,'ERR 42501');
  perform pg_temp.q('crew_join_code','who','probe','a stranger with no company is not shown it','a2610000-0000-4000-8000-000000000006'::uuid,$q$select public.crew_join_code()::text$q$,'ERR 42501');
  perform pg_temp.q('crew_join_code','who','probe','the anonymous key is not shown it',null::uuid,$q$select public.crew_join_code()::text$q$,'ERR 42501');
  perform pg_temp.q('crew_join_code_for_invite','who','control','B''s owner, inviting somebody, is given B''s code and may see it','a2610000-0000-4000-8000-000000000001'::uuid,$q$select (join_code::text = current_setting('a26.code_b'))::text || '/' || may_show::text from public.crew_join_code_for_invite()$q$,'true/true');
  perform pg_temp.q('crew_join_code_for_invite','who','control','B''s manager, inviting somebody, is given the code to put in the email but is not allowed to see it','a2610000-0000-4000-8000-000000000002'::uuid,$q$select (join_code::text = current_setting('a26.code_b'))::text || '/' || may_show::text from public.crew_join_code_for_invite()$q$,'true/false');
  perform pg_temp.q('crew_join_code_for_invite','who','control','the manager who holds SHARE_INVITE_CODE may see it','a2610000-0000-4000-8000-000000000003'::uuid,$q$select may_show::text from public.crew_join_code_for_invite()$q$,'true');
  perform pg_temp.q('crew_join_code_for_invite','who','probe','B''s crew member cannot send an invitation','a2610000-0000-4000-8000-000000000004'::uuid,$q$select join_code::text from public.crew_join_code_for_invite()$q$,'ERR 42501');
  perform pg_temp.q('crew_join_code_for_invite','who','probe','a stranger cannot','a2610000-0000-4000-8000-000000000006'::uuid,$q$select join_code::text from public.crew_join_code_for_invite()$q$,'ERR 42501');
  perform pg_temp.q('crew_join_code_for_invite','who','probe','the anonymous key cannot',null::uuid,$q$select join_code::text from public.crew_join_code_for_invite()$q$,'ERR 42501');
  perform pg_temp.s('company_join_codes','direct','control','the table works: B has exactly one row, made by the owner asking for the code',$q$select count(*)::text from public.company_join_codes where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'1');
  perform pg_temp.x('join_company','legit','control','a new crew member joins B with B''s code, exactly as the app calls it','a2610000-0000-4000-8000-000000000009'::uuid,$q$select public.join_company(target_company_id => current_setting('a26.code_b')::uuid, member_name => 'A26 Legit Joiner', requested_role_in => 'FOREMAN')$q$,'rows=1');
  perform pg_temp.s('join_company','legit','readback','...they are in B, as CREW whatever they asked to be, and the request is recorded for the owner',$q$select (company_id = 'a2600000-0000-4000-8000-000000000001' and role::text = 'CREW' and requested_role = 'FOREMAN' and full_name = 'A26 Legit Joiner')::text from public.profiles where id = 'a2610000-0000-4000-8000-000000000009'$q$,'true');
  perform pg_temp.q('join_company','legit','control','...and they read B''s jobs as B''s crew do','a2610000-0000-4000-8000-000000000009'::uuid,$q$select count(*)::text from public.jobs_crew where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'>=1');
  perform pg_temp.q('join_company','legit','probe','...but B''s payments stay hidden from them','a2610000-0000-4000-8000-000000000009'::uuid,$q$select count(*)::text from public.payment_records where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.q('join_company','legit','control','(B''s owner does see the payment: the money query works)','a2610000-0000-4000-8000-000000000001'::uuid,$q$select count(*)::text from public.payment_records where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'>=1');
  perform pg_temp.q('join_company','legit','probe','...and B''s card payments stay hidden from them','a2610000-0000-4000-8000-000000000009'::uuid,$q$select count(*)::text from public.job_payments where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.q('join_company','legit','control','(B''s owner does see them)','a2610000-0000-4000-8000-000000000001'::uuid,$q$select count(*)::text from public.job_payments where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'>=1');
  perform pg_temp.q('join_company','legit','probe','...and they read nothing of company A''s','a2610000-0000-4000-8000-000000000009'::uuid,$q$select count(*)::text from public.jobs_crew where company_id = 'a2600000-0000-4000-8000-000000000003'$q$,'0');
  perform pg_temp.q('join_company','legit','control','(A''s owner does read A''s job)','a2610000-0000-4000-8000-00000000000e'::uuid,$q$select count(*)::text from public.jobs_crew where company_id = 'a2600000-0000-4000-8000-000000000003'$q$,'>=1');
  perform pg_temp.x('join_company','already_in','control','somebody already in a business is still told to ask an owner to move them (unchanged)','a2610000-0000-4000-8000-000000000009'::uuid,$q$select public.join_company(current_setting('a26.code_b')::uuid, 'A26 Legit Joiner', '')$q$,'ERR P0001: You already belong');
  perform pg_temp.x('join_company','already_in','control','B''s existing crew member calling it with the code changes nothing','a2610000-0000-4000-8000-000000000004'::uuid,$q$select public.join_company(current_setting('a26.code_b')::uuid, 'A26 Crew B', '')$q$,'ERR P0001: You already belong');
  perform pg_temp.q('join_company','already_in','control','B''s existing crew member still works as before','a2610000-0000-4000-8000-000000000004'::uuid,$q$select count(*)::text from public.jobs_crew where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'>=1');
  perform pg_temp.x('join_company','already_in','probe','a member of company A cannot use B''s code to move themselves to B','a2610000-0000-4000-8000-000000000010'::uuid,$q$select public.join_company(current_setting('a26.code_b')::uuid, 'A26 Crew A', '')$q$,'ERR P0001: You already belong');
  perform pg_temp.s('join_company','already_in','readback','...and is still in A',$q$select (company_id = 'a2600000-0000-4000-8000-000000000003')::text from public.profiles where id = 'a2610000-0000-4000-8000-000000000010'$q$,'true');
  perform pg_temp.x('join_company','removed','probe','somebody the owner removed cannot come back with a valid code (allow_rejoin still decides)','a2610000-0000-4000-8000-00000000000b'::uuid,$q$select public.join_company(current_setting('a26.code_b')::uuid, 'A26 Removed B', '')$q$,'ERR P0001: You no longer have access');
  perform pg_temp.s('join_company','removed','readback','...they still have no company',$q$select (company_id is null)::text from public.profiles where id = 'a2610000-0000-4000-8000-00000000000b'$q$,'true');
  perform pg_temp.q('crew_join_code','seat_cap','control','S (Solo plan, one seat, taken by its owner): the owner is shown S''s code','a2610000-0000-4000-8000-00000000000c'::uuid,$q$select public.crew_join_code()::text$q$,'~^[0-9a-f]{8}-','code_s');
  perform pg_temp.x('join_company','seat_cap','probe','a valid code for a company whose plan is full still does not seat anybody','a2610000-0000-4000-8000-00000000000d'::uuid,$q$select public.join_company(current_setting('a26.code_s')::uuid, 'A26 Too Many', '')$q$,'ERR P0001: Your plan is full');
  perform pg_temp.s('join_company','seat_cap','readback','...S has one login',$q$select count(*)::text from public.profiles where company_id = 'a2600000-0000-4000-8000-000000000002'$q$,'1');
  perform pg_temp.q('crew_join_code','cross','control','A''s owner is shown A''s code','a2610000-0000-4000-8000-00000000000e'::uuid,$q$select public.crew_join_code()::text$q$,'~^[0-9a-f]{8}-','code_a');
  perform pg_temp.s('crew_join_code','cross','readback','...which is not B''s',$q$select (current_setting('a26.code_a') <> current_setting('a26.code_b'))::text$q$,'true');
  perform pg_temp.x('join_company','cross','control','a new crew member joins A with A''s code','a2610000-0000-4000-8000-00000000000f'::uuid,$q$select public.join_company(current_setting('a26.code_a')::uuid, 'A26 Legit A', '')$q$,'rows=1');
  perform pg_temp.s('join_company','cross','readback','...they are in A, not B',$q$select (company_id = 'a2600000-0000-4000-8000-000000000003')::text from public.profiles where id = 'a2610000-0000-4000-8000-00000000000f'$q$,'true');
  perform pg_temp.q('join_company','cross','probe','...and read none of B''s jobs','a2610000-0000-4000-8000-00000000000f'::uuid,$q$select count(*)::text from public.jobs_crew where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'0');
  perform pg_temp.q('rotate_join_code','who','probe','B''s manager cannot replace the code','a2610000-0000-4000-8000-000000000002'::uuid,$q$select public.rotate_join_code()::text$q$,'ERR 42501');
  perform pg_temp.q('rotate_join_code','who','probe','B''s manager who holds SHARE_INVITE_CODE cannot replace it either (owner only)','a2610000-0000-4000-8000-000000000003'::uuid,$q$select public.rotate_join_code()::text$q$,'ERR 42501');
  perform pg_temp.q('rotate_join_code','who','probe','B''s crew member cannot','a2610000-0000-4000-8000-000000000004'::uuid,$q$select public.rotate_join_code()::text$q$,'ERR 42501');
  perform pg_temp.q('rotate_join_code','who','probe','a stranger cannot','a2610000-0000-4000-8000-000000000006'::uuid,$q$select public.rotate_join_code()::text$q$,'ERR 42501');
  perform pg_temp.q('rotate_join_code','who','probe','the anonymous key cannot',null::uuid,$q$select public.rotate_join_code()::text$q$,'ERR 42501');
  perform pg_temp.s('rotate_join_code','who','readback','...B''s code is unchanged by all of that',$q$select (code::text = current_setting('a26.code_b'))::text from public.company_join_codes where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'true');
  perform pg_temp.q('rotate_join_code','who','control','B''s owner replaces the code','a2610000-0000-4000-8000-000000000001'::uuid,$q$select public.rotate_join_code()::text$q$,'~^[0-9a-f]{8}-','code_b2');
  perform pg_temp.s('rotate_join_code','who','readback','...it is a different code, recorded with who and when',$q$select (code::text = current_setting('a26.code_b2') and code::text <> current_setting('a26.code_b') and rotated_by = 'a2610000-0000-4000-8000-000000000001' and rotated_at is not null)::text from public.company_join_codes where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'true');
  perform pg_temp.s('rotate_join_code','cross','readback','...and A''s code is not touched by B''s owner replacing theirs',$q$select (code::text = current_setting('a26.code_a'))::text from public.company_join_codes where company_id = 'a2600000-0000-4000-8000-000000000003'$q$,'true');
  perform pg_temp.x('join_company','replaced','probe','the old code, from an email sent last week, no longer opens anything','a2610000-0000-4000-8000-000000000008'::uuid,$q$select public.join_company(current_setting('a26.code_b')::uuid, 'A26 Stale Code', '')$q$,'ERR P0001: That team code is not valid');
  perform pg_temp.s('join_company','replaced','readback','...the holder of the old code has no company',$q$select (not exists (select 1 from public.profiles where id = 'a2610000-0000-4000-8000-000000000008'))::text$q$,'true');
  perform pg_temp.x('join_company','replaced','control','the new code opens B to a new crew member','a2610000-0000-4000-8000-00000000000a'::uuid,$q$select public.join_company(target_company_id => current_setting('a26.code_b2')::uuid, member_name => 'A26 Legit Two', requested_role_in => '')$q$,'rows=1');
  perform pg_temp.s('join_company','replaced','readback','...they are in B as CREW',$q$select (company_id = 'a2600000-0000-4000-8000-000000000001' and role::text = 'CREW')::text from public.profiles where id = 'a2610000-0000-4000-8000-00000000000a'$q$,'true');
  perform pg_temp.q('join_company','replaced','control','somebody who joined before the code was replaced is still in and still works','a2610000-0000-4000-8000-000000000009'::uuid,$q$select count(*)::text from public.jobs_crew where company_id = 'a2600000-0000-4000-8000-000000000001'$q$,'>=1');
  perform pg_temp.x('join_company','replaced','probe','the removed member still cannot come back with the new code','a2610000-0000-4000-8000-00000000000b'::uuid,$q$select public.join_company(current_setting('a26.code_b2')::uuid, 'A26 Removed B', '')$q$,'ERR P0001: You no longer have access');
  perform pg_temp.x('claim_company_setup','other_doors','control','a stranger''s guess at a setup code is refused (unchanged)','a2610000-0000-4000-8000-000000000006'::uuid,$q$select public.claim_company_setup('A26X-A26X', 'A26 stranger')$q$,'ERR P0001');
  perform pg_temp.x('claim_invited_company','other_doors','control','a stranger with no invitation cannot claim a company (unchanged)','a2610000-0000-4000-8000-000000000006'::uuid,$q$select public.claim_invited_company('A26 stranger')$q$,'ERR P0001');
  perform pg_temp.s('surface','end_state','readback','the attacker accounts end the run with no company (the attack changed nothing of theirs)',$q$select count(*)::text from public.profiles where id in ('a2610000-0000-4000-8000-000000000006', 'a2610000-0000-4000-8000-000000000007', 'a2610000-0000-4000-8000-000000000008') and company_id is not null$q$,'0');
end $probe_after$;

select n, subject, pair, role, k, got, want, case when pg_temp.ok(got, want) then 'PASS' else 'FAIL' end as result from r
union all
select 1000000, 'SUMMARY', '-', '-', 'passed/total',
       (select count(*) filter (where pg_temp.ok(got, want))::text || '/' || count(*)::text from r), '-', '-'
 order by 1;

rollback;

-- =============================================================================
-- PART 2 -- APPLY.  To apply: delete the line "/* PART 2 BEGINS" and the line
-- "PART 2 ENDS */", run this block alone, then put both lines back.
-- The statements between the THE CHANGE markers are byte for byte the ones
-- PART 1 ran and proved (tests/a26-join-door.test.mjs holds them equal).
-- =============================================================================
/* PART 2 BEGINS
begin;

-- ==== THE CHANGE: BEGIN ====

-- 1. WHERE THE CODES LIVE. A table of its own, not a column on companies: a
--    column would ride along in every "select *" view and every sync of the
--    companies row, and a secret must not. RLS is on with NO policy and every
--    grant is revoked, so no client role can read or write a row here; only the
--    SECURITY DEFINER functions below (which run as the table's owner) can.
--    One row per company, created the first time somebody entitled asks for the
--    code -- so applying this writes nothing into any company's data.
create table if not exists public.company_join_codes (
    company_id  uuid primary key references public.companies(id) on delete cascade,
    code        uuid not null unique default gen_random_uuid(),
    created_at  timestamptz not null default now(),
    rotated_at  timestamptz,
    rotated_by  uuid
);
alter table public.company_join_codes enable row level security;
revoke all on table public.company_join_codes from public, anon, authenticated;
comment on table public.company_join_codes is
    'The secret that lets somebody join a company as crew. Distinct from companies.id, which identifies and authorises nothing. Written only by crew_join_code(), crew_join_code_for_invite() and rotate_join_code().';

-- 2. SHOW THE CODE. For the screen that displays it and shares it. Gated by the
--    same SHARE_INVITE_CODE permission the apps already use (an owner has it; a
--    manager does not unless the owner grants it by name).
create or replace function public.crew_join_code()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    co uuid;
    c  uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in.' using errcode = '42501';
    end if;
    select p.company_id into co from public.profiles p where p.id = auth.uid();
    if co is null then
        raise exception 'You are not part of a business.' using errcode = '42501';
    end if;
    if not public.has_permission('SHARE_INVITE_CODE') then
        raise exception 'You are not allowed to see the team code. Ask the owner.' using errcode = '42501';
    end if;
    insert into public.company_join_codes (company_id) values (co)
        on conflict (company_id) do nothing;
    select j.code into c from public.company_join_codes j where j.company_id = co;
    return c;
end;
$function$;

-- 3. THE INVITE PATH. invite-crew emails the code to the address the office
--    typed. An office role may send that email, exactly as before, so this is
--    gated by role (the same gate invite-crew and note_invite_send already use),
--    not by SHARE_INVITE_CODE. may_show says whether the caller may ALSO be shown
--    the code on their own screen (the no-mail fallback); a manager without the
--    permission can send the invitation but is not handed the secret.
create or replace function public.crew_join_code_for_invite()
returns table (join_code uuid, may_show boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    co uuid;
    c  uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in.' using errcode = '42501';
    end if;
    select p.company_id into co from public.profiles p where p.id = auth.uid();
    if co is null then
        raise exception 'You are not part of a business.' using errcode = '42501';
    end if;
    if public.current_user_role()::text not in ('OWNER', 'MANAGER') then
        raise exception 'Office roles only.' using errcode = '42501';
    end if;
    insert into public.company_join_codes (company_id) values (co)
        on conflict (company_id) do nothing;
    select j.code into c from public.company_join_codes j where j.company_id = co;
    return query select c, public.has_permission('SHARE_INVITE_CODE');
end;
$function$;

-- 4. REPLACE THE CODE. Owner only, like removing a person or changing a role.
--    Every earlier code stops working at once; nobody already in is removed.
create or replace function public.rotate_join_code()
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    co uuid;
    c  uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in.' using errcode = '42501';
    end if;
    select p.company_id into co from public.profiles p
     where p.id = auth.uid() and p.role = 'OWNER';
    if co is null then
        raise exception 'Only the owner can replace the team code.' using errcode = '42501';
    end if;
    insert into public.company_join_codes (company_id, code, rotated_at, rotated_by)
    values (co, gen_random_uuid(), now(), auth.uid())
    on conflict (company_id) do update
        set code       = excluded.code,
            rotated_at = excluded.rotated_at,
            rotated_by = excluded.rotated_by
    returning code into c;
    return c;
end;
$function$;

-- 5. THE DOOR. Same name, same three parameters, same names, same defaults, same
--    grants: the shipped app calls join_company(target_company_id, member_name,
--    requested_role_in) and keeps working. What changed is what the first
--    argument MEANS. It used to be the company's id; it is now the team code, and
--    a company id matches no code, so it is refused with the same words as any
--    other wrong value. Everything else the old body did is still done, in the
--    same order: not for somebody already in a business, not for somebody the
--    owner removed, the plan's seat cap (failing closed), always CREW.
--    Every table is schema-qualified and pg_temp is last on the search path, so a
--    caller cannot shadow a table with a temp table of their own.
create or replace function public.join_company(
    target_company_id uuid,
    member_name text,
    requested_role_in text default ''::text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
    joining_company uuid;
    seat_cap int;
    seats_used int;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to join a business.';
    end if;

    -- What arrives in target_company_id is the TEAM CODE (the parameter keeps its
    -- old name so the installed app still binds). A company id is looked up as a
    -- code, finds nothing, and is refused like any wrong value: nothing here
    -- tells a caller whether a given uuid is a company.
    select j.company_id into joining_company
      from public.company_join_codes j
     where j.code = target_company_id;
    if joining_company is null then
        raise exception 'That team code is not valid, or the owner has replaced it. Ask the owner for the current one.';
    end if;

    -- Somebody who already has a business must be moved by an owner, never by
    -- themselves.
    if exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.company_id is not null) then
        raise exception 'You already belong to a business. Ask an owner to move you.';
    end if;

    -- A removal is remembered, and it blocks the return trip. The owner lifts it
    -- deliberately with allow_rejoin.
    if exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.removed_from_company_id = joining_company) then
        raise exception 'You no longer have access to this business. Ask the owner to add you back.';
    end if;

    select case lower(coalesce(c.subscription_plan, ''))
             when 'solo' then 1
             when 'crew' then 6
             when 'pro'  then null   -- unlimited logins is what Pro is sold as
             else 1                  -- unknown or blank plan: tightest cap, never none
           end
      into seat_cap
      from public.companies c where c.id = joining_company;

    if not found then
        raise exception 'That team code is not valid, or the owner has replaced it. Ask the owner for the current one.';
    end if;

    if seat_cap is not null then
        select count(*) into seats_used
          from public.profiles p
         where p.company_id = joining_company and p.id <> auth.uid();
        if seats_used >= seat_cap then
            raise exception 'Your plan is full — upgrade to add more crew.';
        end if;
    end if;

    insert into public.profiles (id, company_id, full_name, role, requested_role)
    values (auth.uid(), joining_company,
            coalesce(nullif(trim(member_name), ''), ''),
            -- Always the lowest role, whatever they asked for.
            'CREW',
            coalesce(nullif(requested_role_in, ''), ''))
    on conflict (id) do update
        set company_id     = excluded.company_id,
            full_name      = coalesce(nullif(excluded.full_name, ''), public.profiles.full_name),
            role           = 'CREW',
            requested_role = excluded.requested_role;
end;
$function$;

-- 6. WHO MAY CALL WHAT. New functions start with the platform's default grants,
--    which include the anonymous role; take that away, then give signed-in users
--    the door and nothing more. join_company keeps the grants it already has
--    (create or replace does not touch them).
revoke all on function public.crew_join_code()            from public, anon;
revoke all on function public.crew_join_code_for_invite() from public, anon;
revoke all on function public.rotate_join_code()          from public, anon;
grant execute on function public.crew_join_code()            to authenticated;
grant execute on function public.crew_join_code_for_invite() to authenticated;
grant execute on function public.rotate_join_code()          to authenticated;

-- ==== THE CHANGE: END ====

-- Refuses to commit (the exception aborts the transaction) unless the change is
-- what it should be.
do $check$
begin
    if to_regclass('public.company_join_codes') is null then
        raise exception 'company_join_codes was not created; nothing committed';
    end if;
    if has_table_privilege('anon', 'public.company_join_codes', 'select,insert,update,delete')
       or has_table_privilege('authenticated', 'public.company_join_codes', 'select,insert,update,delete') then
        raise exception 'a client role can reach company_join_codes; nothing committed';
    end if;
    if (select count(*) from pg_proc
         where pronamespace = 'public'::regnamespace
           and proname in ('crew_join_code', 'crew_join_code_for_invite', 'rotate_join_code')) <> 3 then
        raise exception 'the three new functions are not all there; nothing committed';
    end if;
    if position('company_join_codes' in (select prosrc from pg_proc
         where proname = 'join_company' and pronamespace = 'public'::regnamespace)) = 0 then
        raise exception 'join_company does not read the team code; nothing committed';
    end if;
end
$check$;

commit;
PART 2 ENDS */

-- =============================================================================
-- PART 3 -- REVERSE.  Same way: delete "/* PART 3 BEGINS" and "PART 3 ENDS */",
-- run alone, put them back. Re-opens the hole. Deletes no data.
-- =============================================================================
/* PART 3 BEGINS
begin;

-- 1. The deployed join_company, byte for byte (md5 7283468b880d459cb46fe1036405eee3, the body
--    recorded in supabase/dev/fingerprint-prod.txt and supabase_join_company_guard.sql).
create or replace function public.join_company(
    target_company_id uuid,
    member_name text,
    requested_role_in text default ''::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    seat_cap int;
    seats_used int;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to join a business.';
    end if;

    -- The company id is an invite code, not proof of anything. Somebody who
    -- already has a business must be moved by an owner, never by themselves.
    if exists (select 1 from profiles
                where id = auth.uid() and company_id is not null) then
        raise exception 'You already belong to a business. Ask an owner to move you.';
    end if;

    -- A removal is remembered, and it blocks the return trip. The owner lifts
    -- it deliberately with allow_rejoin.
    if exists (select 1 from profiles
                where id = auth.uid() and removed_from_company_id = target_company_id) then
        raise exception 'You no longer have access to this business. Ask the owner to add you back.';
    end if;

    select case lower(coalesce(subscription_plan, ''))
             when 'solo' then 1
             when 'crew' then 6
             when 'pro'  then null   -- unlimited logins is what Pro is sold as
             else 1                  -- unknown or blank plan: tightest cap, never none
           end
      into seat_cap
      from companies where id = target_company_id;

    if not found then
        raise exception 'That business code is not valid.';
    end if;

    if seat_cap is not null then
        select count(*) into seats_used
          from profiles
         where company_id = target_company_id and id <> auth.uid();
        if seats_used >= seat_cap then
            raise exception 'Your plan is full — upgrade to add more crew.';
        end if;
    end if;

    insert into profiles (id, company_id, full_name, role, requested_role)
    values (auth.uid(), target_company_id,
            coalesce(nullif(trim(member_name), ''), ''),
            -- Always the lowest role, whatever they asked for.
            'CREW',
            coalesce(nullif(requested_role_in, ''), ''))
    on conflict (id) do update
        set company_id     = excluded.company_id,
            full_name      = coalesce(nullif(excluded.full_name, ''), profiles.full_name),
            role           = 'CREW',
            requested_role = excluded.requested_role;
end;
$function$;

-- 2. The three functions this change added. They hold no data.
drop function if exists public.crew_join_code();
drop function if exists public.crew_join_code_for_invite();
drop function if exists public.rotate_join_code();

-- 3. company_join_codes is left in place: nothing reads it once join_company is
--    back, and it holds only codes this change created. To remove it as well
--    (and lose those codes), run the next line by hand:
-- drop table public.company_join_codes;

-- Refuses to commit unless the original body is back.
do $check$
begin
    if (select md5(prosrc) from pg_proc
         where proname = 'join_company' and pronamespace = 'public'::regnamespace)
       <> '7283468b880d459cb46fe1036405eee3' then
        raise exception 'the original join_company was not restored; nothing committed';
    end if;
end
$check$;
commit;
PART 3 ENDS */

-- supabase_r6_price_stability.sql + supabase_r6_crew_writes.sql -- PROOF,
-- one rolled-back transaction.
--
-- Run AFTER both migrations are applied, or before, as
--   begin; <supabase_r6_price_stability.sql> <supabase_r6_crew_writes.sql> <this file>
-- in one go (tests/r6-price-crew.test.mjs does exactly that, then repeats it
-- with each piece of the migrations sabotaged). Nothing survives either way.
--
-- Every subject and row is synthetic and created in here; no real person,
-- job or company is read or written. Subjects are asserted by the PROPERTY
-- each check depends on first (rows 0x), so a changed role table reads as
-- "fixture drifted", never as a pass or a breach. Every refusal has a
-- positive control in the same run that proves the path itself works:
--   * crew's write of accepted_total is ignored -- beside crew's locate note
--     landing in the SAME call;
--   * crew's line-item push writes nothing -- beside a manager's push through
--     the SAME door writing the new quantity;
--   * a manager's tombstone of a hand-typed line is refused -- beside the
--     manager's tombstone of a generated line going through, and the owner's
--     tombstone of the hand-typed line going through;
--   * a held identity edit leaves the clock alone -- beside a real edit by
--     the same caller moving it;
--   * crew's office-column writes are dropped -- beside crew's field work,
--     crew's COMPLETED, a foreman's duration and a manager's note landing;
--   * crew's date and assignee are dropped -- beside a foreman's landing;
--   * crew's direct insert of a line is refused -- beside a manager's;
--   * a two-statement disguise of a hand-typed line is held -- beside an
--     edited takeoff line handed back to the takeoff and replaced;
--   * an older signature does not re-stamp over an approval -- beside a
--     later one that does (16/17);
--   * a change order cannot be unmarked, nor marked by crew -- beside the
--     approval and the signature marking the orders they covered, an order
--     added afterwards staying unmarked, and a phone's own mark landing.
-- "Refused" is scored by SQLSTATE, "allowed" by affected rows, and every
-- write is read back by the office afterwards, because no error is not proof.
--
-- Output: one row per check, PASS or FAIL, and a SUMMARY row last. Anything
-- but "N/N" is a finding.
begin;
set local lock_timeout = '5s';

create temp table r(n serial, k text, got text, want text);
grant all on r to authenticated, anon, service_role;
grant usage on sequence r_n_seq to authenticated, anon, service_role;

-- A signed-in caller through the API: their JWT and the authenticated role
-- (RLS applies). One scalar back.
create function pg_temp.p(label text, uid uuid, q text, want text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want) values (label,v,want);
end $fn$;

-- The same, run for effect: the real affected-row count.
create function pg_temp.x(label text, uid uuid, q text, want text) returns void language plpgsql as $fn$
declare c int; v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin execute q; get diagnostics c = row_count; v := 'rows=' || c;
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want) values (label,v,want);
end $fn$;

-- A caller's IDENTITY without their role: the triggers judge them by their
-- JWT, but RLS does not stand in the way. How a trigger-level hold is tested
-- for a caller whose RLS would stop the row being reached at all.
create function pg_temp.c(label text, uid uuid, q text, want text) returns void language plpgsql as $fn$
declare c int; v text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub',uid,'role','authenticated')::text, true);
  begin execute q; get diagnostics c = row_count; v := 'rows=' || c;
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want) values (label,v,want);
end $fn$;

-- The quote-view function: the service role, run for effect.
create function pg_temp.v(label text, q text, want text) returns void language plpgsql as $fn$
declare c int; v text;
begin
  perform set_config('request.jwt.claims', json_build_object('role','service_role')::text, true);
  execute 'set local role service_role';
  begin execute q; get diagnostics c = row_count; v := 'rows=' || c;
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  execute 'reset role';
  perform set_config('request.jwt.claims','',true);
  insert into r(k,got,want) values (label,v,want);
end $fn$;

-- The office reading it back (a direct connection: no JWT, no RLS).
create function pg_temp.s(label text, q text, want text) returns void language plpgsql as $fn$
declare v text;
begin
  perform set_config('request.jwt.claims','',true);
  begin execute q into v; v := coalesce(v,'NULL');
  exception when others then v := 'ERR ' || sqlstate || ': ' || left(sqlerrm,150); end;
  insert into r(k,got,want) values (label,v,want);
end $fn$;

do $body$
declare
  SC    uuid := 'c6000001-0000-4000-8000-000000000001';
  uOWN  uuid := 'c6100001-0000-4000-8000-000000000001';
  uMGR  uuid := 'c6100002-0000-4000-8000-000000000002';
  uCRW  uuid := 'c6100003-0000-4000-8000-000000000003';
  uFOR  uuid := 'c6100004-0000-4000-8000-000000000004';
  uACC  uuid := 'c6100005-0000-4000-8000-000000000005';
  eCRW  uuid := 'c6200003-0000-4000-8000-000000000003';  -- the crew login's crew record
  jS    uuid := 'c6300001-0000-4000-8000-000000000001';  -- signed on the phone
  jQ    uuid := 'c6300002-0000-4000-8000-000000000002';  -- approved online (new quote-view)
  jQ2   uuid := 'c6300003-0000-4000-8000-000000000003';  -- approved online (old quote-view)
  jQ3   uuid := 'c6300004-0000-4000-8000-000000000004';  -- the owner tries to approve it
  jW    uuid := 'c6300005-0000-4000-8000-000000000005';  -- crew write target
  jC1   uuid := 'c6300006-0000-4000-8000-000000000006';  -- clock: crew identity, held name
  jC2   uuid := 'c6300007-0000-4000-8000-000000000007';  -- clock: office note (control)
  jC3   uuid := 'c6300008-0000-4000-8000-000000000008';  -- clock: accepted_total only
  jC4   uuid := 'c6300009-0000-4000-8000-000000000009';  -- clock: crew identity, real edit (control)
  jC5   uuid := 'c630000a-0000-4000-8000-00000000000a';  -- clock: accountant, held name
  jC6   uuid := 'c630000b-0000-4000-8000-00000000000b';  -- clock: accountant, real edit (control)
  jL    uuid := 'c630000c-0000-4000-8000-00000000000c';  -- line items
  jJ    uuid := 'c630000d-0000-4000-8000-00000000000d';  -- a job the manager tries to delete
  rL    uuid := 'c6400001-0000-4000-8000-000000000001';
  rL2   uuid := 'c6400002-0000-4000-8000-000000000002';
  liAuto   uuid := 'c6500001-0000-4000-8000-000000000001';  -- generated, LINE_POST
  liAuto2  uuid := 'c6500002-0000-4000-8000-000000000002';  -- generated, PANEL (crew tries)
  liEdited uuid := 'c6500003-0000-4000-8000-000000000003';  -- a person edited it
  liHand   uuid := 'c6500004-0000-4000-8000-000000000004';  -- hand-typed extra
  liHand2  uuid := 'c6500005-0000-4000-8000-000000000005';  -- hand-typed extra (owner deletes)
  liHand3  uuid := 'c6500006-0000-4000-8000-000000000006';  -- hand-typed extra (disguised)
  liCrew   uuid := 'c6500007-0000-4000-8000-000000000007';  -- generated, CONCRETE_BAG 3
  liNew    uuid := 'c6500008-0000-4000-8000-000000000008';  -- never existed
  liHand4  uuid := 'c6500009-0000-4000-8000-000000000009';  -- hand-typed extra (two-statement disguise)
  liMgr    uuid := 'c650000a-0000-4000-8000-00000000000a';  -- a manager inserts it (control)
  liCrw1   uuid := 'c650000b-0000-4000-8000-00000000000b';  -- a crew login inserts it
  liCrw2   uuid := 'c650000c-0000-4000-8000-00000000000c';  -- a crew login inserts it, priced role
  jQ4   uuid := 'c630000e-0000-4000-8000-00000000000e';  -- approved online, then an older signature syncs
  jCO   uuid := 'c630000f-0000-4000-8000-00000000000f';  -- change orders across an online approval
  jF    uuid := 'c6300010-0000-4000-8000-000000000010';  -- a foreman reschedules and reassigns
  eX    uuid := 'c6200004-0000-4000-8000-000000000004';  -- another crew record, to reassign to
  coS   uuid := 'c6600001-0000-4000-8000-000000000001';  -- unsigned order on jS when it is signed
  coA   uuid := 'c6600002-0000-4000-8000-000000000002';  -- unsigned order on jCO when it is approved
  coC   uuid := 'c6600003-0000-4000-8000-000000000003';  -- added to jCO after the approval; crew tries to mark it
  coE   uuid := 'c6600005-0000-4000-8000-000000000005';  -- the owner's phone marks it (control)
  OLD_CLOCK constant timestamptz := '2026-01-01 00:00:00+00';
  held text := 'ERR P0001: Deleting needs the delete permission';
begin
  perform set_config('request.jwt.claims','',true);

  -- ======================================================================
  -- Fixtures
  -- ======================================================================
  insert into auth.users(id,email) values
    (uOWN,'r6-own@probe.invalid'),(uMGR,'r6-mgr@probe.invalid'),(uCRW,'r6-crw@probe.invalid'),
    (uFOR,'r6-for@probe.invalid'),(uACC,'r6-acc@probe.invalid');
  insert into companies(id,name,subscription_status,subscription_plan,suspended,trial_ends_at,
                        admin_notes,leads_token,stripe_customer_id,invited_email,suspended_reason) values
    (SC,'PROBE-R6-PRICE-CREW','active','pro',false,now()+interval '30 days','',gen_random_uuid(),'cus_R6PC','','');
  insert into profiles(id,company_id,full_name,role,is_platform_admin,permission_overrides) values
    (uOWN,SC,'R6 Owner'     ,'OWNER'     ,false,''),
    (uMGR,SC,'R6 Manager'   ,'MANAGER'   ,false,''),
    (uCRW,SC,'R6 Crew'      ,'CREW'      ,false,''),
    (uFOR,SC,'R6 Foreman'   ,'FOREMAN'   ,false,''),
    (uACC,SC,'R6 Accountant','ACCOUNTANT',false,'');
  -- The crew login is a crew record, and the jobs it writes to are its own.
  -- Nothing here depends on that today; once supabase_crew_job_scope.sql is
  -- applied (crew see and write only the jobs they are on) it is what keeps
  -- every crew check below meaningful instead of refused for the wrong reason.
  insert into employees(id,company_id,name,sync_id,hourly_rate,pay_type,profile_id,is_active) values
    (eCRW,SC,'R6 Crew',eCRW,21.00,'HOURLY',uCRW,true),
    (eX  ,SC,'R6 Other crew',eX,19.00,'HOURLY',null,true);

  -- Inserted by a direct connection, so the holds let every value through
  -- and the clocks start where they are told to (the edit clock is a
  -- BEFORE UPDATE trigger only). An old clock is the only way to see a bump
  -- at all: now() is fixed for the whole transaction.
  insert into jobs(id,company_id,sync_id,customer_name,address,phone,email,status,contract_total,
                   quote_token,is_test_fixture,notes,hoa_name,permit_number,priced_by,
                   pricing_engine_version,estimated_duration_hours,waste_percent,updated_at) values
    (jS ,SC,jS ,'R6 SIGNED'  ,'1 Probe Way','555-0101','',  'ACCEPTED',13410,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jQ ,SC,jQ ,'R6 QUOTE'   ,'2 Probe Way','555-0102','',  'SENT'    , 5000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jQ2,SC,jQ2,'R6 QUOTE 2' ,'3 Probe Way','555-0103','',  'SENT'    , 5000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jQ3,SC,jQ3,'R6 QUOTE 3' ,'4 Probe Way','555-0104','',  'SENT'    , 5000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jW ,SC,jW ,'CS NAME'    ,'5 Probe Way','555-0105','',  'ACCEPTED', 7000,gen_random_uuid(),false,
         'OFFICE NOTE','OFFICE HOA','P-123','APP','2026.09.1',4,10,OLD_CLOCK),
    (jC1,SC,jC1,'KEEP ME'    ,'6 Probe Way','555-0106','',  'ACCEPTED', 1000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jC2,SC,jC2,'R6 CLOCK 2' ,'7 Probe Way','555-0107','',  'ACCEPTED', 1000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jC3,SC,jC3,'R6 CLOCK 3' ,'8 Probe Way','555-0108','',  'ACCEPTED', 1000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jC4,SC,jC4,'R6 CLOCK 4' ,'9 Probe Way','555-0109','',  'ACCEPTED', 1000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jC5,SC,jC5,'KEEP ME TOO','10 Probe Way','555-0110','', 'ACCEPTED', 1000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jC6,SC,jC6,'R6 CLOCK 6' ,'11 Probe Way','555-0111','', 'ACCEPTED', 1000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jL ,SC,jL ,'R6 LINES'   ,'12 Probe Way','555-0112','', 'ACCEPTED', 3000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jJ ,SC,jJ ,'R6 DELETE'  ,'13 Probe Way','555-0113','', 'DRAFT'   ,  900,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jQ4,SC,jQ4,'R6 QUOTE 4' ,'14 Probe Way','555-0114','', 'SENT'    , 5000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jCO,SC,jCO,'R6 ORDERS'  ,'15 Probe Way','555-0115','', 'SENT'    , 5000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK),
    (jF ,SC,jF ,'R6 FOREMAN' ,'16 Probe Way','555-0116','', 'ACCEPTED', 2000,gen_random_uuid(),false,'','','','','',4,10,OLD_CLOCK);

  update jobs set assigned_employee_sync_id = eCRW::text where sync_id in (jS, jW, jL, jF);
  update jobs set scheduled_date = '2030-01-01 08:00:00+00' where sync_id = jF;

  -- Unsigned change orders, present when their job is accepted. Direct
  -- connection, so the latch leaves them at the default (false).
  insert into change_orders(company_id,sync_id,job_sync_id,description,additional_cost) values
    (SC,coS,jS ,'Extra gate', 300),
    (SC,coA,jCO,'Extra 40 ft', 900);

  insert into fence_runs(company_id,sync_id,job_sync_id,label) values
    (SC,rL ,jL,'run'),
    (SC,rL2,jL,'run 2');

  insert into estimate_line_items(company_id,sync_id,job_sync_id,description,quantity,unit_price,
                                  role,auto_generated,fence_run_sync_id) values
    (SC,liAuto  ,jL,'Line post'      ,10,16.56,'LINE_POST'   ,true ,rL::text),
    (SC,liAuto2 ,jL,'Panel'          ,12,52.35,'PANEL'       ,true ,rL::text),
    (SC,liEdited,jL,'End post'       , 4,21.00,'END_POST'    ,false,rL::text),
    (SC,liHand  ,jL,'Haul-away'      , 1,150  ,'NONE'        ,false,null),
    (SC,liHand2 ,jL,'Permit run'     , 1, 80  ,'NONE'        ,false,null),
    (SC,liHand3 ,jL,'Gate hardware'  , 1, 40  ,'NONE'        ,false,null),
    (SC,liHand4 ,jL,'Tip jar'        , 1, 20  ,'NONE'        ,false,null),
    (SC,liCrew  ,jL,'Concrete bag'   , 3, 4.75,'CONCRETE_BAG',true ,rL::text);

  -- ======================================================================
  -- 0x  Subjects, by property
  -- ======================================================================
  perform pg_temp.p('00 OWNER      DELETE_RECORDS/EDIT_JOBS/SEE_MONEY', uOWN,
    'select has_permission(''DELETE_RECORDS'')::text||''/''||has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''SEE_MONEY'')::text',
    'true/true/true');
  perform pg_temp.p('01 MANAGER    DELETE_RECORDS/EDIT_JOBS/SEE_MONEY', uMGR,
    'select has_permission(''DELETE_RECORDS'')::text||''/''||has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''SEE_MONEY'')::text',
    'false/true/true');
  perform pg_temp.p('02 CREW       RECORD_FIELD_WORK/EDIT_JOBS/SEE_MONEY/SCHEDULE_AND_ASSIGN', uCRW,
    'select has_permission(''RECORD_FIELD_WORK'')::text||''/''||has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''SEE_MONEY'')::text||''/''||has_permission(''SCHEDULE_AND_ASSIGN'')::text',
    'true/false/false/false');
  perform pg_temp.p('03 FOREMAN    EDIT_JOBS/SCHEDULE_AND_ASSIGN/SEE_MONEY', uFOR,
    'select has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''SCHEDULE_AND_ASSIGN'')::text||''/''||has_permission(''SEE_MONEY'')::text',
    'false/true/false');
  perform pg_temp.p('04 ACCOUNTANT EDIT_JOBS/SEE_MONEY', uACC,
    'select has_permission(''EDIT_JOBS'')::text||''/''||has_permission(''SEE_MONEY'')::text',
    'false/true');

  -- ======================================================================
  -- 1x  accepted_total: what the customer agreed to, and who can touch it
  -- ======================================================================
  perform pg_temp.s('10 accepted_total is a money column',
    'select (''accepted_total'' = any (public.job_money_columns()))::text', 'true');
  perform pg_temp.p('11 CREW cannot read accepted_total (jobs_crew has no such column)', uCRW,
    format('select accepted_total::text from jobs_crew where sync_id = %L', jS), 'ERR 42703');
  perform pg_temp.p('12   control: CREW reads the same job through jobs_crew', uCRW,
    format('select customer_name from jobs_crew where sync_id = %L', jS), 'R6 SIGNED');
  perform pg_temp.p('13 OWNER reads accepted_total: not anchored before signing', uOWN,
    format('select accepted_total::text from jobs where sync_id = %L', jS), 'NULL');

  -- The phone's captureSignature: signed_at and signed_contract_total in one
  -- update, accepted_total never sent.
  perform pg_temp.x('14 OWNER signs on the phone', uOWN,
    format('update jobs set signed_at = now(), signed_contract_total = 9710 where sync_id = %L', jS), 'rows=1');
  perform pg_temp.s('15   the signature stamped the price it recorded',
    format('select accepted_total::text from jobs where sync_id = %L', jS), '9710');
  perform pg_temp.x('16 OWNER re-signs at a new figure', uOWN,
    format('update jobs set signed_at = now() + interval ''1 minute'', signed_contract_total = 9900 where sync_id = %L', jS), 'rows=1');
  perform pg_temp.s('17   a later agreement re-stamps',
    format('select accepted_total::text from jobs where sync_id = %L', jS), '9900');
  -- An old build still pushing its live recompute after acceptance.
  perform pg_temp.x('18 OWNER phone pushes a drifted contract_total', uOWN,
    format('update jobs set contract_total = 13410 where sync_id = %L', jS), 'rows=1');
  perform pg_temp.s('19   the accepted price does not follow it',
    format('select accepted_total::text || ''/'' || contract_total::text from jobs where sync_id = %L', jS), '9900/13410');

  perform pg_temp.p('20 CREW writes accepted_total and a locate note in one crew_save_job', uCRW,
    format('select crew_save_job(%L::jsonb)::text',
           json_build_object('sync_id', jS, 'accepted_total', 1, 'locate_notes', 'crew note')), 'true');
  perform pg_temp.s('21   the price is untouched and the note landed (same call)',
    format('select accepted_total::text || ''|'' || locate_notes from jobs where sync_id = %L', jS), '9900|crew note');
  -- The shield underneath the allowlist: hold_money_columns() reverts it for
  -- any caller without SEE_MONEY, whatever door the write came through.
  perform pg_temp.c('22 CREW identity writes accepted_total straight to the table', uCRW,
    format('update jobs set accepted_total = 1 where sync_id = %L', jS), 'rows=1');
  perform pg_temp.s('23   held by hold_money_columns (a money column)',
    format('select accepted_total::text from jobs where sync_id = %L', jS), '9900');

  -- quote-view approving: service role, one UPDATE carrying the page total.
  perform pg_temp.v('24 quote-view approves and records the figure the page showed',
    format('update jobs set quote_approved_at = now(), quote_approved_name = ''Probe Buyer'', '
           'accepted_total = 5010, status = ''ACCEPTED'' where sync_id = %L', jQ), 'rows=1');
  perform pg_temp.s('25   recorded with the approval',
    format('select accepted_total::text || ''|'' || (quote_approved_at is not null)::text from jobs where sync_id = %L', jQ),
    '5010|true');
  -- An approval that carries no figure (quote-view from before this change)
  -- anchors nothing: the trigger does not guess one from contract_total.
  perform pg_temp.v('26 an approval with no figure',
    format('update jobs set quote_approved_at = now(), quote_approved_name = ''Probe Buyer'' where sync_id = %L', jQ2),
    'rows=1');
  perform pg_temp.s('27   leaves the price unanchored rather than guessing',
    format('select coalesce(accepted_total::text, ''NULL'') || ''|'' || (quote_approved_at is not null)::text from jobs where sync_id = %L', jQ2),
    'NULL|true');
  -- The premise of not stamping approvals in the trigger: nobody but the
  -- service role can set quote_approved_at in the first place.
  perform pg_temp.x('28 OWNER tries to stamp an approval', uOWN,
    format('update jobs set quote_approved_at = now() where sync_id = %L', jQ3), 'rows=1');
  perform pg_temp.s('29   held: only quote-view approves',
    format('select (quote_approved_at is null)::text from jobs where sync_id = %L', jQ3), 'true');

  -- A signature taken offline BEFORE an online approval, synced after it,
  -- is the older agreement: it must not re-stamp over the approval's figure.
  -- (Checks 16/17 are the control: a LATER signature still re-stamps.)
  perform pg_temp.v('1a quote-view approves online at the page total',
    format('update jobs set quote_approved_at = now(), quote_approved_name = ''Probe Buyer'', '
           'accepted_total = 6000, status = ''ACCEPTED'' where sync_id = %L', jQ4), 'rows=1');
  perform pg_temp.x('1b OWNER phone syncs a signature taken an hour before the approval', uOWN,
    format('update jobs set signed_at = now() - interval ''1 hour'', signed_contract_total = 5500 where sync_id = %L', jQ4),
    'rows=1');
  perform pg_temp.s('1c   the approval''s figure stands',
    format('select accepted_total::text from jobs where sync_id = %L', jQ4), '6000');

  -- Quiet: a stamp is bookkeeping, not an edit that beats offline work.
  perform pg_temp.s('30 setting accepted_total alone',
    format('with u as (update jobs set accepted_total = 1234 where sync_id = %L returning updated_at) '
           'select (updated_at = %L::timestamptz)::text from u', jC3, OLD_CLOCK), 'true');
  perform pg_temp.s('31   control: an office note on an identical job moves the clock',
    format('with u as (update jobs set notes = ''office'' where sync_id = %L returning updated_at) '
           'select (updated_at = %L::timestamptz)::text from u', jC2, OLD_CLOCK), 'false');

  -- ======================================================================
  -- 3a-3j  which change orders an accepted price already contains
  -- ======================================================================
  -- coS was unsigned on jS when check 14 signed it: inside the signed figure.
  perform pg_temp.s('3a the signature marked the unsigned order inside its price',
    format('select in_accepted_total::text from change_orders where sync_id = %L', coS), 'true');
  perform pg_temp.v('3b quote-view approves the job with an unsigned order on it',
    format('update jobs set quote_approved_at = now(), quote_approved_name = ''Probe Buyer'', '
           'accepted_total = 5900, status = ''ACCEPTED'' where sync_id = %L', jCO), 'rows=1');
  perform pg_temp.s('3c   the approval marked it',
    format('select in_accepted_total::text from change_orders where sync_id = %L', coA), 'true');
  -- Extra work agreed after the approval is not inside it.
  insert into change_orders(company_id,sync_id,job_sync_id,description,additional_cost)
    values (SC,coC,jCO,'Extra after approval', 455);
  perform pg_temp.s('3d   control: an order added afterwards is not marked',
    format('select in_accepted_total::text from change_orders where sync_id = %L', coC), 'false');
  perform pg_temp.x('3e OWNER phone pushes an older copy of the order, unmarked', uOWN,
    format('update change_orders set in_accepted_total = false where sync_id = %L', coA), 'rows=1');
  perform pg_temp.s('3f   latched: still marked',
    format('select in_accepted_total::text from change_orders where sync_id = %L', coA), 'true');
  -- An UPDATE, not an insert: a crew identity cannot insert a change order
  -- at all today (hold_money_columns' insert branch fails on to_jsonb('')
  -- for any caller it does not trust -- a separate, older fault).
  perform pg_temp.c('3g CREW identity marks an order as inside the price', uCRW,
    format('update change_orders set in_accepted_total = true where sync_id = %L', coC), 'rows=1');
  perform pg_temp.s('3h   held: a caller who cannot see money cannot mark it',
    format('select in_accepted_total::text from change_orders where sync_id = %L', coC), 'false');
  perform pg_temp.x('3i   control: OWNER phone pushes an order it marked at a signature', uOWN,
    format('insert into change_orders(company_id,sync_id,job_sync_id,description,additional_cost,in_accepted_total) '
           'values (%L,%L,%L,''marked on the phone'',120,true)', SC, coE, jCO), 'rows=1');
  perform pg_temp.s('3j   control: the phone''s mark landed',
    format('select in_accepted_total::text from change_orders where sync_id = %L', coE), 'true');

  -- ======================================================================
  -- 4x  crew phones no longer write estimate lines
  -- ======================================================================
  perform pg_temp.p('40 CREW pushes CONCRETE_BAG 85 through crew_push_line_items', uCRW,
    format('select crew_push_line_items(%L::jsonb)::text', json_build_array(json_build_object(
      'sync_id', liCrew, 'job_sync_id', jL, 'description', 'Concrete bag', 'quantity', 85,
      'role', 'CONCRETE_BAG', 'auto_generated', true, 'fence_run_sync_id', rL))), '0');
  perform pg_temp.s('41   the office quantity stands',
    format('select quantity::text from estimate_line_items where sync_id = %L', liCrew), '3');
  perform pg_temp.p('42 CREW pushes a line the cloud has never seen', uCRW,
    format('select crew_push_line_items(%L::jsonb)::text', json_build_array(json_build_object(
      'sync_id', liNew, 'job_sync_id', jL, 'description', 'Crew extra', 'quantity', 5))), '0');
  perform pg_temp.s('43   nothing was inserted',
    format('select count(*)::text from estimate_line_items where sync_id = %L', liNew), '0');
  perform pg_temp.p('44   control: MANAGER through the SAME door', uMGR,
    format('select crew_push_line_items(%L::jsonb)::text', json_build_array(json_build_object(
      'sync_id', liCrew, 'job_sync_id', jL, 'description', 'Concrete bag', 'quantity', 85,
      'role', 'CONCRETE_BAG', 'auto_generated', true, 'fence_run_sync_id', rL))), '1');
  perform pg_temp.s('45   control: and the quantity moved',
    format('select quantity::text from estimate_line_items where sync_id = %L', liCrew), '85');
  -- The table itself, not the door: an insert needs no SELECT, so the crew
  -- read policy never stood in the way of one.
  perform pg_temp.x('46 CREW inserts a line straight into the table', uCRW,
    format('insert into estimate_line_items(company_id,sync_id,job_sync_id,description,quantity) '
           'values (%L,%L,%L,''crew extra'',999)', SC, liCrw1, jL), 'ERR 42501');
  perform pg_temp.x('47 CREW inserts a priced role line straight into the table', uCRW,
    format('insert into estimate_line_items(company_id,sync_id,job_sync_id,description,quantity,role,auto_generated,fence_run_sync_id) '
           'values (%L,%L,%L,''Line post'',500,''LINE_POST'',true,%L)', SC, liCrw2, jL, rL), 'ERR 42501');
  perform pg_temp.x('48   control: MANAGER inserts a line the same way', uMGR,
    format('insert into estimate_line_items(company_id,sync_id,job_sync_id,description,quantity) '
           'values (%L,%L,%L,''manager extra'',2)', SC, liMgr, jL), 'rows=1');
  perform pg_temp.s('49   office read-back: crew lines absent, the manager''s present',
    format('select (select count(*) from estimate_line_items where sync_id in (%L,%L))::text || ''|'' || '
           '(select count(*) from estimate_line_items where sync_id = %L)::text', liCrw1, liCrw2, liMgr), '0|1');

  -- ======================================================================
  -- 5x  a takeoff replacing its own lines is an estimate edit
  -- ======================================================================
  perform pg_temp.x('50 MANAGER tombstones a generated takeoff line', uMGR,
    format('update estimate_line_items set deleted_at = now() where sync_id = %L', liAuto), 'rows=1');
  perform pg_temp.x('51 MANAGER tombstones a hand-typed extra', uMGR,
    format('update estimate_line_items set deleted_at = now() where sync_id = %L', liHand), held);
  perform pg_temp.x('52 MANAGER tombstones a line a person edited', uMGR,
    format('update estimate_line_items set deleted_at = now() where sync_id = %L', liEdited), held);
  perform pg_temp.x('53 MANAGER dresses a hand-typed extra as generated in the same statement', uMGR,
    format('update estimate_line_items set auto_generated = true, role = ''LINE_POST'', '
           'fence_run_sync_id = %L, deleted_at = now() where sync_id = %L', rL, liHand3), held);
  perform pg_temp.x('54 MANAGER tombstones a job (unchanged: still refused)', uMGR,
    format('update jobs set deleted_at = now() where sync_id = %L', jJ), held);
  perform pg_temp.x('55 MANAGER tombstones a fence run (unchanged: still refused)', uMGR,
    format('update fence_runs set deleted_at = now() where sync_id = %L', rL2), held);
  perform pg_temp.x('56   control: OWNER tombstones the hand-typed extra', uOWN,
    format('update estimate_line_items set deleted_at = now() where sync_id = %L', liHand2), 'rows=1');
  perform pg_temp.x('57 CREW tombstones a generated line through the table', uCRW,
    format('update estimate_line_items set deleted_at = now() where sync_id = %L', liAuto2), 'rows=0');
  perform pg_temp.s('58   office read-back: which lines are tombstoned',
    format('select string_agg(description, '','' order by description) from estimate_line_items '
           'where job_sync_id = %L and deleted_at is not null', jL), 'Line post,Permit run');
  -- The same disguise as 53, in two statements. The first goes through (it
  -- is an ordinary edit), but the role and run stay as they were, so the
  -- tombstone is still judged on a hand-typed line.
  perform pg_temp.x('5a MANAGER gives a hand-typed extra a role and a run', uMGR,
    format('update estimate_line_items set auto_generated = true, role = ''LINE_POST'', '
           'fence_run_sync_id = %L where sync_id = %L', rL, liHand4), 'rows=1');
  perform pg_temp.s('5b   role and run held',
    format('select coalesce(role,''NULL'') || ''|'' || coalesce(fence_run_sync_id,''NULL'') '
           'from estimate_line_items where sync_id = %L', liHand4), 'NONE|NULL');
  perform pg_temp.x('5c MANAGER then tombstones it', uMGR,
    format('update estimate_line_items set deleted_at = now() where sync_id = %L', liHand4), held);
  -- The app's "Use suggested": a takeoff line a person edited is handed back
  -- to the takeoff, which may then replace it.
  perform pg_temp.x('5d   control: MANAGER hands an edited takeoff line back to the takeoff', uMGR,
    format('update estimate_line_items set auto_generated = true where sync_id = %L', liEdited), 'rows=1');
  perform pg_temp.x('5e   control: and a regenerate may now replace it', uMGR,
    format('update estimate_line_items set deleted_at = now() where sync_id = %L', liEdited), 'rows=1');

  -- ======================================================================
  -- 6x  crew_save_job writes field work only
  -- ======================================================================
  perform pg_temp.p('60 CREW sends a stale whole row plus field work', uCRW,
    format('select crew_save_job(%L::jsonb)::text', json_build_object(
      'sync_id', jW, 'notes', '', 'hoa_name', '', 'permit_number', '', 'priced_by', '',
      'pricing_engine_version', '', 'customer_name', 'CREW NAME', 'status', 'DRAFT',
      'estimated_duration_hours', 93.33, 'waste_percent', 99,
      'locate_notes', 'gas east', 'blocked_reason', 'dog')), 'true');
  perform pg_temp.s('61   office columns untouched',
    format('select notes||''|''||hoa_name||''|''||permit_number||''|''||priced_by||''|''||pricing_engine_version'
           '||''|''||customer_name||''|''||status||''|''||estimated_duration_hours::text||''|''||waste_percent::text '
           'from jobs where sync_id = %L', jW),
    'OFFICE NOTE|OFFICE HOA|P-123|APP|2026.09.1|CS NAME|ACCEPTED|4|10');
  perform pg_temp.s('62   control: the field work in the same call landed',
    format('select locate_notes||''|''||blocked_reason from jobs where sync_id = %L', jW), 'gas east|dog');
  perform pg_temp.p('63   control: CREW marks it COMPLETED', uCRW,
    format('select crew_save_job(%L::jsonb)::text', json_build_object('sync_id', jW, 'status', 'COMPLETED')), 'true');
  perform pg_temp.s('64   control: COMPLETED landed',
    format('select status from jobs where sync_id = %L', jW), 'COMPLETED');
  perform pg_temp.p('65   control: FOREMAN (SCHEDULE_AND_ASSIGN) sends a duration', uFOR,
    format('select crew_save_job(%L::jsonb)::text', json_build_object('sync_id', jW, 'estimated_duration_hours', 6)), 'true');
  perform pg_temp.s('66   control: the foreman''s duration landed',
    format('select estimated_duration_hours::text from jobs where sync_id = %L', jW), '6');
  perform pg_temp.p('67   control: MANAGER (EDIT_JOBS) through the same door, unchanged', uMGR,
    format('select crew_save_job(%L::jsonb)::text', json_build_object('sync_id', jW, 'notes', 'MGR NOTE')), 'true');
  perform pg_temp.s('68   control: the manager''s note landed',
    format('select notes from jobs where sync_id = %L', jW), 'MGR NOTE');
  -- When and who: a foreman's to move, never crew's.
  perform pg_temp.p('6a CREW sends a new date and assignee', uCRW,
    format('select crew_save_job(%L::jsonb)::text', json_build_object(
      'sync_id', jF, 'scheduled_date', '2030-06-01T08:00:00+00:00', 'assigned_employee_sync_id', eX)), 'true');
  perform pg_temp.s('6b   dropped for crew',
    format('select to_char(scheduled_date at time zone ''UTC'', ''YYYY-MM-DD'') || ''|'' || assigned_employee_sync_id '
           'from jobs where sync_id = %L', jF), '2030-01-01|' || eCRW::text);
  perform pg_temp.p('6c FOREMAN (SCHEDULE_AND_ASSIGN) reschedules and reassigns', uFOR,
    format('select crew_save_job(%L::jsonb)::text', json_build_object(
      'sync_id', jF, 'scheduled_date', '2030-06-01T08:00:00+00:00', 'assigned_employee_sync_id', eX)), 'true');
  perform pg_temp.s('6d   the foreman''s date and assignee landed',
    format('select to_char(scheduled_date at time zone ''UTC'', ''YYYY-MM-DD'') || ''|'' || assigned_employee_sync_id '
           'from jobs where sync_id = %L', jF), '2030-06-01|' || eX::text);

  -- ======================================================================
  -- 7x  a held identity edit does not move the edit clock
  -- ======================================================================
  -- Through the API, as a caller RLS lets write the row but who may not
  -- edit jobs: the accountant.
  perform pg_temp.x('70 ACCOUNTANT changes the customer name', uACC,
    format('update jobs set customer_name = ''TYPED'' where sync_id = %L', jC5), 'rows=1');
  perform pg_temp.s('71   name held AND clock unmoved (identity hold runs before the clock)',
    format('select customer_name||''|''||(updated_at = %L::timestamptz)::text from jobs where sync_id = %L', OLD_CLOCK, jC5),
    'KEEP ME TOO|true');
  perform pg_temp.x('72   control: ACCOUNTANT makes a real edit', uACC,
    format('update jobs set locate_notes = ''real'' where sync_id = %L', jC6), 'rows=1');
  perform pg_temp.s('73   control: the clock moved',
    format('select (updated_at = %L::timestamptz)::text from jobs where sync_id = %L', OLD_CLOCK, jC6), 'false');
  -- The crew login's own identity (the case in the report: 4598150b).
  perform pg_temp.c('74 CREW identity changes the customer name', uCRW,
    format('update jobs set customer_name = ''CREW TYPED'' where sync_id = %L', jC1), 'rows=1');
  perform pg_temp.s('75   name held AND clock unmoved',
    format('select customer_name||''|''||(updated_at = %L::timestamptz)::text from jobs where sync_id = %L', OLD_CLOCK, jC1),
    'KEEP ME|true');
  perform pg_temp.c('76   control: CREW identity makes a real edit', uCRW,
    format('update jobs set locate_notes = ''real'' where sync_id = %L', jC4), 'rows=1');
  perform pg_temp.s('77   control: the clock moved',
    format('select (updated_at = %L::timestamptz)::text from jobs where sync_id = %L', OLD_CLOCK, jC4), 'false');

  -- ======================================================================
  -- 8x  the other migration's anchors survive (supabase_crew_job_scope.sql)
  -- ======================================================================
  perform pg_temp.s('80 crew_save_job still carries its sync_id anchor exactly once',
    $q$select count(*)::text from regexp_matches(pg_get_functiondef('public.crew_save_job(jsonb)'::regprocedure),
       'if clean->>''sync_id'' is null then\s+raise exception ''sync_id required'';\s+end if;', 'g')$q$, '1');
  -- Once that file has run, its guard sits where the anchor was; that counts.
  perform pg_temp.s('81 crew_push_line_items still carries its job-existence anchor exactly once (or its guard)',
    $q$select case when position('can_see_job' in pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure)) > 0
                   then '1'
                   else (select count(*)::text from regexp_matches(pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure),
                         'where j\.company_id = co and j\.sync_id = \(clean->>''job_sync_id''\)::uuid\s+and j\.deleted_at is null\) then', 'g'))
              end$q$, '1');
end $body$;

select n, case when ok then 'PASS' else 'FAIL' end as result, k as check_name, got, want
  from (select n, k, got, want,
               coalesce(got = want
                        or (want like 'ERR %' and got like want || '%'), false) as ok
          from r) t
union all
select 1000000, 'SUMMARY',
       'passed/total',
       (select count(*) filter (where coalesce(got = want
                                  or (want like 'ERR %' and got like want || '%'), false))::text
               || '/' || count(*)::text from r),
       (select count(*)::text || '/' || count(*)::text from r)
 order by 1;

rollback;

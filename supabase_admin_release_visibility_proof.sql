-- PROOF, not a patch. Everything here happens inside a transaction that always
-- rolls back, so it can be run against the live project as often as you like
-- and changes nothing. It proves two separate claims about
-- supabase_admin_sees_every_release.sql:
--
--   1. the platform admin can now see, and therefore promote, a limited
--      release aimed at companies he is not in;
--   2. NOBODY ELSE can see one thing more than they could before. The read
--      policy on app_releases is not touched by that patch, so step 20 below
--      asserts its text has not changed, and steps 30-41 measure what a
--      non-admin and an anonymous caller actually get back.
--
-- Run it BEFORE installing the patch as well as after. Before, step 11 records
-- that admin_releases() is absent and the steps that need it say SKIPPED,
-- while every non-admin and anon number is still measured -- those are the
-- "before" figures, and after the patch they must read identically. A number
-- in 30-41 that moves is the patch having done something it says it does not.
--
-- Every claim here is paired. A step that can only ever pass proves nothing,
-- so each block has a control that must succeed and something that must fail:
--   step 21 (admin cannot read it through the table) is the canary for the
--           whole exercise -- it goes green only while the policy is still
--           closed, and if a later change quietly opens it, this step fails;
--   step 24 (a non-admin calling admin_releases()) must be REFUSED, not
--           answered with an empty list;
--   step 20 fails outright if the policy text is edited by anyone, for any
--           reason, including a change that looks harmless.

begin;

create temp table proof(step int, what text, expected text, observed text, verdict text) on commit drop;

do $proof$
declare
  v_admin uuid; v_admin_co uuid;
  v_other uuid; v_other_co uuid;
  r_all    uuid := gen_random_uuid();
  r_theirs uuid := gen_random_uuid();
  r_mine   uuid := gen_random_uuid();
  r_future uuid := gen_random_uuid();
  v_n int; v_have_fn boolean; v_qual text;
  -- The policy exactly as supabase_release_audience_patch.sql left it, read
  -- back out of pg_policies. Written out in full deliberately: a proof that
  -- compares the policy to itself proves nothing.
  k_expected_qual constant text :=
    '(((available_from IS NULL) OR (available_from <= now())) AND ' ||
    '((audience = ''everyone''::text) OR release_visible_to_caller(id)))';
begin
  -- ---------------------------------------------------------------- fixture
  -- Picked by property and then asserted, never by name or by id: the one
  -- account carrying is_platform_admin, and somebody who is not it, in a
  -- different company. A fixture that quietly stops having the property it
  -- was chosen for is how a security proof comes back green while proving
  -- nothing.
  select id, company_id into v_admin, v_admin_co
    from profiles where is_platform_admin and company_id is not null limit 1;
  select id, company_id into v_other, v_other_co
    from profiles
   where not is_platform_admin and company_id is not null
     and company_id is distinct from v_admin_co limit 1;

  if v_admin is null or v_other is null then
    insert into proof values (1,'fixture',
      'one platform admin with a company, one non-admin in another company',
      'not found',
      'ABORT - nothing below this line means anything');
    return;
  end if;
  insert into proof values (1,'fixture assertion','the chosen accounts differ and sit in different companies',
    case when v_admin <> v_other and v_admin_co is distinct from v_other_co
         then 'yes' else 'no' end,
    case when v_admin <> v_other and v_admin_co is distinct from v_other_co
         then 'PASS' else 'ABORT' end);
  if v_admin = v_other or v_admin_co is not distinct from v_other_co then return; end if;

  select exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'admin_releases'
  ) into v_have_fn;
  insert into proof values (11,'is supabase_admin_sees_every_release.sql installed?',
    'yes, once the patch has been run', case when v_have_fn then 'yes' else 'no' end,
    case when v_have_fn then 'installed' else 'NOT INSTALLED - steps 22-24 are skipped, 20/21 and 30-41 are the before figures' end);

  -- Four releases that cover every case the console has to draw. Rolled back
  -- with everything else; the version codes are far above anything real so a
  -- half-run that somehow escaped could not shadow a genuine build.
  insert into app_releases (id, version_code, version_name, notes, download_url,
                            is_mandatory, released_at, audience, available_from)
  values (r_all,    99900101, 'ZZ PROOF everyone',                '', '', false, now(), 'everyone', null),
         (r_mine,   99900102, 'ZZ PROOF limited to the non-admin', '', '', false, now(), 'limited',  null),
         (r_theirs, 99900103, 'ZZ PROOF limited to a third party', '', '', false, now(), 'limited',  null),
         (r_future, 99900104, 'ZZ PROOF everyone, next week',      '', '', false, now(), 'everyone', now() + interval '7 days');
  insert into app_release_audience (release_id, company_id)
  values (r_mine, v_other_co), (r_theirs, v_admin_co);
  -- r_theirs names the ADMIN's company and r_mine names the non-admin's, so
  -- each caller below has one limited release they are entitled to and one
  -- they are not. Without both, "saw nothing" could just mean "saw nothing".

  -- ------------------------------------------------- the policy is untouched
  select qual into v_qual from pg_policies
   where schemaname = 'public' and tablename = 'app_releases' and policyname = 'app_releases_read';
  insert into proof values (20,'app_releases_read qual',
    'identical to what supabase_release_audience_patch.sql installed',
    coalesce(v_qual, '(no such policy)'),
    case when v_qual = k_expected_qual then 'PASS - policy not touched'
         else 'FAIL - the read policy has been edited; read it before trusting anything here' end);

  -- ------------------------------------------------------------- the admin
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_admin::text, 'role', 'authenticated')::text, true);
  insert into proof values (12,'fixture assertion','is_platform_admin() = true for the chosen admin',
    coalesce(is_platform_admin()::text,'null'),
    case when is_platform_admin() then 'PASS' else 'ABORT' end);
  if not is_platform_admin() then return; end if;

  set local role authenticated;
  select count(*) into v_n from app_releases where id = r_all;
  reset role;
  insert into proof values (19,'CONTROL: admin reads an ''everyone'' release through the table',
    '1', v_n::text, case when v_n = 1 then 'PASS' else 'ABORT - the probe cannot read the table at all' end);
  if v_n <> 1 then return; end if;

  set local role authenticated;
  select count(*) into v_n from app_releases where id = r_mine;
  reset role;
  insert into proof values (21,'CANARY: admin reads a limited release aimed at someone else, through the table',
    '0 - the policy has no admin bypass and must not grow one',
    v_n::text,
    case when v_n = 0 then 'PASS - still closed'
         else 'FAIL - the policy has been widened; the non-admin figures below are no longer safe' end);

  if v_have_fn then
    set local role authenticated;
    begin
      select count(*) into v_n from admin_releases() where id = r_mine;
      reset role;
      insert into proof values (22,'THE FIX: admin sees that same release through admin_releases()',
        '1', v_n::text,
        case when v_n = 1 then 'PASS - it can now be found, and admin_promote_release() already accepts it'
             else 'FAIL - the admin still cannot reach it' end);
    exception when others then
      reset role;
      insert into proof values (22,'THE FIX: admin sees that same release through admin_releases()',
        '1', sqlstate || ' ' || sqlerrm, 'FAIL');
    end;

    set local role authenticated;
    begin
      select count(*) into v_n from admin_releases() where id = r_future;
      reset role;
      insert into proof values (23,'admin sees a release scheduled for next week through admin_releases()',
        '1 - the console must be able to show a rollout that has not started',
        v_n::text, case when v_n = 1 then 'PASS' else 'FAIL' end);
    exception when others then
      reset role;
      insert into proof values (23,'admin sees a release scheduled for next week through admin_releases()',
        '1', sqlstate || ' ' || sqlerrm, 'FAIL');
    end;

    -- MUST FAIL. A refusal, not an empty list: an empty list is what a
    -- genuinely empty release table returns, and this console has been fooled
    -- by that shape of answer before.
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_other::text, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin
      select count(*) into v_n from admin_releases();
      reset role;
      insert into proof values (24,'MUST FAIL: a non-admin calls admin_releases()',
        'refused, SQLSTATE 42501', 'ANSWERED with ' || v_n::text || ' row(s)',
        'FAIL - every signed-in user can list every release');
    exception when others then
      reset role;
      insert into proof values (24,'MUST FAIL: a non-admin calls admin_releases()',
        'refused, SQLSTATE 42501', sqlstate || ' ' || sqlerrm,
        case when sqlstate = '42501' then 'PASS - refused' else 'INCONCLUSIVE - refused, but not by the check' end);
    end;
  else
    insert into proof values (22,'THE FIX: admin sees that same release through admin_releases()',
      '1','-','SKIPPED - patch not installed');
    insert into proof values (23,'admin sees a release scheduled for next week through admin_releases()',
      '1','-','SKIPPED - patch not installed');
    insert into proof values (24,'MUST FAIL: a non-admin calls admin_releases()',
      'refused, SQLSTATE 42501','-','SKIPPED - patch not installed');
  end if;

  -- --------------------------------------------------------- the non-admin
  -- These four numbers are the whole "nothing widened" claim. They are read
  -- through the table, which the patch does not touch, so they must be the
  -- same before and after it is installed.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_other::text, 'role', 'authenticated')::text, true);
  insert into proof values (29,'fixture assertion','is_platform_admin() = false for the chosen non-admin',
    coalesce(is_platform_admin()::text,'null'),
    case when is_platform_admin() then 'ABORT - the non-admin fixture is an admin' else 'PASS' end);
  if is_platform_admin() then return; end if;

  set local role authenticated; select count(*) into v_n from app_releases where id = r_all; reset role;
  insert into proof values (30,'non-admin, through the table: an ''everyone'' release',
    '1', v_n::text, case when v_n = 1 then 'PASS' else 'FAIL' end);

  set local role authenticated; select count(*) into v_n from app_releases where id = r_mine; reset role;
  insert into proof values (31,'non-admin, through the table: a limited release naming HIS company',
    '1', v_n::text, case when v_n = 1 then 'PASS' else 'FAIL' end);

  set local role authenticated; select count(*) into v_n from app_releases where id = r_theirs; reset role;
  insert into proof values (32,'non-admin, through the table: a limited release naming someone else',
    '0', v_n::text, case when v_n = 0 then 'PASS' else 'FAIL - he can see a rollout he is not in' end);

  set local role authenticated; select count(*) into v_n from app_releases where id = r_future; reset role;
  insert into proof values (33,'non-admin, through the table: a release scheduled for next week',
    '0', v_n::text, case when v_n = 0 then 'PASS' else 'FAIL - the schedule leaked' end);

  set local role authenticated; select count(*) into v_n from app_release_audience where release_id = r_mine; reset role;
  insert into proof values (34,'non-admin, through the table: the audience list itself',
    '0 - app_release_audience is admin-only', v_n::text,
    case when v_n = 0 then 'PASS' else 'FAIL' end);

  -- --------------------------------------------------------------- anon
  -- The tokenless phone from supabase_release_visibility_patch.sql. It must
  -- get ROWS, and it must not get an ERROR: an update check that fails is
  -- indistinguishable from "you are on the latest version", which is exactly
  -- how the update prompt went quiet the first time.
  perform set_config('request.jwt.claims', '', true);
  set local role anon;
  begin
    select count(*) into v_n from app_releases where id = r_all;
    reset role;
    insert into proof values (40,'anon, through the table: an ''everyone'' release',
      '1, and no error', v_n::text, case when v_n = 1 then 'PASS' else 'FAIL' end);
  exception when others then
    reset role;
    insert into proof values (40,'anon, through the table: an ''everyone'' release',
      '1, and no error', sqlstate || ' ' || sqlerrm,
      'FAIL - a phone checking for an update before its session is restored now gets an error');
  end;

  set local role anon;
  begin
    select count(*) into v_n from app_releases where id = r_mine;
    reset role;
    insert into proof values (41,'anon, through the table: a limited release',
      '0 - no identity, no audience', v_n::text, case when v_n = 0 then 'PASS' else 'FAIL' end);
  exception when others then
    reset role;
    insert into proof values (41,'anon, through the table: a limited release',
      '0 - no identity, no audience', sqlstate || ' ' || sqlerrm, 'FAIL');
  end;
  reset role;
end
$proof$;

select * from proof order by step;

rollback;

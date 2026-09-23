-- supabase_r7_admin_second_factor_probe.sql -- proof for
-- supabase_r7_admin_second_factor.sql. Run AFTER it. One transaction, rolled
-- back; nothing is written and no session, factor or profile is touched.
--
-- Personas are chosen by PROPERTY, never by name, and every claim set here is
-- the shape a REAL Supabase access token carries: sub, role, session_id and
-- aal. Leaving aal or session_id out would be a probe of something the server
-- never sees, and would pass for the wrong reason.
--
-- Expected: ok true on every row EXCEPT z_planted_failure, which must read
-- false. A probe where everything passes has not been shown to be able to fail.
begin;

create temp table _mfa(arm text, ok boolean, detail text) on commit drop;
grant all on _mfa to authenticated;

do $probe$
declare
  admin_id uuid; admin_session uuid; plain_id uuid; nofactor_id uuid;
  fake_session uuid := gen_random_uuid();
  n_factor int; v boolean; a boolean;
begin
  -- The one account with the flag AND a verified factor: the only account the
  -- new gate actually applies to.
  select p.id into admin_id
    from profiles p
   where p.is_platform_admin
     and exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified')
   limit 1;
  if admin_id is null then
    insert into _mfa values ('FIXTURE', false, 'no platform admin with a verified factor -- nothing to prove');
    return;
  end if;

  select s.id into admin_session from auth.sessions s
   where s.user_id = admin_id and s.aal::text = 'aal2'
     and (s.not_after is null or s.not_after > now())
   order by s.created_at desc limit 1;

  -- Somebody who is not an admin at all, and somebody with no verified factor.
  select p.id into plain_id from profiles p where not coalesce(p.is_platform_admin, false) limit 1;
  select p.id into nofactor_id from profiles p
   where not exists (select 1 from auth.mfa_factors f where f.user_id = p.id and f.status = 'verified')
   limit 1;

  select count(*) into n_factor from auth.mfa_factors f
   where f.user_id = admin_id and f.status = 'verified';
  insert into _mfa values ('fixture_admin_has_a_factor', n_factor > 0,
    'the gate is live for this account: ' || n_factor || ' verified factor(s)');
  insert into _mfa values ('fixture_admin_has_an_aal2_session', admin_session is not null,
    coalesce(admin_session::text, 'none -- the a_ arm below would prove nothing'));

  -- ---------- a: the real admin, on their real aal2 session ----------
  perform set_config('request.jwt.claims', json_build_object(
    'sub', admin_id, 'role', 'authenticated',
    'session_id', coalesce(admin_session, fake_session), 'aal', 'aal2')::text, true);
  execute 'set local role authenticated';
  a := public.admin_second_factor_ok(); v := public.is_platform_admin();
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  insert into _mfa values ('a_admin_with_second_factor', a and v,
    'second_factor_ok=' || a || ' is_platform_admin=' || v || ' -- MUST be true, or the console is bricked');

  -- ---------- b: the same admin, password only ----------
  -- A real password-only token carries that account's OWN session, whose row
  -- reads aal1, and an aal1 claim. Modelled with a session id the server does
  -- not know, which is the same answer from both halves: not aal2.
  perform set_config('request.jwt.claims', json_build_object(
    'sub', admin_id, 'role', 'authenticated',
    'session_id', fake_session, 'aal', 'aal1')::text, true);
  execute 'set local role authenticated';
  a := public.admin_second_factor_ok(); v := public.is_platform_admin();
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  insert into _mfa values ('b_admin_password_only_is_refused', (not a) and (not v),
    'second_factor_ok=' || a || ' is_platform_admin=' || v || ' -- this is the hole being closed');

  -- ---------- c: the claim alone cannot be downgraded into a pass ----------
  -- aal1 in the claim but the REAL aal2 session: still allowed, because the
  -- server's own record outranks the claim. The reverse (aal2 claim, aal1
  -- session) is arm b's shape and is refused.
  if admin_session is not null then
    perform set_config('request.jwt.claims', json_build_object(
      'sub', admin_id, 'role', 'authenticated',
      'session_id', admin_session, 'aal', 'aal1')::text, true);
    execute 'set local role authenticated';
    a := public.admin_second_factor_ok();
    execute 'reset role'; perform set_config('request.jwt.claims', '', true);
    insert into _mfa values ('c_session_row_outranks_the_claim', a,
      'the server''s record says this session used totp, whatever the claim says');
  else
    insert into _mfa values ('c_session_row_outranks_the_claim', null, 'no aal2 session to prove it with');
  end if;

  -- ---------- d: an account with no factor is unaffected ----------
  if nofactor_id is not null then
    perform set_config('request.jwt.claims', json_build_object(
      'sub', nofactor_id, 'role', 'authenticated',
      'session_id', fake_session, 'aal', 'aal1')::text, true);
    execute 'set local role authenticated';
    a := public.admin_second_factor_ok();
    execute 'reset role'; perform set_config('request.jwt.claims', '', true);
    insert into _mfa values ('d_no_factor_is_unaffected', a,
      'nothing to ask for, so nothing changes -- this is what makes a lockout impossible');
  else
    insert into _mfa values ('d_no_factor_is_unaffected', null, 'every account has a factor');
  end if;

  -- ---------- e: a non-admin is still refused, factor or not ----------
  if plain_id is not null then
    perform set_config('request.jwt.claims', json_build_object(
      'sub', plain_id, 'role', 'authenticated',
      'session_id', fake_session, 'aal', 'aal2')::text, true);
    execute 'set local role authenticated';
    v := public.is_platform_admin();
    execute 'reset role'; perform set_config('request.jwt.claims', '', true);
    insert into _mfa values ('e_non_admin_refused_even_at_aal2', not v,
      'the second factor is an ADDITIONAL gate, never a replacement for the flag');
  else
    insert into _mfa values ('e_non_admin_refused_even_at_aal2', null, 'no non-admin profile');
  end if;

  -- ---------- f: the service role is untouched ----------
  -- No claims at all: auth.uid() is null, as it is for the Stripe webhook and
  -- every backend write. is_platform_admin() was false there before and must
  -- stay false -- the callers that matter guard on the null uid, not on this.
  perform set_config('request.jwt.claims', '', true);
  v := public.is_platform_admin();
  insert into _mfa values ('f_service_role_unchanged', not v,
    'auth.uid() is null -> false, exactly as before this change');

  -- ---------- z: the harness must be able to fail ----------
  insert into _mfa values ('z_planted_failure', (select count(*) from auth.mfa_factors) < 0,
    'MUST read false -- proves these assertions can fail');
end
$probe$;

select arm, ok, detail from _mfa order by arm;

rollback;

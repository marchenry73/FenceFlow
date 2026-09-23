-- supabase_r7_admin_cannot_suspend_itself_probe.sql -- proof for
-- supabase_r7_admin_cannot_suspend_itself.sql. Run AFTER it.
--
-- One transaction, rolled back. It DOES call admin_suspend on a real company --
-- there is no other way to prove the guard fires and the audit entry lands --
-- so everything is inside begin/rollback and the victim is chosen by PROPERTY:
-- a ZZ TEST fixture with no profiles, never a real customer. The rollback is
-- asserted by supabase_r7_admin_cannot_suspend_itself_probe_after.sql, which is a
-- SEPARATE run: the arm rows live in a temp table written inside this very
-- transaction, so they cannot outlive the rollback that proves the writes did
-- not either. One file cannot report both.
--
-- The claims set here carry sub, role, session_id and aal, because
-- is_platform_admin() now requires a second factor
-- (supabase_r7_admin_second_factor.sql) -- leaving aal out would make every arm
-- fail for the wrong reason and the guard would look like it worked.
--
-- Expected: ok true on every row EXCEPT z_planted_failure, which must read false.
begin;

create temp table _sus(arm text, ok boolean, detail text) on commit drop;
grant all on _sus to authenticated;

do $probe$
declare
  admin_id uuid; admin_session uuid; own_company uuid; victim uuid; victim_name text;
  n_before int; n_after int; blocked boolean; msg text;
  still_suspended boolean;
begin
  select p.id, p.company_id into admin_id, own_company
    from profiles p where p.is_platform_admin limit 1;
  select s.id into admin_session from auth.sessions s
   where s.user_id = admin_id and s.aal::text = 'aal2'
     and (s.not_after is null or s.not_after > now())
   order by s.created_at desc limit 1;

  -- By property: a ZZ TEST fixture, not suspended, with nobody in it.
  -- companies carries no is_test_fixture column (that is on jobs), so the name
  -- prefix is the only marker -- and the other two conditions are what actually
  -- make it safe: nobody is in it, and it is not the admin own company.
  select c.id, c.name into victim, victim_name from companies c
   where c.name like 'ZZ TEST%' and not c.suspended
     and not exists (select 1 from profiles p where p.company_id = c.id)
     and c.id <> own_company
   limit 1;

  insert into _sus values ('fixture_admin_and_own_company',
    admin_id is not null and own_company is not null,
    'admin=' || coalesce(admin_id::text,'null') || ' own_company=' || coalesce(own_company::text,'null'));
  insert into _sus values ('fixture_victim_is_a_test_company_with_nobody_in_it',
    victim is not null, coalesce(victim_name, 'none found -- arms b and c prove nothing'));
  if admin_id is null or own_company is null then return; end if;

  perform set_config('request.jwt.claims', json_build_object(
    'sub', admin_id, 'role', 'authenticated',
    'session_id', coalesce(admin_session, gen_random_uuid()), 'aal', 'aal2')::text, true);
  execute 'set local role authenticated';

  -- ---------- a: the admin's OWN company is refused ----------
  blocked := false; msg := '';
  begin
    perform public.admin_suspend(own_company, 'ZZ probe -- must never land', false);
  exception when others then
    blocked := true; msg := sqlerrm;
  end;
  insert into _sus values ('a_own_company_is_refused', blocked, left(msg, 160));

  -- ...and nothing moved on it.
  execute 'reset role';
  select c.suspended into still_suspended from companies c where c.id = own_company;
  insert into _sus values ('a2_own_company_untouched', not coalesce(still_suspended, true),
    'suspended is still ' || coalesce(still_suspended::text, 'null'));
  execute 'set local role authenticated';

  -- ---------- b: another company is still suspendable ----------
  if victim is not null then
    select count(*) into n_before from audit_log
     where table_name = 'companies' and record_id = victim::text;
    blocked := false; msg := '';
    begin
      perform public.admin_suspend(victim, 'ZZ probe -- rolled back', false);
    exception when others then
      blocked := true; msg := sqlerrm;
    end;
    insert into _sus values ('b_another_company_still_works', not blocked, left(msg, 160));

    execute 'reset role';
    select count(*) into n_after from audit_log
     where table_name = 'companies' and record_id = victim::text;
    -- ---------- c: and it is finally written down ----------
    insert into _sus values ('c_the_suspension_is_audited', n_after > n_before,
      n_before || ' -> ' || n_after || ' audit rows for that company');
    insert into _sus
    select 'c2_the_entry_names_who_and_what', count(*) > 0,
           coalesce(string_agg(a.field || ': ' || coalesce(a.old_value,'-') || ' -> '
                               || coalesce(a.new_value,'-') || ' by ' || coalesce(a.actor_email,'?')
                               || ' [' || coalesce(a.label,'') || ']', ' | '), '(nothing)')
      from audit_log a
     where a.table_name = 'companies' and a.record_id = victim::text
       and a.field = 'suspended';
    execute 'set local role authenticated';
  else
    insert into _sus values ('b_another_company_still_works', null, 'no safe victim');
    insert into _sus values ('c_the_suspension_is_audited', null, 'no safe victim');
    insert into _sus values ('c2_the_entry_names_who_and_what', null, 'no safe victim');
  end if;

  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  -- ---------- d: a non-admin is still refused first ----------
  declare plain uuid;
  begin
    select p.id into plain from profiles p where not coalesce(p.is_platform_admin, false) limit 1;
    if plain is not null then
      perform set_config('request.jwt.claims', json_build_object(
        'sub', plain, 'role', 'authenticated',
        'session_id', gen_random_uuid(), 'aal', 'aal2')::text, true);
      execute 'set local role authenticated';
      blocked := false; msg := '';
      begin
        perform public.admin_suspend(coalesce(victim, own_company), 'ZZ probe', false);
      exception when others then blocked := true; msg := sqlerrm;
      end;
      execute 'reset role';
      perform set_config('request.jwt.claims', '', true);
      insert into _sus values ('d_non_admin_refused', blocked, left(msg, 120));
    else
      insert into _sus values ('d_non_admin_refused', null, 'no non-admin profile');
    end if;
  end;

  -- ---------- z: the harness must be able to fail ----------
  insert into _sus values ('z_planted_failure', (select count(*) from companies) < 0,
    'MUST read false -- proves these assertions can fail');
end
$probe$;

select arm, ok, detail from _sus order by arm;

rollback;

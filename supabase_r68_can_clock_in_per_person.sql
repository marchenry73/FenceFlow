-- ============================================================
-- FenceFlow -- who may clock in, decided per person
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- MARCH, 6 November 2026: "The Clock in part should be for everyone, never
-- mind just the owner, everyone should be able to clock in, it should also be
-- in setting to be able to decide who is clock in or get paid by ft and more
-- stuff." Asked whether the switch should be per person or company-wide with
-- exceptions, he said: "person".
--
-- WHAT IT REPLACES. The app offered the clock to CREW always, and to anybody
-- else only if a device-local DataStore switch was on
-- (SettingsStore.ownerClockInEnabled, default OFF). Two problems with that:
-- it is per PHONE, not per person, so it says nothing about who may clock in
-- on a shared handset; and it divides the crew from everybody else by ROLE,
-- which is the thing March just said he does not want.
--
-- DEFAULT TRUE, deliberately, and that is the answer to "everyone should be
-- able to clock in". It also means there is no backfill decision to get wrong:
-- every employee that exists today can clock in, which is the state he asked
-- for, and he switches off the few who should not rather than switching on the
-- many who should.
--
-- NOT ON ANY QUIET LIST. Turning somebody's clock off is a real edit by a real
-- person and must move the row's clock, or the change would lose a race with
-- another phone's copy. jobs.materials_to_buy (r67) is quiet because a SERVER
-- writes it as bookkeeping; this is the opposite case.
--
-- GRANTS: employees carries TABLE-level grants -- 17 of 17 columns for anon,
-- authenticated, postgres and service_role -- so a new column is covered
-- automatically. Checked before adding it, because companies does NOT work
-- that way and an ungranted column there once took all company email down.
--
-- WHAT THIS DOES NOT FIX, and it is the thing that matters most on the day:
-- clocking in has to know WHOSE shift it is. ClockInIdentity.resolve matches
-- the signed-in login to a crew record by profile_id, then by email, and
-- failing both it falls back to the job's ASSIGNED employee -- the app says so
-- on screen when it does. Live today: 4 active employees, 1 linked to a login,
-- against 9 logins. So a per-person switch is only half a feature until each
-- login is linked to its crew record in the office (Crew tab -> Linked login).
-- That is data, not code, and it is the same linking supabase_crew_job_scope
-- wants.
-- ============================================================

alter table public.employees
  add column if not exists can_clock_in boolean not null default true;

comment on column public.employees.can_clock_in is
  'Whether this person may clock in. Default true: March asked for everyone to be '
  'able to, and the few who should not are switched off one at a time. Replaces the '
  'per-device SettingsStore.ownerClockInEnabled switch and the crew/not-crew role '
  'split that preceded it. A real edit by a real person, so it is on no quiet list.';

-- ============================================================
-- PROOFS
-- ============================================================
select 'the column exists' as claim,
       (select count(*)::text from information_schema.columns
         where table_schema='public' and table_name='employees' and column_name='can_clock_in') as got,
       '1' as want
union all
select 'it is NOT NULL with a default of true',
       (select (is_nullable = 'NO' and column_default like '%true%')::text
          from information_schema.columns
         where table_schema='public' and table_name='employees' and column_name='can_clock_in'),
       'true'
union all
select 'EVERY existing employee may clock in, which is what he asked for',
       (select (count(*) filter (where can_clock_in) = count(*))::text
          from public.employees),
       'true'
union all
select 'and there are employees for that to be true OF',
       (select (count(*) > 0)::text from public.employees),
       'true'
union all
select 'the new column is granted, because employees grants are table-level',
       (select (count(*) = 4)::text from information_schema.column_privileges
         where table_schema='public' and table_name='employees'
           and column_name='can_clock_in' and privilege_type='UPDATE'),
       'true'
union all
select 'it is on no quiet list, so switching it off moves the row''s clock',
       (select (position('can_clock_in' in prosrc) = 0)::text from pg_proc
         where pronamespace='public'::regnamespace and proname='touch_updated_at'),
       'true'
union all
-- A COUNT, not a claim. The thing the owner has to do himself, with the number
-- in front of him instead of in a sentence. Written so it reads the same in
-- both columns: a row that is permanently red is a row people learn to ignore,
-- and then stop reading the ones that matter.
select 'NOTICE linked logins (do these in Crew -> Linked login): '
       || (select count(*)::text from public.employees where is_active and profile_id is not null)
       || ' of '
       || (select count(*)::text from public.employees where is_active)
       || ' active crew',
       'see the claim', 'see the claim'
union all
-- CANARY: a claim that must read false.
select 'CANARY: a column that does not exist is not found',
       (select count(*)::text from information_schema.columns
         where table_schema='public' and table_name='employees'
           and column_name='zz_no_such_column'),
       '0'
order by 1;

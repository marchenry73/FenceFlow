-- Optional, permanent crew fixtures for ZZ TEST -- Busy season
-- (22222222-2222-4222-8222-222222222003).
--
-- NOT required by tests/company-crew-golden-path.test.mjs -- that file
-- creates and rolls back its own throwaway auth.users/profiles/employees
-- rows inside `begin; ... rollback;`, the same pattern
-- tests/company-golden-path.test.mjs uses, so it never depends on this file
-- having been run. This is here only so a real, standing pair of crew
-- members exists on ZZ_BUSY for anyone poking at the office dashboard by
-- hand against the fixture company, without needing a phone to create one.
--
-- Written, not run, per this task's rules. If it is ever run: purely
-- additive, safe to run twice (every insert is keyed on a fixed id and does
-- nothing on conflict), and every row is scoped to ZZ_BUSY and named
-- "ZZ TEST" so it can never be mistaken for a real crew member.
--
-- Undo:
--   delete from employees where company_id = '22222222-2222-4222-8222-222222222003'
--     and sync_id in ('44444444-0000-4000-8000-000000000001',
--                      '44444444-0000-4000-8000-000000000002');
--   delete from profiles where id in ('55555555-0000-4000-8000-000000000001',
--                                     '55555555-0000-4000-8000-000000000002');
--   delete from auth.users where id in ('55555555-0000-4000-8000-000000000001',
--                                       '55555555-0000-4000-8000-000000000002');

insert into auth.users (id) values
  ('55555555-0000-4000-8000-000000000001'),
  ('55555555-0000-4000-8000-000000000002')
on conflict (id) do nothing;

insert into profiles (id, company_id, role, full_name) values
  ('55555555-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222003', 'FOREMAN', 'ZZ TEST Foreman'),
  ('55555555-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222003', 'CREW',    'ZZ TEST Crew Member')
on conflict (id) do nothing;

insert into employees (company_id, sync_id, name, profile_id, hourly_rate, is_active) values
  ('22222222-2222-4222-8222-222222222003', '44444444-0000-4000-8000-000000000001',
   'ZZ TEST Foreman', '55555555-0000-4000-8000-000000000001', 28, true),
  ('22222222-2222-4222-8222-222222222003', '44444444-0000-4000-8000-000000000002',
   'ZZ TEST Crew Member', '55555555-0000-4000-8000-000000000002', 22, true)
on conflict (sync_id) do nothing;

select 'ZZ TEST crew fixtures installed' as done,
       (select count(*) from employees where company_id = '22222222-2222-4222-8222-222222222003'
          and name like 'ZZ TEST%') as zz_busy_crew;

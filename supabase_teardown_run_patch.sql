-- A run can be the old fence coming out, priced by its own drawn length.
alter table public.fence_runs add column if not exists is_teardown boolean not null default false;
select 'is_teardown added' as done;

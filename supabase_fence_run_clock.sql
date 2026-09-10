-- The phone now compares fence run edit clocks. The cloud side needs the same
-- column, and the same trigger that owns it everywhere else -- without the
-- trigger the column keeps its default and every comparison reads the same
-- value, which is a gate that lets everything through.
alter table fence_runs add column if not exists updated_at timestamptz not null default now();

drop trigger if exists fence_runs_touch_updated_at on fence_runs;
create trigger fence_runs_touch_updated_at
  before update on fence_runs
  for each row execute function public.touch_updated_at();

select (select count(*) from information_schema.columns
        where table_schema='public' and table_name='fence_runs' and column_name='updated_at') as column_added,
       (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid
        where c.relname='fence_runs' and t.tgname='fence_runs_touch_updated_at') as trigger_added;

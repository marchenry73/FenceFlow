-- Teardown length typed on the job (0 = follows the new fence).
alter table public.jobs add column if not exists teardown_feet numeric not null default 0;

-- Every synced table on the live channel, so a change on one phone reaches
-- the others within seconds instead of at the next heartbeat. The publication
-- carried jobs, job_payments, payment_records, field_changes and profiles;
-- a redrawn fence, a ticked walkthrough step or a clocked shift never arrived
-- live. Idempotent: each table is added only if it is not already there.
do $$
declare t text;
begin
  foreach t in array array[
    'fence_runs','estimate_line_items','job_steps','time_entries','change_orders',
    'site_markers','punch_list_items','expenses','employees','material_items','pricing_tiers'
  ] loop
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename=t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

select count(*) as tables_on_live_channel from pg_publication_tables where pubname='supabase_realtime';

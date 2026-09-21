-- P4 / Realtime: what wal2json actually emits on this database, observed.
--
-- supabase_p4_realtime_probe.sql builds wal2json records by hand to feed the
-- deployed realtime.apply_rls. This file is the evidence for that shape. It
-- decodes a real, committed change through a real wal2json slot with the same
-- options realtime.list_changes uses, on two scratch tables that differ only
-- in replica identity.
--
-- Observed 2026-09-21:
--   FULL     UPDATE identity = every OLD column;   DELETE identity = every column
--   DEFAULT  UPDATE identity = primary key only;   DELETE identity = primary key only
--   A DELETE carries no "columns" key at all.
--   With 'actions' = 'insert,update' (what list_changes asks for once the
--   publication stops publishing delete) the DELETE records are not emitted.
--
-- SIDE EFFECTS, all self-cleaning: a TEMPORARY logical slot (dropped here and in
-- any case when the session ends) and a scratch schema p4rt_probe_tmp created,
-- written and dropped. No application table is touched and nothing is added to
-- any publication. Needs a role with REPLICATION (postgres has it).
-- Change 'insert,update,delete' below to 'insert,update' for the second run.

select 'x' from pg_create_logical_replication_slot('p4rt_probe_slot', 'wal2json', true);
begin;
create schema p4rt_probe_tmp;
create table p4rt_probe_tmp.t_full (id uuid primary key, company_id uuid not null, secret numeric, name text);
create table p4rt_probe_tmp.t_def  (id uuid primary key, company_id uuid not null, secret numeric, name text);
alter table p4rt_probe_tmp.t_full replica identity full;
commit;
begin;
insert into p4rt_probe_tmp.t_full values ('a0000000-0000-4000-8000-00000000000f','c0000000-0000-4000-8000-00000000000a',100,'Alice');
insert into p4rt_probe_tmp.t_def  values ('a0000000-0000-4000-8000-00000000000d','c0000000-0000-4000-8000-00000000000a',100,'Alice');
commit;
begin;
update p4rt_probe_tmp.t_full set secret = 250;
update p4rt_probe_tmp.t_def  set secret = 250;
commit;
begin;
delete from p4rt_probe_tmp.t_full;
delete from p4rt_probe_tmp.t_def;
commit;
begin;
create temp table p4out as
  select row_number() over () n, data from pg_logical_slot_get_changes('p4rt_probe_slot', null, null,
    'include-pk','true','include-transaction','false','include-timestamp','true','include-type-oids','true',
    'format-version','2','actions','insert,update,delete','add-tables','p4rt_probe_tmp.*');
drop schema p4rt_probe_tmp cascade;
commit;
select pg_drop_replication_slot('p4rt_probe_slot');
select n, data from p4out order by n;

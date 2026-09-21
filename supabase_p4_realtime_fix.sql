-- P4 / Realtime: stop publishing the one change Realtime cannot authorise.
--
-- HOW THE LIVE FEED IS GUARDED (read from the deployed realtime.apply_rls on
-- 2026-09-21, and exercised by supabase_p4_realtime_probe.sql):
--
--   INSERT / UPDATE  Realtime re-checks every change against the subscriber's
--                    own SELECT policies (it runs `select exists(... where id =
--                    <pk>)` as role authenticated with the subscriber's JWT
--                    claims) and strips columns the role cannot SELECT. The
--                    feed can never show a row or column the same person could
--                    not SELECT. Proved: company B's owner, an anonymous client
--                    and company A's crew receive nothing of A's jobs,
--                    job_payments or payment_records; crew receive exactly what
--                    their own SELECT returns (their own shift and rate, never
--                    a colleague's).
--
--   DELETE           NOT checked. The deployed code says so itself: "if RLS
--                    enabled, we can't secure deletes so filter to pkey". The
--                    payload is trimmed to the primary key, but the event is
--                    delivered to ANY subscriber whose filter matches the OLD
--                    row -- and under REPLICA IDENTITY FULL the old row carries
--                    every column. A filter may compare (eq, neq, lt, gt, in,
--                    ...) any column the role can SELECT, and anon and
--                    authenticated can SELECT every column of these tables (RLS
--                    guards rows, not columns). So before this patch anyone
--                    holding the public anon key -- no sign-in -- could register
--                    `contract_total=gt.10000`, `amount_cents=gt.100000` or
--                    `full_name=eq.<a name>` on jobs, job_payments,
--                    payment_records, field_changes or profiles and learn, row
--                    by row, whether another company's deleted records matched.
--                    The audit's claim that whole rows were broadcast is wrong
--                    (the payload is primary key only); the oracle is the leak.
--                    Live, 2026-09-21: an anonymous websocket client joined with
--                    jobs `contract_total=gt.10000` and payment_records DELETE
--                    `amount=gt.1000` and the server answered "Subscribed to
--                    PostgreSQL" -- the precondition, on the real server.
--
-- WHO CONSUMES A DELETE TODAY: nobody who needs one.
--   * RealtimeWatcher.kt subscribes jobs as Update only; dashboard.html
--     subscribes jobs as UPDATE only.
--   * Every other phone subscription filters on company_id. Under DEFAULT a
--     DELETE carries only the primary key, so a company_id filter can never
--     match it -- which is already how 12 of the 17 published tables behave.
--   * Clients cannot hard-delete jobs, job_payments, payment_records,
--     field_changes or profiles at all (no DELETE policy; the probe's owner
--     DELETE returns rows=0). Their only deletes are privileged: a company
--     cascade, an auth user removed by an operator, a cleanup script. Every
--     app flow that removes something is a soft delete, i.e. an UPDATE, which
--     still arrives.
--
-- THE CHANGE
--   1. The publication stops publishing DELETE. realtime.list_changes asks
--      wal2json for exactly the actions the publication has on, so no DELETE
--      reaches apply_rls for any table. Observed on this database: with
--      'actions'='insert,update' wal2json emits no D records
--      (supabase_p4_realtime_wal_shape.sql).
--   2. profiles, job_payments, payment_records and field_changes go back to
--      REPLICA IDENTITY DEFAULT. Nothing reads their old row -- the phone uses
--      each event only as "go and sync" and never looks at the payload -- so
--      FULL was bought for nothing, costs a whole extra row of WAL on every
--      update, and would reopen the oracle the day DELETE is published again.
--   3. jobs STAYS FULL. dashboard.html (~line 17164) raises the "customer
--      approved the quote" banner only when payload.old.quote_approved_at was
--      empty; under DEFAULT payload.old is {id} alone, so the banner would fire
--      on every edit of an already-approved job. The probe's ALT phase shows
--      exactly that. With DELETE unpublished, FULL on jobs only enriches UPDATE
--      events, and those are RLS-checked per subscriber.
--
-- NOT DONE, ON PURPOSE
--   * No table leaves the publication: all 17 have a live subscriber
--     (RealtimeWatcher.kt: jobs, job_payments, profiles + LIVE_TABLES).
--   * No publication column list or row filter. Supabase Realtime reads the
--     publication only for its table list and its insert/update/delete flags
--     (realtime.list_changes passes 'add-tables' and 'actions' to wal2json and
--     nothing else); column lists and row filters are a pgoutput feature and
--     would be silently ignored -- a fix that looks applied and is not. The
--     live Realtime slot here, supabase_realtime_replication_slot_2_135_4_*,
--     was observed to be a wal2json slot.
--
-- If a future screen genuinely needs DELETE events, publishing them again
-- reopens the oracle on jobs (FULL). Change the dashboard to stop reading
-- payload.old first, then set jobs to DEFAULT, then re-add delete.
--
-- Rollback: supabase_p4_realtime_rollback.sql.

begin;
set local lock_timeout = '5s';   -- never queue behind a long transaction holding jobs up

do $pre$
declare t text;
begin
  -- DEFAULT falls back to the primary key. A published table with neither
  -- would start refusing every UPDATE, so refuse to proceed instead.
  foreach t in array array['profiles','job_payments','payment_records','field_changes'] loop
    if not exists (select 1 from pg_constraint
                    where conrelid = format('public.%I', t)::regclass and contype = 'p') then
      raise exception 'public.% has no primary key; REPLICA IDENTITY DEFAULT would break its UPDATEs', t;
    end if;
  end loop;
end $pre$;

alter table public.profiles        replica identity default;
alter table public.job_payments    replica identity default;
alter table public.payment_records replica identity default;
alter table public.field_changes   replica identity default;
-- public.jobs deliberately left at FULL (see 3 above).

alter publication supabase_realtime set (publish = 'insert, update, truncate');

do $post$
declare
  wanted text[] := array['change_orders','employees','estimate_line_items','expenses','fence_runs',
                         'field_changes','job_payments','job_steps','jobs','material_items',
                         'payment_records','pricing_tiers','profiles','punch_list_items',
                         'site_markers','sync_signals','time_entries'];
  missing text;
  wrong text;
begin
  select string_agg(t, ',') into missing
    from unnest(wanted) t
   where not exists (select 1 from pg_publication_tables pt
                      where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public' and pt.tablename = t);
  if missing is not null then
    raise exception 'a live-update table left the publication: %', missing;
  end if;

  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime'
                   and pubinsert and pubupdate and not pubdelete) then
    raise exception 'supabase_realtime flags are not insert+update without delete';
  end if;

  select string_agg(c.relname || '=' || c.relreplident::text, ',') into wrong
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = any(wanted)
     and c.relreplident <> case when c.relname = 'jobs' then 'f' else 'd' end;
  if wrong is not null then
    raise exception 'unexpected replica identity: %', wrong;
  end if;
end $post$;

commit;

select format('publish ins=%s upd=%s del=%s', pubinsert, pubupdate, pubdelete) as state
  from pg_publication where pubname = 'supabase_realtime'
union all
select 'replica identity: ' || string_agg(pt.tablename || '=' || c.relreplident::text, ' ' order by pt.tablename)
  from pg_publication_tables pt
  join pg_class c on c.relname = pt.tablename
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = pt.schemaname
 where pt.pubname = 'supabase_realtime';

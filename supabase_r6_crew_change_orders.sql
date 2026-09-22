-- ============================================================
-- FenceFlow -- a crew phone's change orders reach the server
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
-- KIND: NEW FUNCTION (crew_push_change_orders). No row, policy, trigger or
-- existing-function changes. The RLS policies on change_orders are NOT
-- loosened -- the probe proves the crew's direct upsert is still refused.
-- Apply supabase_r6_change_order_feet_check.sql right after it (the table
-- CHECK that closes the crew's bare-INSERT path to NaN / Infinity / negative
-- feet, which this function cannot close by itself).
--
-- THE HOLE (confirmed 2026-09-22 in a rolled-back probe): the app pushes
-- change orders with supabase-kt upsert(onConflict = "company_id,sync_id"),
-- which PostgREST sends as INSERT ... ON CONFLICT DO UPDATE. ON CONFLICT names
-- the arbiter columns, which needs SELECT on the table, so Postgres checks the
-- table's SELECT policies against the row -- and the RESTRICTIVE
-- change_orders_money_hidden_from_crew (has_permission('SEE_MONEY')) fails for
-- a crew login: 42501, for a new row and an existing one alike. DO NOTHING is
-- refused the same way; a plain UPDATE by sync_id touches 0 rows (the crew
-- cannot see any row to update); only a bare INSERT gets through. So no crew
-- change order has ever reached the server -- change_orders held 0 rows in
-- production on 2026-09-22.
--
-- THE FIX: a definer RPC for the crew path, modelled on the LIVE
-- crew_save_job / crew_push_line_items (read with pg_get_functiondef on
-- 2026-09-22): the same caller checks, then row by row --
--   * the company is always the caller's. A row naming another company is
--     skipped, never written anywhere.
--   * the job must be in the caller's company, not deleted, and -- once
--     supabase_crew_job_scope.sql is applied -- visible to the caller
--     (public.can_see_job). That is looked up on every call with
--     to_regprocedure and called through EXECUTE, so this body works before
--     job scope lands and obeys it after, with nothing to re-run.
--     FAIL CLOSED: once any part of job scope is here (job_assignments,
--     my_visible_job_sync_ids(), sees_all_jobs()) and can_see_job(uuid) is
--     not -- renamed, dropped, re-typed -- the whole call is refused 42501
--     rather than quietly widening to every job in the company while the
--     table policies stay scoped. (Verifier row J24, 2026-09-22.)
--   * an existing order (same company + sync_id) must be on that same job
--     and not tombstoned. An order never moves between jobs through here,
--     and a deleted one is never edited or brought back.
--   * only the ALLOWLIST below is written. It is a list of what the crew may
--     set, not a list of what they may not, so a column added to
--     change_orders tomorrow (money or otherwise) is out until someone adds
--     it here on purpose.
--   * a row that fails any of that is COUNTED, not raised, so one stale or
--     foreign row cannot take the rest of the batch down with it (the
--     field_changes lesson: one refused row lost every new request).
--
-- THE ALLOWLIST -- every column change_orders has, and why (checked live):
--   written on INSERT                on UPDATE of an existing order
--   company_id    the caller's        never (it is the lookup key)
--   sync_id       the payload's       never (it is the lookup key)
--   job_sync_id   the payload's       never (must match, or the row is skipped)
--   description   the payload's       only while the terms are the crew's (below)
--   additional_feet  the payload's    only while the terms are the crew's (below)
--   signed_at     the payload's       only when the server has none (write-once)
--   signature_storage_path  payload   only when the server has none (write-once)
--   additional_cost, material_cost    NEVER WRITTEN. Money. Defaults (0) on
--       in_accepted_total                 insert, the existing value on update.
--                                         READ once, as one yes/no, to decide
--                                         whether the terms are still the crew's
--                                         (the self-check pins that read to one
--                                         exact expression). The 00_zero/00_hold/
--                                         latch triggers enforce the same
--                                         underneath, independently.
--   deleted_at, deleted_by            NEVER. Crew can never delete.
--   id, created_at, updated_at        NEVER. The table and touch trigger own them.
--
-- WHOSE TERMS: description and additional_feet are what the crew's add/edit
-- dialog sets (extra footage found on site), and they are billed: labour is
-- charged on the job's feet plus every order's feet (EstimateEngine
-- billableFeet, price-job's change_order_feet). They stay the crew's until
--   - the office prices the order (either cost non-zero), or
--   - a price the customer accepted takes it in (in_accepted_total), or
--   - the customer signs it.
-- After that a phone cannot move them. That matters because a phone's copy
-- is usually a STALE one: every sync pass re-sends every order on every job
-- it may push (EntitySync collectJobChildRows), and it pushes before it
-- pulls -- so without this, an office edit to a priced order was undone by
-- the next crew pass (verifier rows O02/O05: 'flip v2'/20 ft at 300 put back
-- to 'flip v1'/10 ft, still at 300). Between two crew phones, or crew and
-- office on an order nobody has priced yet, it is still last push wins; that
-- needs the app to send only orders changed locally (as line items do with
-- pendingPush) -- the server has no clock of the phone's edit to go by.
-- A SIGNATURE IS FOR THE TERMS THE PHONE SHOWED. On an order whose terms are
-- held but not yet signed, a signature arriving with DIFFERENT terms was
-- taken on a copy the office has since changed: the row is skipped (nothing
-- attached), the next pull shows the crew the office's terms unsigned, and
-- they collect it again. A signature on the terms the server holds lands.
-- The app clears a signature locally when terms are edited, and that null
-- never reaches the server (explicitNulls=false drops it) -- another reason
-- a signed order's terms are frozen here. The signature itself is never
-- cleared from a phone; that would be deleting the evidence. The office
-- (SEE_MONEY) still edits any order through the table directly.
--
-- WHAT IS REFUSED, VALUE BY VALUE:
--   additional_feet  must be finite and >= 0, or the ROW is skipped. NaN and
--       Infinity are also fatal to every phone: to_json writes them as the
--       strings "NaN"/"Infinity", which the app's JSON refuses, so one such
--       row failed the change_orders pull for the whole company.
--   signed_at        must be finite and at most a day ahead of the server
--       (clock skew). Otherwise the SIGNATURE is dropped and the rest of the
--       row stands -- a push must not pin a year-2999 date as evidence.
--   signature_storage_path  only <this company>/<this order's job>/
--       change-order/<file> -- the shape FileSync.upload writes -- with a
--       plain file name and no "..". Otherwise it is dropped.
-- The app does not send signature_storage_path yet (CloudChangeOrder has no
-- such field, though JobFileUploader uploads the image); it is allowlisted so
-- that it can, and today every signed crew order lands without its image path.
--
-- WHO CALLS IT: the crew path. Callers with SEE_MONEY keep using the table
-- directly (their upsert passes the read policy); the RPC also works for them
-- but never writes money, so the office should not switch to it.
--
-- CALL (PostgREST):  POST /rest/v1/rpc/crew_push_change_orders
--   body  {"rows_in": [ {sync_id, job_sync_id, description?, additional_feet?,
--                        signed_at?, signature_storage_path?, company_id?}, ... ]}
--   other keys (costs, in_accepted_total, deleted_*) are accepted and ignored,
--   so the phone can send CloudChangeOrder as it is.
--   returns {"inserted": int, "updated": int, "unchanged": int, "skipped": int}
--     updated   = a row was actually written; unchanged = an existing order
--     this push had nothing to change on (the usual case: a re-sent copy, or
--     terms the office holds). An unchanged row is not written at all.
--   raises 42501 only for the caller as a whole: not signed in / no company,
--   company suspended, neither RECORD_FIELD_WORK nor EDIT_JOBS, or job scope
--   present without can_see_job(uuid).
-- ============================================================

create or replace function public.crew_push_change_orders(rows_in jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
    co uuid := public.current_company_id();
    -- Crew job scope, asked once per call: can_see_job when it is here ...
    scoped boolean := to_regprocedure('public.can_see_job(uuid)') is not null;
    -- ... and whether any other part of job scope is, which means it should be.
    scope_present boolean := to_regclass('public.job_assignments') is not null
                             or to_regprocedure('public.my_visible_job_sync_ids()') is not null
                             or to_regprocedure('public.sees_all_jobs()') is not null;
    r jsonb;
    sid uuid;
    jsid uuid;
    v_desc text;
    v_feet double precision;
    v_signed timestamptz;
    v_sigpath text;
    m text[];
    visible boolean;
    cur record;
    terms_held boolean;
    w_desc text;
    w_feet double precision;
    w_signed timestamptz;
    w_path text;
    n int;
    n_ins int := 0;
    n_upd int := 0;
    n_same int := 0;
    n_skip int := 0;
begin
    if auth.uid() is null or co is null then
        raise exception 'Not signed in' using errcode = '42501';
    end if;
    if public.company_is_suspended() then
        raise exception 'Company suspended' using errcode = '42501';
    end if;
    if not (public.has_permission('RECORD_FIELD_WORK') or public.has_permission('EDIT_JOBS')) then
        raise exception 'Not allowed to write change orders' using errcode = '42501';
    end if;
    -- Fail closed: job scope without its visibility test must not widen this
    -- to the whole company.
    if scope_present and not scoped then
        raise exception 'Crew job scope is incomplete: public.can_see_job(uuid) is missing -- re-run supabase_crew_job_scope.sql'
            using errcode = '42501';
    end if;
    if rows_in is null or jsonb_typeof(rows_in) <> 'array' then
        return jsonb_build_object('inserted', 0, 'updated', 0, 'unchanged', 0, 'skipped', 0);
    end if;

    for r in select e from jsonb_array_elements(rows_in) e loop
        -- One row at a time: a value that will not cast (a sync id that is
        -- not a uuid, feet that are not a number) skips that row only.
        begin
            if jsonb_typeof(r) <> 'object' then
                n_skip := n_skip + 1;
                continue;
            end if;
            sid := nullif(r->>'sync_id', '')::uuid;
            jsid := nullif(r->>'job_sync_id', '')::uuid;
            if sid is null or jsid is null then
                n_skip := n_skip + 1;
                continue;
            end if;
            -- The company is the caller's. A row naming another is not ours.
            if jsonb_typeof(r->'company_id') = 'string'
               and (r->>'company_id')::uuid is distinct from co then
                n_skip := n_skip + 1;
                continue;
            end if;

            v_desc := r->>'description';
            -- Feet are billed, so a real number: finite, not negative. NaN
            -- sorts above Infinity in Postgres, so this one test refuses NaN,
            -- both infinities and negatives.
            v_feet := (r->>'additional_feet')::double precision;
            if v_feet is not null and not (v_feet >= 0 and v_feet < 'Infinity'::double precision) then
                n_skip := n_skip + 1;
                continue;
            end if;
            -- A signing date more than a day ahead (clock skew), or an
            -- infinite one, is not a signature taken on site: dropped; the
            -- rest of the row stands.
            v_signed := (r->>'signed_at')::timestamptz;
            if v_signed is not null and not (isfinite(v_signed) and v_signed <= now() + interval '1 day') then
                v_signed := null;
            end if;
            -- The image only from this order's own folder, the shape the app
            -- uploads to: <company>/<job>/change-order/<file>.
            v_sigpath := nullif(btrim(r->>'signature_storage_path'), '');
            if v_sigpath is not null then
                m := regexp_match(v_sigpath,
                        '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/'
                     || '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/'
                     || 'change-order/([A-Za-z0-9_-][A-Za-z0-9._-]*)$');
                if m is null or m[1]::uuid <> co or m[2]::uuid <> jsid or position('..' in m[3]) > 0 then
                    v_sigpath := null;
                end if;
            end if;

            -- The job: this company's, alive, and (with job scope) the caller's.
            if not exists (select 1 from public.jobs j
                            where j.company_id = co and j.sync_id = jsid
                              and j.deleted_at is null) then
                n_skip := n_skip + 1;
                continue;
            end if;
            if scoped then
                execute 'select public.can_see_job($1)' into visible using jsid;
                if not coalesce(visible, false) then
                    n_skip := n_skip + 1;
                    continue;
                end if;
            end if;

            -- office_set is the one read of the money and acceptance columns:
            -- a yes/no, never written, never returned.
            select c.id, c.job_sync_id, c.description, c.additional_feet, c.signed_at,
                   c.signature_storage_path, c.deleted_at,
                   (c.additional_cost <> 0 or c.material_cost <> 0 or c.in_accepted_total) as office_set
              into cur
              from public.change_orders c
             where c.company_id = co and c.sync_id = sid
             for update;

            if found then
                -- Same job, not tombstoned; otherwise leave it exactly as it is.
                if cur.deleted_at is not null or cur.job_sync_id is distinct from jsid then
                    n_skip := n_skip + 1;
                    continue;
                end if;
                -- The terms are the crew's until the office prices the order,
                -- an accepted price takes it in, or the customer signs it.
                terms_held := cur.signed_at is not null or cur.office_set;
                -- A signature is for the terms the phone showed. Held terms
                -- that differ mean a stale copy: attach nothing.
                if terms_held and cur.signed_at is null and v_signed is not null
                   and (coalesce(v_desc, cur.description) is distinct from cur.description
                        or coalesce(v_feet, cur.additional_feet) is distinct from cur.additional_feet) then
                    n_skip := n_skip + 1;
                    continue;
                end if;
                w_desc := case when terms_held then cur.description else coalesce(v_desc, cur.description) end;
                w_feet := case when terms_held then cur.additional_feet else coalesce(v_feet, cur.additional_feet) end;
                w_signed := coalesce(cur.signed_at, v_signed);
                w_path := coalesce(nullif(cur.signature_storage_path, ''), v_sigpath, cur.signature_storage_path);
                -- Nothing to change: write nothing (no touch, no audit, no
                -- realtime event for a copy re-sent on every pass).
                if (w_desc, w_feet, w_signed, w_path) is not distinct from
                   (cur.description, cur.additional_feet, cur.signed_at, cur.signature_storage_path) then
                    n_same := n_same + 1;
                    continue;
                end if;
                update public.change_orders c set
                    description = w_desc,
                    additional_feet = w_feet,
                    signed_at = w_signed,
                    signature_storage_path = w_path
                 where c.id = cur.id;
                n_upd := n_upd + 1;
            else
                -- Money is not named: the column defaults hold it at zero,
                -- and the insert trigger zeroes it again for an untrusted caller.
                insert into public.change_orders
                    (company_id, sync_id, job_sync_id, description, additional_feet,
                     signed_at, signature_storage_path)
                values (co, sid, jsid, coalesce(v_desc, ''), coalesce(v_feet, 0),
                        v_signed, v_sigpath)
                on conflict (company_id, sync_id) do nothing;
                get diagnostics n = row_count;
                if n = 1 then
                    n_ins := n_ins + 1;
                else
                    -- Another push landed the same order a moment ago; the
                    -- next sync sends it again and takes the update path.
                    n_skip := n_skip + 1;
                end if;
            end if;
        exception when data_exception or check_violation then
            -- check_violation: a table CHECK (the feet one, or any added
            -- later) refuses the row; it must not refuse the batch.
            n_skip := n_skip + 1;
        end;
    end loop;

    return jsonb_build_object('inserted', n_ins, 'updated', n_upd, 'unchanged', n_same, 'skipped', n_skip);
end $fn$;

comment on function public.crew_push_change_orders(jsonb) is
  'Crew change-order push (the table upsert is refused by the SEE_MONEY read policy). '
  'Writes only description/additional_feet (until the office prices it, an accepted price takes it in, '
  'or it is signed) and signed_at/signature_storage_path (write-once, validated); never money, never deletes. '
  'Skips rows for other companies, deleted or unseen jobs, tombstoned orders, orders on another job, '
  'feet that are negative or not finite, and a signature arriving with terms other than the ones held. '
  'Refuses the call when job scope is present without can_see_job(uuid). '
  'Returns {inserted, updated, unchanged, skipped}. supabase_r6_crew_change_orders.sql';

revoke all on function public.crew_push_change_orders(jsonb) from public, anon;
grant execute on function public.crew_push_change_orders(jsonb) to authenticated, service_role;

-- ============================================================
-- Self-check. Fails the run rather than leaving a phone to find out.
-- ============================================================
do $check$
declare
    fn regprocedure := 'public.crew_push_change_orders(jsonb)'::regprocedure;
    body text := pg_get_functiondef('public.crew_push_change_orders(jsonb)'::regprocedure);
    -- The ONE place the body may name a money or acceptance column: a read,
    -- inside the select that locks the order. Pinned verbatim, so a write
    -- (a SET, an INSERT column, a second mention of any kind) fails below.
    office_read constant text := '(c.additional_cost <> 0 or c.material_cost <> 0 or c.in_accepted_total) as office_set';
    stripped text;
    hit text;
    n int;
begin
    if has_function_privilege('anon', fn, 'execute') then
        raise exception 'crew_push_change_orders is executable by anon';
    end if;
    if exists (select 1 from pg_proc p, aclexplode(p.proacl) a where p.oid = fn and a.grantee = 0) then
        raise exception 'crew_push_change_orders is executable by PUBLIC';
    end if;
    if not has_function_privilege('authenticated', fn, 'execute') then
        raise exception 'crew_push_change_orders is not executable by authenticated';
    end if;
    if not (select p.prosecdef from pg_proc p where p.oid = fn) then
        raise exception 'crew_push_change_orders is not SECURITY DEFINER';
    end if;

    -- The freeze reads the office's price exactly once ...
    n := (length(body) - length(replace(body, office_read, ''))) / length(office_read);
    if n <> 1 then
        raise exception 'crew_push_change_orders: the priced/accepted read appears % times, not once -- '
                        'without it a crew phone rewrites the terms the office priced', n;
    end if;
    -- ... and, that read aside, names nothing the crew may not set. (A text
    -- scan cannot see a column spelled through dynamic SQL; the probe's 9x
    -- rows, run with the money triggers off, catch a write however spelled.)
    stripped := replace(body, office_read, '');
    select string_agg(t, ', ') into hit
      from unnest(array['additional_cost', 'material_cost', 'in_accepted_total', 'deleted_by']) t
     where position(t in stripped) > 0;
    if hit is not null or stripped ~ 'deleted_at\s*=' then
        raise exception 'crew_push_change_orders names a column the crew may not set: %',
            coalesce(hit, 'deleted_at =');
    end if;

    -- Every column it reads or writes exists (a rename would otherwise fail
    -- every push at run time, as a skipped row the phone never reports).
    select string_agg(t, ', ') into hit
      from unnest(array['company_id', 'sync_id', 'job_sync_id', 'description', 'additional_feet',
                        'signed_at', 'signature_storage_path', 'deleted_at',
                        'additional_cost', 'material_cost', 'in_accepted_total']) t
     where not exists (select 1 from information_schema.columns c
                        where c.table_schema = 'public' and c.table_name = 'change_orders'
                          and c.column_name = t);
    if hit is not null then
        raise exception 'change_orders has no column: %', hit;
    end if;

    -- The ON CONFLICT target.
    if not exists (select 1 from pg_index i
                    where i.indrelid = 'public.change_orders'::regclass and i.indisunique
                      and (select array_agg(a.attname::text order by k.ord)
                             from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
                             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
                          = array['company_id', 'sync_id']) then
        raise exception 'change_orders has no unique (company_id, sync_id) index';
    end if;

    -- Not loosened: the crew are still kept out of the table itself.
    if not exists (select 1 from pg_policies p
                    where p.schemaname = 'public' and p.tablename = 'change_orders'
                      and p.policyname = 'change_orders_money_hidden_from_crew'
                      and p.permissive = 'RESTRICTIVE' and p.cmd = 'SELECT') then
        raise exception 'change_orders_money_hidden_from_crew is gone -- this RPC assumes the table stays closed to crew';
    end if;
end $check$;

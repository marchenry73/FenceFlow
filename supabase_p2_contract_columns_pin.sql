-- P2-4 (P1): the signed contract stops being writable by people who cannot
-- edit jobs -- and two columns a phone never meant to assert stop being
-- overwritten by its own defaults.
--
-- WHAT WAS OPEN (all four reproduced live in supabase_p2_probe_before.sql):
--
--  1. CREW forges the acceptance signature. The 17 Sep fix made the signature
--     FILE write-once (job_files_signatures_are_write_once, `for update` only),
--     but the JOB'S POINTER to it stayed crew-writable and the folder stayed
--     open to INSERT -- so a crew phone plants a new file beside the real one
--     and repoints the job at it. crew_save_job()'s drop list was
--     job_money_columns() plus seven bookkeeping columns, which left
--     signature_storage_path, signed_at, signed_linear_feet and the sign-off
--     pair writable to anything holding RECORD_FIELD_WORK -- CREW's only
--     permission. The office treats the signature as the contract
--     (dashboard.html:7362) and reads signed_at for "No signature on file"
--     (dashboard.html:12570).
--
--  2. ACCOUNTANT reaches the same outcome by a direct UPDATE: SEE_MONEY gets
--     past the RESTRICTIVE jobs_money_hidden_from_crew policy to the base
--     table, and ACCOUNTANT has no EDIT_JOBS. Probed: 1 row, signed_at
--     CLEARED. Making ACCOUNTANT read-only on jobs wholesale is an owner's
--     decision and is NOT taken here; the columns are pinned instead, which
--     closes that path without deciding anything else about the role.
--
--  3. Every ordinary crew push blanked the re-approval state. CloudJob's
--     reapproval_reason ("") and reapproval_count (0) are non-null defaults and
--     SyncJson sets encodeDefaults=true, so they are on the wire in EVERY push
--     -- as an assertion, though the phone never held a value.
--     hold_reapproval_columns() does not stop it: that trigger is deliberately
--     INVOKER and only pins when current_user is authenticated/anon, and
--     inside SECURITY DEFINER crew_save_job current_user is postgres. Probed:
--     "DO NOT BUILD: layout changed" | 2  ->  <BLANKED> | 0. So the office
--     could raise a re-approval and the crew's next sync erased the reason for
--     it and reset the count.
--
--  4. The same shape erased the fixture flag: is_test_fixture is a false
--     default on the wire, so a phone holding one of the ZZ TEST rows pushed
--     it back as a real job. Probed: <CLEARED>.
--
-- HOW IT IS CLOSED
--
-- A BEFORE INSERT OR UPDATE trigger pins the contract columns for any API
-- caller without EDIT_JOBS -- which covers crew_save_job(), a direct UPDATE,
-- and anything added later -- and crew_save_job additionally drops the keys a
-- phone has no business asserting at all. Two layers on purpose: the trigger
-- is the guard, the drop list means an honest phone never even makes the
-- claim. The pin HOLDS rather than raises, for the same reason
-- protect_customer_identity() holds: a crew phone pushes the whole job row,
-- and refusing would throw away a day of field work over a column it only
-- echoed back.
--
-- THE ONE DELIBERATE CARVE-OUT: final_sign_off_storage_path / final_sign_off_at
-- are write-ONCE, not pinned outright. The final sign-off is a genuine crew
-- feature -- CrewJobScreen's FinalSignOffCard, offered only while
-- finalSignOffImagePath is null, captured by CrewJobViewModel.captureFinalSignOff
-- and uploaded by JobFileUploader -- so pinning them outright would silently
-- break the crew's own closing signature (crew_save_job would still return
-- true; the column simply would not move, which is the worst kind of break).
-- Write-once matches the UI exactly: null -> value is allowed once, and after
-- that the value can be neither changed nor cleared by a caller without
-- EDIT_JOBS. That closes the repoint and the clear, which are the attacks.
-- What it does NOT close is a crew member planting a file and setting the
-- sign-off pointer on a job that has none yet -- indistinguishable from the
-- legitimate capture at this layer. Closing that needs the storage-side fix
-- (job_files_signatures_are_insert_once on storage.objects) plus a definer RPC
-- that writes the object and the pointer together; neither is in this track.
-- The ACCEPTANCE signature has no such carve-out: the only screen that
-- captures it (EstimateScreen -> captureSignature) is behind
-- AccessGuard(session.canSeeMoney), so no CREW or FOREMAN phone can reach it
-- and nothing legitimate is lost.

-- The contract-evidence columns, named once. Sits beside job_money_columns()
-- for the same reason that exists: a list written twice is a list that drifts.
create or replace function public.job_contract_columns() returns text[]
 language sql immutable
as $function$
    select array[
        -- The acceptance signature: the customer agreeing to a price and a
        -- length. Pinned outright below.
        'signature_storage_path', 'signed_at', 'signed_linear_feet',
        -- The completion sign-off: the customer agreeing the work was done.
        -- Write-once below, because the crew legitimately captures this one.
        'final_sign_off_storage_path', 'final_sign_off_at'
    ]
$function$;

comment on function public.job_contract_columns() is
  'Columns that are evidence of a signed contract. hold_contract_columns() pins '
  'them for any API caller without EDIT_JOBS. Adding a column here without '
  'adding it to that trigger fails the self-check at the end of '
  'supabase_p2_contract_columns_pin.sql.';

create or replace function public.hold_contract_columns() returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    -- Same three-way exemption protect_customer_identity() uses, and for the
    -- same reasons. No request context at all is a direct connection (a
    -- migration, a backup, psql) -- judging it as an unprivileged caller is
    -- what quietly reverted maintenance writes before. is_service_role() asks
    -- whether the caller IS the backend rather than inferring it from a
    -- missing auth.uid(), which is also what anon looks like.
    claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
    if claims is null
       or public.is_service_role()
       or public.has_permission('EDIT_JOBS') then
        return new;
    end if;

    if tg_op = 'UPDATE' then
        -- Held, not refused: a crew phone pushes the whole row, so an honest
        -- push sends back exactly what it pulled from jobs_crew and this is a
        -- no-op. Only a CHANGED value is stopped.
        new.signature_storage_path := old.signature_storage_path;
        new.signed_at              := old.signed_at;
        new.signed_linear_feet     := old.signed_linear_feet;

        -- Write-once. See the header: the crew really does capture this one,
        -- once, and the UI offers the button only while it is empty.
        if old.final_sign_off_storage_path is not null then
            new.final_sign_off_storage_path := old.final_sign_off_storage_path;
        end if;
        if old.final_sign_off_at is not null then
            new.final_sign_off_at := old.final_sign_off_at;
        end if;
    else
        -- A job cannot arrive already signed from a caller who may not edit
        -- jobs. Same shape as hold_money_columns()'s INSERT branch.
        new.signature_storage_path      := null;
        new.signed_at                   := null;
        new.signed_linear_feet          := 0;
        new.final_sign_off_storage_path := null;
        new.final_sign_off_at           := null;
    end if;
    return new;
end;
$function$;

-- Named 00_ so it runs with the other pins and BEFORE 10_reapproval_resolve,
-- which decides whether a re-approval is resolved. A caller who may not write
-- the signature must not be able to influence that decision with one.
drop trigger if exists "00_hold_contract_columns" on public.jobs;
create trigger "00_hold_contract_columns"
    before insert or update on public.jobs
    for each row execute function public.hold_contract_columns();

-- crew_save_job: the live body, unchanged except for the drop list.
create or replace function public.crew_save_job(row_in jsonb)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    co uuid := public.current_company_id();
    drop_keys text[] := public.job_money_columns()
        -- The acceptance signature. Derived from job_contract_columns() rather
        -- than retyped, minus the final sign-off pair, which a crew phone
        -- legitimately writes once -- hold_contract_columns() governs those.
        || (select coalesce(array_agg(c), '{}'::text[])
              from unnest(public.job_contract_columns()) c
             where c <> all (array['final_sign_off_storage_path', 'final_sign_off_at']))
        -- Office state a phone only ever echoes as a DEFAULT. CloudJob gives
        -- reapproval_reason "" and reapproval_count 0, and is_test_fixture
        -- false, and SyncJson has encodeDefaults=true -- so every push carried
        -- all three as assertions and this function wrote them, blanking a
        -- live "do not build yet" and turning an office test row back into a
        -- real job. reapproval_required_at is listed for completeness: it is a
        -- null default today and explicitNulls=false drops it from the
        -- payload, which is the only reason "do not build yet" survived at all.
        || array['reapproval_required_at', 'reapproval_reason', 'reapproval_count',
                 'is_test_fixture']
        || array['id', 'company_id', 'local_id', 'created_at', 'updated_at', 'deleted_at', 'deleted_by'];
    clean jsonb := coalesce(row_in, '{}'::jsonb) - drop_keys;
    cols text[];
    n int;
begin
    if auth.uid() is null or co is null then
        raise exception 'Not signed in' using errcode = '42501';
    end if;
    if public.company_is_suspended() then
        raise exception 'Company suspended' using errcode = '42501';
    end if;
    if not (public.has_permission('RECORD_FIELD_WORK') or public.has_permission('EDIT_JOBS')) then
        raise exception 'Not allowed to write jobs' using errcode = '42501';
    end if;
    if clean->>'sync_id' is null then
        raise exception 'sync_id required';
    end if;

    -- Present keys that are real, non-money columns. An omitted key leaves
    -- the column alone; a column added to jobs tomorrow is writable here
    -- without editing this function; a new MONEY column is kept out by
    -- adding it to job_money_columns().
    select array_agg(c.column_name::text order by c.ordinal_position) into cols
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'jobs'
       and c.column_name <> all(drop_keys)
       and c.column_name <> 'sync_id'
       and clean ? c.column_name::text;
    if cols is null then
        return true;
    end if;

    execute format(
        'update public.jobs j set (%s) = (select %s from jsonb_populate_record(j, $1) r)
          where j.company_id = $2 and j.sync_id = ($1->>''sync_id'')::uuid and j.deleted_at is null',
        (select string_agg(quote_ident(k), ', ') from unnest(cols) k),
        (select string_agg('r.' || quote_ident(k), ', ') from unnest(cols) k))
    using clean, co;
    get diagnostics n = row_count;
    return n > 0;
end $function$;

-- Self-checks. Each one is a way this patch could look applied and not be.
do $check$
declare
    body text := pg_get_functiondef('public.hold_contract_columns()'::regprocedure);
    missing text;
begin
    -- Drift guard: every column job_contract_columns() names must actually be
    -- handled by the trigger. This is the "one list, read back" rule -- a list
    -- that grows while the code that walks it does not is how the backup table
    -- list ended up 13 tables behind.
    select string_agg(c, ', ') into missing
      from unnest(public.job_contract_columns()) c
     where position('new.' || c in body) = 0;
    if missing is not null then
        raise exception 'hold_contract_columns() does not handle: %', missing;
    end if;

    if not exists (
        select 1 from pg_trigger t
         where t.tgrelid = 'public.jobs'::regclass
           and not t.tgisinternal
           and t.tgname = '00_hold_contract_columns') then
        raise exception '00_hold_contract_columns is not attached to public.jobs';
    end if;

    -- The carve-out must still BE a carve-out: if the final sign-off pair ever
    -- lands in crew_save_job's drop list, the crew's closing signature dies
    -- silently (the RPC still returns true).
    body := pg_get_functiondef('public.crew_save_job(jsonb)'::regprocedure);
    if position('final_sign_off_storage_path'', ''final_sign_off_at' in body) = 0 then
        raise exception 'crew_save_job no longer carves out the final sign-off pair';
    end if;
    foreach missing in array array['reapproval_reason', 'reapproval_count', 'is_test_fixture'] loop
        if position(missing in body) = 0 then
            raise exception 'crew_save_job no longer drops %', missing;
        end if;
    end loop;
end $check$;

-- P2-1 (P0) and P2-2 (P1): jobs_crew stops handing test jobs to the field, and
-- starts carrying the re-approval state.
--
-- P0: jobs.is_test_fixture was filtered on the PHONE only
-- (JobSync.kt:448-450), and jobs_crew has never carried that column -- so
-- CloudJob.isTestFixture decoded as its Kotlin default `false` for every row a
-- crew or foreman handset pulled, the filter matched nothing, and 10 of the 19
-- production jobs (ZZ TEST rows, 3 companies) landed on those phones as
-- ordinary work. Filtered here instead: a WHERE clause on the view cannot be
-- undone by a DTO default, a stale build, or an app-side regression.
--
-- P1: the same view omitted reapproval_required_at / reapproval_reason /
-- reapproval_count. CloudJob declares all three with defaults and the merge
-- writes them straight onto the local row with no `?: local` fallback
-- (JobSync.kt:1027-1029, 1128-1130), so needsReapproval() was false on every
-- crew phone for ever and CrewJobScreen's "do not build yet" banner was dead
-- code on exactly the audience it was written for.
--
-- Everything else is identical to the live definition pulled with
-- pg_get_viewdef() before this file was written: the same 61 columns in the
-- same order, the same company/suspension filter, the same security_barrier.
-- The four new columns are appended at the END, which is what lets this be a
-- CREATE OR REPLACE rather than a DROP -- the grants (authenticated,
-- service_role) and the postgres ownership that lets a CREW session read the
-- view around the RESTRICTIVE jobs_money_hidden_from_crew policy all survive.
--
-- is_test_fixture is exposed as well as filtered on purpose. It is always
-- false through this view now, and that is the point: the phone's own choke
-- point keeps working on a column that really exists, and a test can read the
-- view's column list and fail if the app ever filters on one it does not
-- carry. The server-side WHERE is the guard; the column is the belt.

create or replace view public.jobs_crew with (security_barrier = true) as
 SELECT id,
    company_id,
    customer_id,
    local_id,
    customer_name,
    address,
    phone,
    email,
    notes,
    status,
    referral_source,
    scheduled_date,
    estimated_duration_hours,
    assigned_employee_id,
    teardown_enabled,
    hoa_name,
    hoa_email,
    hoa_approval_status,
    permit_number,
    permit_status,
    signed_at,
    updated_at,
    created_at,
    sync_id,
    waste_percent,
    blocked_reason,
    customer_must_clear,
    duration_manually_set,
    survey_storage_path,
    signature_storage_path,
    signed_linear_feet,
    final_sign_off_storage_path,
    final_sign_off_at,
    deleted_at,
    deleted_by,
    material_prices_confirmed_at,
    grid_extent_ft,
    locate_ticket_no,
    locate_called_at,
    locate_dig_after,
    locate_expires_at,
    locate_notes,
    overrun_reason,
    teardown_feet,
    assigned_employee_sync_id,
    grid_feet_per_square,
    calibration_pixels_per_foot,
    calibration_known_feet,
    blocked_at,
    customer_notified_at,
    preferred_manufacturer_sync_id,
    quote_approved_at,
    quote_approved_name,
    site_lat,
    site_lon,
    build_template_sync_id,
    wizard_step,
    priced_by,
    priced_at,
    pricing_engine_version,
    production_stage,
    -- New, appended so CREATE OR REPLACE is legal. None of the four is a money
    -- column (job_money_columns() checked), so none of them reaches the field
    -- through a door that is meant to carry no price.
    is_test_fixture,
    reapproval_required_at,
    reapproval_reason,
    reapproval_count
   FROM jobs
  WHERE company_id = current_company_id()
    AND NOT company_is_suspended()
    AND NOT COALESCE(is_test_fixture, false);

comment on view public.jobs_crew is
  'Money-free job door for CREW and FOREMAN phones. Test fixtures are excluded '
  'HERE, not on the phone -- the client-side filter could never work because '
  'this view did not carry is_test_fixture. Re-approval columns are carried so '
  '"do not build yet" can reach the field. Column list is an allowlist: adding '
  'a money column to jobs must not add it here.';

-- Self-check. A view that silently lost a column or its security_barrier is
-- the failure this whole file exists to stop, so it fails here rather than on
-- a phone.
do $check$
declare
    missing text;
    barrier boolean;
begin
    select string_agg(w, ', ') into missing
      from unnest(array['is_test_fixture','reapproval_required_at',
                        'reapproval_reason','reapproval_count','signed_at',
                        'production_stage','sync_id']) w
     where not exists (
        select 1 from information_schema.columns c
         where c.table_schema = 'public' and c.table_name = 'jobs_crew'
           and c.column_name = w);
    if missing is not null then
        raise exception 'jobs_crew is missing: %', missing;
    end if;

    select 'security_barrier=true' = any(coalesce(c.reloptions, '{}'::text[])) into barrier
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'jobs_crew';
    if not barrier then
        raise exception 'jobs_crew lost security_barrier';
    end if;

    -- No money column may have crept in behind the rename of anything above.
    select string_agg(c.column_name, ', ') into missing
      from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'jobs_crew'
       and c.column_name = any(public.job_money_columns());
    if missing is not null then
        raise exception 'jobs_crew now exposes money columns: %', missing;
    end if;
end $check$;

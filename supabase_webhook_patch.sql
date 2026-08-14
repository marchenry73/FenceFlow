-- ============================================================
-- FenceFlow -- fire the push function when a job changes
--
-- A "Database Webhook" in the Supabase UI is really just a trigger that
-- calls supabase_functions.http_request(). Creating it directly in SQL
-- works regardless of where the dashboard has moved the button to.
--
-- BEFORE RUNNING: replace YOUR_SERVICE_ROLE_KEY below with the service_role
-- key from Project Settings -> API Keys. It stays inside your own database,
-- which is exactly where the dashboard would have put it anyway.
-- ============================================================

-- pg_net is what lets Postgres make outbound HTTP calls.
create extension if not exists pg_net with schema extensions;

-- Supabase provisions this schema for webhooks; create it if this project
-- has never had one.
create schema if not exists supabase_functions;

drop trigger if exists job_change_push on jobs;

create trigger job_change_push
    after insert or update on jobs
    for each row
    execute function supabase_functions.http_request(
        'https://newcrgafcptspmapacrx.supabase.co/functions/v1/notify-job-change',
        'POST',
        '{"Content-Type":"application/json","Authorization":"Bearer YOUR_SERVICE_ROLE_KEY"}',
        '{}',
        '5000'
    );

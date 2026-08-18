-- Narrow the push trigger so it stops firing on every write.
--
-- It fired on INSERT OR DELETE OR UPDATE, meaning every sync pass that
-- touched a job -- a payment landing, a stamp being written, a device
-- pushing an unchanged row -- sent a push notification. That is the second
-- source of the notification burst; the app side was only half of it.
--
-- Now: new jobs, and the two updates worth telling somebody about. DELETE is
-- dropped entirely -- deletes are tombstoned UPDATEs now, and nobody needs a
-- push saying something disappeared.
--
-- Rebuilt from the live definition rather than retyped, so the endpoint and
-- headers are byte-identical and only the firing condition changes.

-- The Authorization header below is redacted on purpose: the live definition
-- carries a service_role JWT and this repo is public. Rebuild it from the
-- dashboard, or read the current definition with pg_get_triggerdef.

drop trigger if exists "job-change-push" on public.jobs;

CREATE TRIGGER "job-change-push" AFTER INSERT OR UPDATE OF status, assigned_employee_id ON public.jobs FOR EACH ROW WHEN (pg_trigger_depth() = 0) EXECUTE FUNCTION supabase_functions.http_request('https://newcrgafcptspmapacrx.supabase.co/functions/v1/notify-job-change', 'POST', '{"Content-type":"application/json","Authorization":"Bearer REDACTED_SERVICE_ROLE_KEY_SEE_SUPABASE_DASHBOARD"}', '{}', '5000');

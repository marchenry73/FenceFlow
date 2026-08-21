-- Marking a bug handled.
--
-- Grouped by message and screen, so pressing it once clears all twenty copies
-- of the same crash rather than making you tick them off one at a time.
create or replace function public.admin_mark_errors_seen(msg text, wh text)
returns void
language sql security definer set search_path = public as $$
    update app_errors
       set seen = true
     where is_platform_admin()
       and message = msg
       and where_at = wh;
$$;

select 'mark-seen installed' as done;

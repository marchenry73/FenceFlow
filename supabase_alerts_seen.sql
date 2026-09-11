-- Marking an alert seen, on every device that person uses.
--
-- The office console can already mark an alert seen, and it remembers that in
-- the browser. That is genuinely useful and genuinely limited: it lives on one
-- machine. An owner who clears the list at the desk opens the laptop that
-- evening and every one of them is back, which is exactly the behaviour that
-- teaches people to stop reading the list at all.
--
-- This puts it beside the mute preferences, which are already per person and
-- already work this way. Same table, same policies, one more column -- so
-- there is nothing new to secure and nothing new to keep in step.
--
-- Shape: {"stale_quote:<job sync id>": "<fingerprint>"}. The fingerprint is
-- whatever the page decided identifies THIS occurrence -- usually the job's
-- own updated_at. When the underlying thing changes, the fingerprint changes,
-- and the alert comes back rather than staying dismissed for ever. That is the
-- important half: "seen" must not mean "never tell me again".
alter table public.notification_prefs
  add column if not exists seen_alerts jsonb not null default '{}'::jsonb;

comment on column public.notification_prefs.seen_alerts is
  'Alerts this person has marked seen, keyed by alert and job, valued by a fingerprint of the occurrence. A changed fingerprint brings the alert back.';

-- The row may not exist yet: muting is the only thing that creates one today,
-- and somebody can mark an alert seen without ever having muted anything. An
-- upsert through a function keeps that from being the page's problem, and
-- keeps the write scoped to the caller's own row without widening any policy.
create or replace function public.mark_alert_seen(alert_key text, fingerprint text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
    if auth.uid() is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    -- left() rather than a check constraint: a key long enough to matter is a
    -- bug in the caller, not something worth refusing a person's click over.
    insert into public.notification_prefs (user_id, seen_alerts)
    values (auth.uid(), jsonb_build_object(left(alert_key, 200), left(coalesce(fingerprint, ''), 200)))
    on conflict (user_id) do update
        set seen_alerts = public.notification_prefs.seen_alerts
                          || jsonb_build_object(left(alert_key, 200), left(coalesce(fingerprint, ''), 200)),
            updated_at = now();
end;
$$;

revoke execute on function public.mark_alert_seen(text, text) from public, anon;
grant  execute on function public.mark_alert_seen(text, text) to authenticated;

select 'alerts seen across devices' as done;

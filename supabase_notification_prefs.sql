-- Per-user "needs attention" alert preferences (launch audit §28).
--
-- The dashboard's exception detectors -- uncontacted lead, stale quote,
-- approved-with-no-deposit, still clocked in, unverified prices, scheduled
-- without materials, approved not signed, labour over quoted, dispute open --
-- are forced on every user today. An owner who does not do his own
-- scheduling does not want the materials alert, and an alert nobody wants
-- trains people to ignore all of them.
--
-- This is one row per user, holding the alert keys THAT USER has switched
-- off. It is deliberately keyed by user, not by company: muting an alert is a
-- personal "stop showing me this", not a company-wide policy, and it must
-- never affect what anyone else on the same panel sees. Purely additive --
-- no existing table, column or policy is touched.

create table if not exists public.notification_prefs (
    user_id       uuid primary key references public.profiles(id) on delete cascade,
    -- Alert keys this user has turned off, e.g. '{materials_missing,dispute_open}'.
    -- Absence of a row, or absence of a key in this array, means the alert is
    -- on -- so a brand-new user with no row yet sees every alert, same as
    -- before this table existed.
    muted_alerts  text[] not null default '{}',
    updated_at    timestamptz not null default now()
);

alter table public.notification_prefs enable row level security;

-- A user may read only their own row. No policy here ever lets anyone read
-- another user's prefs, and there is no company-scoped read at all -- these
-- are not company data.
drop policy if exists notification_prefs_own_select on public.notification_prefs;
create policy notification_prefs_own_select on public.notification_prefs
    for select using (user_id = auth.uid());

-- A user may create only their own row.
drop policy if exists notification_prefs_own_insert on public.notification_prefs;
create policy notification_prefs_own_insert on public.notification_prefs
    for insert to authenticated
    with check (user_id = auth.uid());

-- A user may update only their own row, and may not repoint it at somebody
-- else's user_id.
drop policy if exists notification_prefs_own_update on public.notification_prefs;
create policy notification_prefs_own_update on public.notification_prefs
    for update to authenticated
    using (user_id = auth.uid())
    with check (user_id = auth.uid());

select 'notification prefs installed' as done;

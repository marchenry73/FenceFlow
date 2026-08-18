-- Somewhere to say "there is a newer version".
--
-- An APK handed out directly has no update mechanism at all: whoever installs
-- it stays on that version forever unless somebody tells them to go and fetch
-- a new file. That is manageable with two phones and unmanageable with five
-- companies -- and the urgent case is exactly the one that matters, since a
-- money bug needs the fix to actually reach people.
--
-- Readable by anyone signed in: knowing the current version is not sensitive,
-- and every company needs it. Writable by nobody through the API -- releases
-- are published from the dashboard, so a compromised account cannot point the
-- whole customer base at an APK of its choosing.
create table if not exists app_releases (
  id uuid primary key default gen_random_uuid(),
  version_code integer not null unique,
  version_name text not null,
  -- What changed, in the words a fencing contractor would use. Shown verbatim.
  notes text not null default '',
  download_url text not null default '',
  -- True only when staying on an older version risks data or money. Used
  -- sparingly: an app that insists on updating for a colour change teaches
  -- people to ignore it.
  is_mandatory boolean not null default false,
  released_at timestamptz not null default now()
);

alter table app_releases enable row level security;

drop policy if exists app_releases_read on app_releases;
create policy app_releases_read on app_releases
  for select using (auth.role() = 'authenticated');

comment on table app_releases is
  'Latest available build. The app compares its own versionCode against this and offers the update. No write policy on purpose: publish from the dashboard.';

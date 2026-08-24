-- Knowing that an update exists should not require being logged in.
--
-- The release list was readable only by an authenticated role, and the phone
-- asks the moment the jobs screen appears -- which is before Supabase has
-- restored the token. A tokenless request is not refused with an error, it
-- comes back EMPTY, and empty is indistinguishable from "you are on the
-- latest version". The app then marked the question asked and never raised it
-- again for that run, so the update prompt simply stopped appearing.
--
-- There is nothing to protect here: version numbers, release notes, and a URL
-- to a file that already sits in a public bucket. The APK is public by
-- design -- that is how someone installs the app in the first place.
drop policy if exists app_releases_read on public.app_releases;
create policy app_releases_read on public.app_releases
    for select
    using (true);

grant select on public.app_releases to anon, authenticated;

select version_code, version_name from public.app_releases
 order by version_code desc limit 1;

-- Publishing a release now, and letting the phones have it later.
--
-- Today a release is visible the instant the row is written, so the only way
-- to control WHEN a crew gets interrupted is to be at the keyboard at that
-- moment. Nobody wants to hand every phone a new build at 4pm on a Friday
-- with two crews still on site.
--
-- The schedule is enforced in the READ POLICY, not in the app. That choice is
-- the whole point: every phone already in the field -- 1.421 and every build
-- before it -- asks for "any release with a version code above mine" and
-- takes the first row it gets. Those builds cannot be taught anything new.
-- Filtering on the server means they respect a schedule they know nothing
-- about, with no update required to get the feature. A client-side check
-- would only ever apply to phones that had already updated, which is exactly
-- the population that does not need it.
--
-- Purely additive: one nullable column, and a policy that can only ever
-- return FEWER rows than the one it replaces.

alter table app_releases
  add column if not exists available_from timestamptz;

comment on column app_releases.available_from is
  'When phones may first see this release. Null means immediately, which is what every release before this column did.';

-- Null means now, deliberately. Every existing row has null, so nothing that
-- is already out there changes behaviour, and a publish that says nothing
-- about timing keeps working exactly as it always has.
drop policy if exists app_releases_read on public.app_releases;
create policy app_releases_read on public.app_releases
    for select using (available_from is null or available_from <= now());

select 'scheduled releases installed' as done;

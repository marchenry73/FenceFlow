-- A release nobody can be shipped to by name yet.
--
-- §8 of the launch audit: version numbers, notes, history and a rollback
-- build already exist; what is missing is a staged path from a build just
-- made to a build everybody has. Today every release is "everyone, the
-- moment the row is written" -- available_from can delay that instant for
-- the whole fleet, but nothing can narrow WHO gets it first. There is one
-- Supabase project and a second is not something the owner has agreed to pay
-- for, so this cannot be a staging environment. It has to be a staging STATE
-- on the one release table that already exists.
--
-- Who can honestly be named as "the limited few"? The read policy on
-- app_releases is `using (true)` -- an anonymous phone, mid-launch, with no
-- session yet, asks the same question a signed-in one does, and the row it
-- gets back is filtered by nothing about who is asking. That request carries
-- no identity at all: no company, no user, nothing to check an allowlist
-- against. So an anonymous caller cannot honestly be included in a limited
-- audience, full stop -- there is no fact about it to test.
--
-- An AUTHENTICATED caller carries exactly one identity worth trusting:
-- auth.uid(), resolved to a company through profiles.company_id, the same
-- link admin_companies() and record_app_version() already use. Company is
-- therefore the only audience unit this schema can name honestly. Not
-- individual users -- a crew shares a company's risk tolerance for trying a
-- new build, and profiles already group by company everywhere else in this
-- schema (seat limits, billing, the drift table). Company is the existing
-- unit of trust; this reuses it rather than inventing a second one.
--
-- Consequence, stated plainly because it is a real cost: a phone that checks
-- for updates before its session is restored is, at that moment, exactly the
-- anonymous caller above -- it will not see a limited release even if its
-- own company is on the list. UpdateChecker.checkOnce() already retries up
-- to four times with a growing delay for this exact reason (it says so in
-- its own comment), so in practice the session is usually there by the time
-- it matters. When it is not, the phone simply sees no update this launch
-- and asks again next time -- the same "silence, never a wrong answer" rule
-- UpdateChecker already lives by. Nobody is shown an error and nobody is
-- blocked from the general release once it exists.

-- 'everyone' is the only value every row has ever meant, so it is the
-- default -- a migration that changes what a release with no opinion means
-- is exactly the kind of default this project's own rules forbid.
alter table public.app_releases
  add column if not exists audience text not null default 'everyone';

alter table public.app_releases
  drop constraint if exists app_releases_audience_check;
alter table public.app_releases
  add constraint app_releases_audience_check check (audience in ('everyone', 'limited'));

comment on column public.app_releases.audience is
  'everyone (default, and what every release before this column meant) or limited -- see app_release_audience for who.';

-- Which companies a 'limited' release goes to. A release with audience =
-- 'everyone' has no rows here and needs none; a 'limited' release with no
-- rows here is visible to nobody, which is a safe (if useless) state, not a
-- broken one -- it behaves like a release that was never published, and the
-- previous 'everyone' release keeps answering the app's query.
create table if not exists public.app_release_audience (
  release_id uuid not null references public.app_releases(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (release_id, company_id)
);

alter table public.app_release_audience enable row level security;

-- Nobody reads this through the API except a platform admin looking at who a
-- release went to. There is deliberately no insert/update/delete policy: rows
-- are written by the publish script over the CLI's own connection (the same
-- way app_releases rows themselves are written, with no write policy either),
-- and by admin_promote_release() below, which runs as the definer and does
-- not need one.
drop policy if exists app_release_audience_admin_read on public.app_release_audience;
create policy app_release_audience_admin_read on public.app_release_audience
    for select using (is_platform_admin());

-- Whether the CALLING company is on a release's limited list. A plain
-- exists() inside the app_releases policy below would run as the querying
-- role, and that role has no select grant on app_release_audience or
-- profiles -- the check would just fail closed for real audience members,
-- not merely for outsiders. Wrapped as security definer, the same shape as
-- company_allowed() and is_platform_admin(), so the membership check runs
-- with its own authority instead of borrowing (and needing) the caller's.
--
-- False for an anonymous caller by construction: auth.uid() is null, so the
-- join matches nothing. That is the "no identity, no audience" rule from the
-- comment above, enforced in code rather than only in prose.
create or replace function public.release_visible_to_caller(rid uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
    select exists (
        select 1
          from public.app_release_audience a
          join public.profiles p on p.company_id = a.company_id
         where a.release_id = rid
           and p.id = auth.uid()
    );
$$;
revoke all on function public.release_visible_to_caller(uuid) from public;
grant execute on function public.release_visible_to_caller(uuid) to anon, authenticated;

-- The read policy, extended rather than replaced in spirit: every clause that
-- was true before is still exactly as permissive as it was. A row that is
-- 'everyone' (every row before this patch, and every row after it that
-- doesn't opt in) passes exactly as it always has. A 'limited' row is new
-- territory -- it can only ever return to FEWER callers than before, the same
-- guarantee the scheduled-release policy made about available_from.
drop policy if exists app_releases_read on public.app_releases;
create policy app_releases_read on public.app_releases
    for select using (
        (available_from is null or available_from <= now())
        and (audience = 'everyone' or public.release_visible_to_caller(id))
    );

-- Promoting a release: the one deliberate, separate act that turns 'limited'
-- into 'everyone'. Nothing else does this -- there is no auto-promote on a
-- timer or a success count, because "this held up" is a judgment call, not a
-- number to threshold on.
--
-- Membership rows are cleared on promotion rather than left behind: once a
-- release is everyone's, "who was in the early group" is a fact about
-- history, not about access, and app_release_audience is not the place that
-- keeps history (app_releases.released_at already is).
create or replace function public.admin_promote_release(target_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
    if not public.is_platform_admin() then
        raise exception 'Only a FenceFlow admin may promote a release.';
    end if;

    update public.app_releases set audience = 'everyone' where id = target_id;
    delete from public.app_release_audience where release_id = target_id;
end;
$$;
revoke all on function public.admin_promote_release(uuid) from public, anon;
grant execute on function public.admin_promote_release(uuid) to authenticated;

-- Read-side helper for the console: which companies a limited release
-- currently goes to, by name rather than a bare uuid. A view rather than
-- widening app_release_audience's own policy, so the admin page has one
-- thing to query and the underlying table keeps its narrow shape.
-- security_invoker: without it, a view created by the CLI's own (table-owner)
-- connection runs with the OWNER's privileges and would bypass RLS on
-- app_release_audience entirely -- handing every mapping to any authenticated
-- caller, admin or not, which is precisely the leak the admin-only read
-- policy above exists to prevent. With it, the view runs as the querying
-- role, so is_platform_admin() is still the thing standing guard.
create or replace view public.admin_release_audience
    with (security_invoker = true) as
    select a.release_id, a.company_id, c.name as company_name
      from public.app_release_audience a
      join public.companies c on c.id = a.company_id;

grant select on public.admin_release_audience to authenticated;

-- Every existing release is unaffected: audience defaults to 'everyone',
-- which is exactly what "no opinion" already meant, so this must read back
-- as the number of rows in app_releases and zero rows limited.
select
  (select count(*) from public.app_releases) as releases_total,
  (select count(*) from public.app_releases where audience = 'everyone') as releases_everyone,
  (select count(*) from public.app_releases where audience = 'limited') as releases_limited;

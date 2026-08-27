-- One login, one phone at a time.
--
-- March's ask: people can sign in wherever they like, but a single login must
-- not quietly become two users sharing one seat. That is what seat limits are
-- for, and a shared login walks straight past them -- a Crew plan buys six
-- logins, and six logins shared two ways is twelve people for the price of six.
--
-- What this can and cannot do, honestly: it stops two phones being signed in
-- at the same time. It cannot stop two people taking turns on one handset, and
-- nothing could. Simultaneous use is the part worth enforcing, and the part
-- customers already expect to be enforced.
--
-- The NEWEST sign-in wins, which is what people expect and what makes losing a
-- phone survivable: sign in on the new one and the old one lets go. The
-- displaced phone is told why rather than simply failing.
--
-- The website is deliberately not a device. The office half of this product is
-- meant to be open on a computer while the same person's phone is in their
-- pocket, and treating that as a conflict would make the product unusable for
-- the one-person company it is mostly sold to.
alter table public.profiles
  add column if not exists active_device_id text,
  add column if not exists active_device_at timestamptz;

comment on column public.profiles.active_device_id is
  'The phone currently holding this login. Set by the app on sign-in; the website never claims it.';

-- Take the login for this phone. Whoever held it before is displaced.
create or replace function public.claim_device(device_id text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
    if auth.uid() is null then
        raise exception 'You must be signed in.';
    end if;
    if coalesce(trim(device_id), '') = '' then
        return;  -- nothing to claim with; leave whatever is there alone
    end if;
    update profiles
       set active_device_id = device_id,
           active_device_at = now()
     where id = auth.uid();
end;
$$;
revoke execute on function public.claim_device(text) from public, anon;
grant  execute on function public.claim_device(text) to authenticated;

-- Is this phone still the one? Called on every entitlement check.
--
-- Answers true when nothing has claimed the login yet, so an app that has not
-- yet been updated -- or a device that never claimed for any reason -- carries
-- on working rather than being locked out by a feature it does not know about.
create or replace function public.device_still_mine(device_id text)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
    select coalesce(
        (select p.active_device_id is null
             or p.active_device_id = device_id
           from profiles p where p.id = auth.uid()),
        true);
$$;
revoke execute on function public.device_still_mine(text) from public, anon;
grant  execute on function public.device_still_mine(text) to authenticated;

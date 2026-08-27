-- A contractor connects whichever payment processor they already use.
--
-- March's decision: Stripe and Square to begin with, and a shape that takes a
-- third without being rebuilt. Building "Stripe, then bolt Square on" produces
-- two half-integrations with different assumptions; building "a company has a
-- payment connection" costs barely more now and makes the third one small.
--
-- WHAT THIS REPLACES
-- companies.stripe_account_id was a single column for a single processor, and
-- create-payment-link currently REFUSES outright when it is set, because a
-- charge on a connected account raises its webhook on THAT account and the
-- platform endpoint never hears about it. That refusal stays until the webhook
-- side genuinely works. This is the structure underneath it.
--
-- WHERE THE SECRETS LIVE
-- Square's OAuth gives a per-merchant access token, and Stripe Connect gives an
-- account id. One of those is a credential that can move money and the other is
-- not, so they do not go in the same place as everything else the app reads.
--
-- No policy on this table grants SELECT to anybody. Not the owner, not a
-- platform admin, not anon. Row Level Security with no permissive policy denies
-- by default, so the only thing that can read a token is an edge function
-- holding the service role -- which is the only thing that should ever need to.
-- The app and both websites learn whether a company is connected, and to what,
-- through my_payment_connection() below, which never returns the token.
create table if not exists public.payment_connections (
    company_id      uuid primary key references public.companies(id) on delete cascade,
    processor       text not null default 'none',
    -- What the processor calls this merchant. A Stripe connected account id, or
    -- a Square merchant id. Not a secret on its own.
    external_id     text not null default '',
    -- Square hands over a token that expires and a refresh token. Stripe
    -- Connect does not need either. Null for a processor that has no such thing.
    access_token    text,
    refresh_token   text,
    token_expires_at timestamptz,
    -- What to show the contractor so they can tell it is the right account.
    display_name    text not null default '',
    connected_at    timestamptz,
    connected_by    uuid references auth.users(id),
    updated_at      timestamptz not null default now(),
    constraint payment_connections_processor_known
        check (processor in ('none','stripe','square'))
);

alter table public.payment_connections enable row level security;

-- Deliberately no policies. RLS with none denies everything, and the service
-- role bypasses RLS, so the backend can read what the customer cannot.
revoke all on public.payment_connections from anon, authenticated;

comment on table public.payment_connections is
  'One payment processor per company. No policy grants SELECT to anybody: only the service role reads this, because it holds tokens that can move money. Clients use my_payment_connection().';

-- What a contractor is allowed to know about their own connection.
--
-- Everything except the credential. Enough to show "Connected to Square as
-- Hank Fencing" and to decide which buttons to offer.
create or replace function public.my_payment_connection()
returns table(processor text, display_name text, connected boolean, connected_at timestamptz)
language sql stable security definer set search_path to 'public'
as $$
    select coalesce(pc.processor, 'none'),
           coalesce(pc.display_name, ''),
           coalesce(pc.processor, 'none') <> 'none'
             and coalesce(pc.external_id, '') <> '',
           pc.connected_at
      from companies c
      left join payment_connections pc on pc.company_id = c.id
     where c.id = (select company_id from profiles where id = auth.uid());
$$;
revoke execute on function public.my_payment_connection() from public, anon;
grant  execute on function public.my_payment_connection() to authenticated;

-- Choosing a processor is not the same as connecting one.
--
-- The contractor picks who they bank with; the actual connection is an OAuth
-- round trip the backend completes. This records the choice so the Billing tab
-- can show the right next step, and it deliberately cannot write a token --
-- that column is not reachable from here.
create or replace function public.choose_payment_processor(which text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
declare
    mine uuid;
begin
    select company_id into mine from profiles where id = auth.uid();
    if mine is null then
        raise exception 'You are not part of a business yet.';
    end if;
    if not exists (select 1 from profiles
                    where id = auth.uid() and role = 'OWNER') then
        raise exception 'Only the owner can choose how the business gets paid.';
    end if;
    if lower(coalesce(which,'')) not in ('none','stripe','square') then
        raise exception 'That is not a payment processor we support yet.';
    end if;

    insert into payment_connections (company_id, processor, updated_at)
    values (mine, lower(which), now())
    on conflict (company_id) do update
        set processor = lower(which),
            updated_at = now(),
            -- Switching processor drops the old connection rather than leaving
            -- a stale token pointing at an account we are no longer using.
            external_id = case when payment_connections.processor = lower(which)
                               then payment_connections.external_id else '' end,
            access_token = case when payment_connections.processor = lower(which)
                                then payment_connections.access_token else null end,
            refresh_token = case when payment_connections.processor = lower(which)
                                 then payment_connections.refresh_token else null end,
            display_name = case when payment_connections.processor = lower(which)
                                then payment_connections.display_name else '' end,
            connected_at = case when payment_connections.processor = lower(which)
                                then payment_connections.connected_at else null end;
end;
$$;
revoke execute on function public.choose_payment_processor(text) from public, anon;
grant  execute on function public.choose_payment_processor(text) to authenticated;

-- Carry across anything already connected, so nothing is lost by moving to the
-- new shape. No company has a stripe_account_id today, so this is a no-op now
-- and correct if that changes before it runs.
insert into payment_connections (company_id, processor, external_id, connected_at, updated_at)
select c.id, 'stripe', c.stripe_account_id, now(), now()
  from companies c
 where coalesce(c.stripe_account_id, '') <> ''
on conflict (company_id) do nothing;

-- A ledger of crew invitations, so the sender can be rate-limited.
--
-- invite-crew sends real mail from the business's own verified domain. It
-- had no cap at all: a signed-in office role (or a stolen office session)
-- could relay unlimited messages through fenceflowapp.com. The employees
-- table has no column to count against and inventing one on a synced table
-- would have rippled into every phone, so the count lives here, written
-- only by the function through one RPC. Nobody reads it from a client.

create table if not exists public.invite_sends (
    id          bigserial primary key,
    company_id  uuid not null references public.companies(id) on delete cascade,
    sent_by     uuid,
    email_hash  text not null default '',
    sent_at     timestamptz not null default now()
);
create index if not exists invite_sends_company_recent_idx
    on public.invite_sends (company_id, sent_at desc);
alter table public.invite_sends enable row level security;
-- No policies on purpose: only the SECURITY DEFINER function below touches it.

-- Records one send and answers with the company's count for the last hour,
-- this one included. The function refuses when the answer is over the cap.
create or replace function public.note_invite_send(p_email text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    co uuid := public.current_company_id();
    n integer;
begin
    if auth.uid() is null or co is null then
        raise exception 'Not signed in' using errcode = '42501';
    end if;
    if public.current_user_role()::text not in ('OWNER', 'MANAGER') then
        raise exception 'Office roles only' using errcode = '42501';
    end if;
    insert into public.invite_sends (company_id, sent_by, email_hash)
    values (co, auth.uid(), md5(lower(coalesce(p_email, ''))));
    select count(*) into n from public.invite_sends
     where company_id = co and sent_at > now() - interval '1 hour';
    return n;
end $$;
revoke execute on function public.note_invite_send(text) from public, anon;
grant  execute on function public.note_invite_send(text) to authenticated, service_role;

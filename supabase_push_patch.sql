-- ============================================================
-- FenceFlow -- PUSH NOTIFICATIONS PATCH
-- Run after the earlier patches, in: SQL Editor -> New query -> Run
--
-- Stores which phones belong to which crew member, so the server knows
-- where to send a push. A token addresses one specific phone; without
-- this table there is nowhere to deliver to.
-- ============================================================

create table if not exists device_tokens (
    token       text primary key,
    user_id     uuid not null references auth.users(id) on delete cascade,
    company_id  uuid references companies(id) on delete cascade,
    platform    text not null default 'android',
    updated_at  timestamptz not null default now()
);

create index if not exists device_tokens_company_idx on device_tokens (company_id);

alter table device_tokens enable row level security;

-- You may register and remove your own device. You may not read anyone
-- else's token -- a token is effectively a "send notifications to this
-- phone" capability, so it should not be readable across the team.
drop policy if exists device_tokens_own_select on device_tokens;
create policy device_tokens_own_select on device_tokens
    for select using (user_id = auth.uid());

drop policy if exists device_tokens_own_insert on device_tokens;
create policy device_tokens_own_insert on device_tokens
    for insert with check (user_id = auth.uid());

drop policy if exists device_tokens_own_update on device_tokens;
create policy device_tokens_own_update on device_tokens
    for update using (user_id = auth.uid());

drop policy if exists device_tokens_own_delete on device_tokens;
create policy device_tokens_own_delete on device_tokens
    for delete using (user_id = auth.uid());

-- Registers (or refreshes) the calling user's device token.
create or replace function register_device_token(device_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then
        raise exception 'Must be signed in to register a device.';
    end if;
    insert into device_tokens (token, user_id, company_id, updated_at)
        values (device_token, auth.uid(), current_company_id(), now())
    on conflict (token) do update
        set user_id    = excluded.user_id,
            company_id = excluded.company_id,
            updated_at = now();
end $$;

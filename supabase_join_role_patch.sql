-- Let someone say what they are when joining, without letting them decide it.
--
-- Picking your own role at join time would mean anyone holding the invite code
-- could join as a manager and read the company's money. But making the owner
-- guess who just appeared is its own problem -- a list of unnamed CREW rows
-- that somebody has to chase down.
--
-- So the person joining states the role they believe they have, it is recorded
-- as a REQUEST, and they land as CREW until the owner confirms it. The owner
-- sees "Marco joined, says he is a Foreman" and applies it in one tap.
alter table profiles
  add column if not exists requested_role text not null default '';

comment on column profiles.requested_role is
  'What this person said they were when joining. Not authoritative -- the owner confirms it before it becomes their role.';

create or replace function public.join_company(
  target_company_id uuid,
  member_name text,
  requested_role_in text default ''
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles
     set company_id = target_company_id,
         full_name = coalesce(nullif(member_name, ''), full_name),
         -- Always the lowest role, whatever they asked for. The request is
         -- recorded next to it for the owner to act on.
         role = 'CREW',
         requested_role = coalesce(nullif(requested_role_in, ''), '')
   where id = auth.uid();
end;
$$;

revoke all on function public.join_company(uuid, text, text) from public;
grant execute on function public.join_company(uuid, text, text) to authenticated;

-- Per-person access, enforced on the server and not only in the app.
--
-- Hiding a button stops an honest person making a mistake, which is most of the
-- value. It does not stop anyone who can reach the API with their own token,
-- and the rule worth actually enforcing -- who may change other people's access
-- -- is the one where being wrong is unrecoverable.
--
-- Stored as differences from the role ("+SEE_MONEY,-DELETE_RECORDS") rather
-- than as a resolved set, so changing what a role means later carries through
-- to everyone who was never specifically adjusted.

alter table profiles
  add column if not exists permission_overrides text not null default '';

comment on column profiles.permission_overrides is
  'Adjustments to the role: +PERMISSION grants, -PERMISSION revokes, comma separated. Empty means use the role default.';

-- Does the caller hold a permission? Mirrors the app's resolve(): the role's
-- defaults, plus grants, minus revocations, with revocation winning.
--
-- role is the user_role ENUM, so it is cast to text before comparison --
-- comparing an enum against a string literal that is not a member of the type
-- raises rather than returning false.
create or replace function public.has_permission(perm text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select role::text as role_text, coalesce(permission_overrides, '') as overrides
    from profiles where id = auth.uid()
  )
  select case
    -- Revocation wins over a grant for the same permission. A contradictory
    -- override should take access away rather than give it: someone asking to
    -- be let in is cheaper than someone quietly holding access nobody granted.
    when position('-' || perm in (select overrides from me)) > 0 then false
    when position('+' || perm in (select overrides from me)) > 0 then true
    else case (select role_text from me)
      when 'OWNER' then true
      when 'MANAGER' then perm in (
        'SEE_MONEY','EDIT_JOBS','EDIT_CATALOG_AND_SETTINGS','SCHEDULE_AND_ASSIGN',
        'REQUEST_PAYMENT','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT','SEE_REPORTS',
        'APPROVE_TIME','APPROVE_PLAN_CHANGES')
      when 'SALES' then perm in ('SEE_MONEY','EDIT_JOBS','SEE_CUSTOMER_CONTACT')
      when 'ACCOUNTANT' then perm in (
        'SEE_MONEY','REQUEST_PAYMENT','RECORD_REFUNDS','SEE_CUSTOMER_CONTACT','SEE_REPORTS')
      when 'FOREMAN' then perm in (
        'SCHEDULE_AND_ASSIGN','RECORD_FIELD_WORK','SEE_CUSTOMER_CONTACT')
      when 'CREW' then perm in ('RECORD_FIELD_WORK')
      else false
    end
  end;
$$;

revoke all on function public.has_permission(text) from public;
grant execute on function public.has_permission(text) to authenticated;

-- Tighten who may edit other people's profiles.
--
-- REPLACING the existing policy rather than adding one. Postgres ORs permissive
-- policies together, so an added policy can only ever widen access -- it cannot
-- restrict, which would have made this whole thing decorative.
--
-- The change: MANAGER no longer gets it automatically by job title; it now
-- takes MANAGE_ACCESS, which a manager still has by default but which can be
-- taken away from a specific person. The separate owner policy
-- (profiles_update_own_company) is deliberately left alone, so an owner can
-- never lock themselves out of their own company by misconfiguring this.
--
-- "id <> auth.uid()" is kept: nobody edits their own access, including the
-- person who manages everyone else's.
drop policy if exists profiles_manage on profiles;
create policy profiles_manage on profiles
  for update
  using (
    company_id = current_company_id()
    and public.has_permission('MANAGE_ACCESS')
    and id <> auth.uid()
  );

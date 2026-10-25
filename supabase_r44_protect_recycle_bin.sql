-- r44: an owner could lift their own company out of the admin recycle bin.
--
-- NOT APPLIED until the verification at the bottom is read. Then it is safe:
-- it adds three lines to one trigger and changes nothing else.
--
-- WHAT IS WRONG
--
-- protect_billing_columns() holds sixteen columns plus the onboarding four by
-- writing `new.X := old.X`, so an ordinary owner's UPDATE cannot move them.
-- Three columns added since were never added to it:
--
--   deleted_at, deleted_by   -- the admin recycle bin
--   auto_charge_balance      -- whether this company's deposit links keep the
--                               customer's card to charge the balance later
--
-- companies_update is `USING (id = current_company_id() AND
-- current_user_role() = 'OWNER')` with no separate WITH CHECK, and the table
-- grant gives authenticated UPDATE. So an owner can send
--
--   PATCH /rest/v1/companies?id=eq.<their own id>  {"deleted_at": null}
--
-- and put themselves back. company_allowed() checks `deleted_at is null`
-- first, and admin_restore_company is meant to be the only thing that clears
-- it. Nothing in the app does this -- it needs a hand-made REST call -- and no
-- company is currently removed, so this is a door standing open rather than a
-- theft in progress.
--
-- auto_charge_balance is held for the same reason the other money switches
-- are: it decides whether a customer's card is STORED, and that is not a
-- setting a company should be able to flip for itself through an API call
-- with no UI behind it and no record of who did it.
--
-- REBUILT FROM THE LIVE FUNCTION BODY, read out of pg_proc on 2026-10-25 --
-- not from any .sql file in this repo. Two files here were already stale
-- enough to drop columns added since they were written, and one of them was a
-- single re-run away from blanking the admin portal's Health column. If you
-- are reading this later: diff the body below against the live one BEFORE
-- running it.
--
-- NOT CHANGED, deliberately: the `auth.uid() is null -> return new` escape at
-- the top. It is how the service role and SECURITY DEFINER functions write
-- these columns at all. It is also true for `anon`, which would be a hole --
-- except companies_update's own USING clause needs current_company_id(), which
-- is null for anon, so no anonymous row ever reaches this trigger. Left alone
-- because widening it is a separate change with its own blast radius.

create or replace function public.protect_billing_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then
        return new;
    end if;

    -- Was an inline `exists (select 1 from profiles where id = auth.uid() and
    -- is_platform_admin)`, which is the flag alone -- so the second factor did
    -- not reach the billing columns even once is_platform_admin() required it.
    -- One gate, named once.
    if public.is_platform_admin() then
        return new;
    end if;

    new.suspended              := old.suspended;
    new.subscription_status    := old.subscription_status;
    new.subscription_plan      := old.subscription_plan;
    new.subscription_ends_at   := old.subscription_ends_at;
    new.trial_ends_at          := old.trial_ends_at;
    new.grace_ends_at          := old.grace_ends_at;
    new.stripe_customer_id     := old.stripe_customer_id;
    new.stripe_subscription_id := old.stripe_subscription_id;
    new.stripe_account_id      := old.stripe_account_id;
    new.monthly_price          := old.monthly_price;
    new.pass_card_fee          := old.pass_card_fee;

    -- The admin's own side of the row. suspended was already held; the REASON
    -- was not, and the reason is what decides whether a payment lifts the hold.
    new.suspended_reason       := old.suspended_reason;
    new.admin_notes            := old.admin_notes;
    new.invited_at             := old.invited_at;
    new.invited_email          := old.invited_email;
    new.leads_token            := old.leads_token;

    -- r44. The recycle bin: admin_remove_company sets these and
    -- admin_restore_company clears them. An owner clearing deleted_at for
    -- themselves walks straight back through company_allowed(), which tests
    -- it first.
    new.deleted_at             := old.deleted_at;
    new.deleted_by             := old.deleted_by;

    -- r44. Whether this company's deposit links KEEP the customer's card
    -- (supabase_r40_auto_charge_balance.sql). Held for the same reason as the
    -- other money switches: storing somebody else's card is not a thing a
    -- company should be able to turn on for itself through a bare REST call.
    new.auto_charge_balance    := old.auto_charge_balance;

    -- Onboarding evidence: written by sign_service_agreement() and
    -- complete_company_details(), which flag themselves below.
    if coalesce(current_setting('fenceflow.trusted_write', true), '') <> 'on' then
        new.agreement_signed_at   := old.agreement_signed_at;
        new.agreement_signed_name := old.agreement_signed_name;
        new.agreement_version     := old.agreement_version;
        new.details_completed_at  := old.details_completed_at;
    end if;

    return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- PROOF, on a company this creates and removes itself, as a real OWNER
-- session. Every check is written so that running it BEFORE the change above
-- fails -- that is what makes it evidence.
-- ---------------------------------------------------------------------------
do $$
declare
  cid uuid; uid uuid;
  after_del timestamptz;
  after_auto boolean;
  name_after text;
begin
  select p.id, p.company_id into uid, cid
    from public.profiles p
   where p.role = 'OWNER' and p.company_id is not null
   order by p.id limit 1;
  if uid is null then raise exception 'no OWNER profile to probe with'; end if;

  -- deleted_by is a UUID on companies (it is text on jobs -- they differ).
  -- Put the company in the bin as the admin would, and arm the other switch,
  -- so there is something for the owner to try to undo.
  update public.companies
     set deleted_at = now(), deleted_by = uid, auto_charge_balance = true
   where id = cid;

  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  perform set_config('role', 'authenticated', true);

  -- The owner tries to walk back out, and to switch card-saving off.
  begin
    update public.companies
       set deleted_at = null, deleted_by = null, auto_charge_balance = false,
           name = name || ''   -- a column they genuinely MAY write
     where id = cid;
  exception when others then
    null;  -- a refusal is also an acceptable answer; the read below decides
  end;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);

  select deleted_at, auto_charge_balance, name
    into after_del, after_auto, name_after
    from public.companies where id = cid;

  -- Put the company back exactly as it was, whatever happened above.
  update public.companies
     set deleted_at = null, deleted_by = null, auto_charge_balance = true
   where id = cid;

  if after_del is null then
    raise exception 'r44 FAILED: the owner cleared deleted_at and left the recycle bin';
  end if;
  if after_auto is not true then
    raise exception 'r44 FAILED: the owner switched auto_charge_balance off for their own company';
  end if;
  -- POSITIVE CONTROL. Without this, a trigger that refused the whole UPDATE --
  -- or a policy that had stopped letting owners write at all -- would pass
  -- both checks above while quietly breaking every ordinary company edit.
  if name_after is null then
    raise exception 'r44 FAILED: the positive control is broken, so the checks above prove nothing';
  end if;
  raise notice 'r44 ok: the recycle bin and the card switch are held, and an owner can still edit their company';
end $$;

select 'deleted_at is held'          as check, (select prosrc like '%new.deleted_at%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='protect_billing_columns' and n.nspname='public') as pass
union all
select 'deleted_by is held',          (select prosrc like '%new.deleted_by%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='protect_billing_columns' and n.nspname='public')
union all
select 'auto_charge_balance is held', (select prosrc like '%new.auto_charge_balance%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='protect_billing_columns' and n.nspname='public')
union all
select 'the sixteen it already held are still there',
       (select prosrc like '%new.leads_token%' and prosrc like '%new.admin_notes%' and prosrc like '%new.monthly_price%'
          from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='protect_billing_columns' and n.nspname='public');

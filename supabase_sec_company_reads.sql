-- F7 (P2): every company member, CREW included, could read the whole companies
-- row (admin_notes, leads_token, stripe_customer_id) and the whole
-- company_settings blob (labor_rate, markup, min_job_charge, deposit_percent).
-- The second one quietly undoes the crew money-hiding for the pricing INPUTS:
-- the crew cannot see a total, but could read the labour rate and markup it is
-- built from.
--
-- Two halves, both additive:
--
--  a) companies: revoke SELECT on the platform's own columns. Nothing signed in
--     as a company member selects * from companies -- every caller names its
--     columns (dashboard: leads_token; welcome: name/phone/email/license_no;
--     admin.html: pass_card_fee; everything else goes through admin_companies(),
--     my_service_status() and my_onboarding(), which are SECURITY DEFINER and
--     so unaffected by a column grant). leads_token keeps its one legitimate
--     caller through my_leads_token() below.
--
--  b) company_settings: a RESTRICTIVE SELECT policy, with crew_settings() as
--     the money-free fallback -- the same shape employees/crew_roster() and
--     time_entries/time_entries_crew already use.

-- ---------- a) companies ----------

create or replace function public.my_leads_token()
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare t uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in.';
    end if;
    if public.current_user_role() not in ('OWNER', 'MANAGER') then
        raise exception 'Only an owner or manager can see the lead link.';
    end if;
    select leads_token into t from companies where id = public.current_company_id();
    return t;
end;
$function$;

grant execute on function public.my_leads_token() to authenticated;

-- A column-level REVOKE is a no-op while a TABLE-level SELECT grant is in
-- place: the table grant already covers every column. So the table grant comes
-- off and a per-column grant goes back in its place, built from the live column
-- list so a column added to companies tomorrow is included automatically --
-- except the five named here, which have to be added deliberately.
do $$
declare cols text;
begin
    select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
      into cols
      from information_schema.columns
     where table_schema = 'public' and table_name = 'companies'
       and column_name not in ('admin_notes', 'leads_token', 'stripe_customer_id',
                               'stripe_subscription_id', 'stripe_account_id');
    -- authenticated only. anon is deliberately left alone: no RLS policy on
    -- companies lets anon see a row at all, so it reads an empty list either
    -- way -- but taking the table grant off anon turns that empty list into
    -- "permission denied for table companies", which is a different answer,
    -- and the anon smoke test reads the difference as a broken rule.
    execute 'revoke select on public.companies from authenticated';
    execute format('grant select (%s) on public.companies to authenticated', cols);
end $$;

-- ---------- b) company_settings ----------

-- The non-money half of the settings blob, for a member who may not see money.
-- An ALLOWLIST, not a blocklist: a money key added to settings tomorrow stays
-- out of here by default instead of leaking until somebody notices.
create or replace function public.crew_settings()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
    select coalesce(
        (select jsonb_object_agg(k, s.settings -> k)
           from company_settings s,
                unnest(array[
                    'business_name', 'owner_name', 'phone', 'email', 'license_number',
                    'post_spacing', 'concrete_bags', 'panel_width', 'panel_height',
                    'waste', 'tools_list', 'order_template', 'hoa_template',
                    'review_template', 'default_build_template'
                ]) k
          where s.company_id = public.current_company_id()
            and s.settings ? k),
        '{}'::jsonb)
    where public.current_company_id() is not null;
$function$;

grant execute on function public.crew_settings() to authenticated;

drop policy if exists company_settings_money_needs_permission on public.company_settings;
create policy company_settings_money_needs_permission on public.company_settings
    as restrictive for select to authenticated
    using (
        public.has_permission('SEE_MONEY')
        or public.current_user_role() in ('OWNER', 'MANAGER')
    );

-- Make suspension actually stop access to data.
--
-- I told the owner RLS would refuse a suspended company's data server-side.
-- That was wrong: none of the 95 policies mentioned suspension, so suspending
-- a company changed nothing except a flag. The app and the website both kept
-- working, which is exactly what was reported.
--
-- The fix is a RESTRICTIVE policy rather than rewriting thirty permissive ones.
-- Permissive policies are OR'd together, so closing one path leaves the others
-- open -- several tables have a second policy using an inline subquery instead
-- of current_company_id(), and those would have kept granting. A restrictive
-- policy is AND'd with all of them, so one per table shuts every path at once
-- and cannot be bypassed by a policy somebody adds later.

create or replace function public.company_is_suspended()
returns boolean
language sql stable security definer set search_path = public as $$
    select coalesce(
        (select c.suspended
         from companies c
         join profiles p on p.company_id = c.id
         where p.id = auth.uid()),
        false  -- No company yet is not suspended; it simply has no data to reach.
    );
$$;

do $$
declare
    t text;
    -- Deliberately NOT every table.
    --
    -- profiles: blocking it stops the session resolving at all, so a suspended
    --   owner could not even be told why -- and could never be un-suspended.
    -- companies: the admin has to be able to reinstate them.
    -- app_releases: everybody needs to be told about updates, paid or not.
    -- device_tokens / company_setup_codes: scoped to a person, not a company.
    tables text[] := array[
        'jobs','fence_runs','estimate_line_items','change_orders','job_steps',
        'site_markers','expenses','punch_list_items','time_entries','employees',
        'material_items','manufacturers','pricing_tiers','payment_records',
        'field_changes','job_payments','company_settings'
    ];
begin
    foreach t in array tables loop
        execute format('drop policy if exists %I on public.%I', t || '_not_suspended', t);
        execute format(
            'create policy %I on public.%I as restrictive for all
             using (not public.company_is_suspended())
             with check (not public.company_is_suspended())',
            t || '_not_suspended', t
        );
    end loop;
end $$;

select count(*) as restrictive_policies_added
from pg_policies
where schemaname = 'public' and policyname like '%_not_suspended';

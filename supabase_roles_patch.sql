-- ============================================================
-- FenceFlow -- expanded roles, and deletion locked to the owner
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- The app hides buttons people shouldn't press. That is a courtesy, not a
-- control -- anyone can call the API directly with their own login. These
-- policies are what actually enforce it, inside Postgres, where the app
-- cannot talk its way around them.
-- ============================================================

-- ---------- 1. New roles ----------
-- These MUST be top-level statements. Postgres refuses ALTER TYPE ... ADD
-- VALUE from inside a function or DO block, and wrapping them in one with an
-- exception handler hid that failure completely -- the script reported
-- success while the roles were never created.
alter type user_role add value if not exists 'SALES';
alter type user_role add value if not exists 'ACCOUNTANT';
alter type user_role add value if not exists 'FOREMAN';

-- ---------- 2. Helper: what is the caller allowed to be? ----------
create or replace function my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
    select role::text from profiles where id = auth.uid();
$$;

revoke all on function my_role() from public;
grant execute on function my_role() to authenticated;

-- ---------- 3. Deleting is owner-only, on every table ----------
-- A mistaken delete on a signed change order or a paid invoice destroys the
-- record you would need in a dispute, and nothing here has an undo.
do $$
declare
    t text;
begin
    foreach t in array array[
        'jobs', 'fence_runs', 'estimate_line_items', 'expenses',
        'punch_list_items', 'change_orders', 'job_steps', 'site_markers',
        'time_entries', 'employees', 'manufacturers', 'pricing_tiers',
        'material_items'
    ]
    loop
        execute format('drop policy if exists %I_delete_owner on %I', t, t);
        execute format($f$
            create policy %I_delete_owner on %I
                for delete using (
                    company_id = (select company_id from profiles where id = auth.uid())
                    and (select role::text from profiles where id = auth.uid()) = 'OWNER'
                )
        $f$, t, t);
    end loop;
end $$;

-- ---------- 4. Crew cannot read money ----------
-- Line items carry unit prices, so a crew phone must not be able to pull them
-- even though it can see the job it is working on.
drop policy if exists estimate_line_items_select on estimate_line_items;
create policy estimate_line_items_select on estimate_line_items
    for select using (
        company_id = (select company_id from profiles where id = auth.uid())
        and (select role::text from profiles where id = auth.uid())
            in ('OWNER', 'MANAGER', 'SALES', 'ACCOUNTANT')
    );

drop policy if exists expenses_select on expenses;
create policy expenses_select on expenses
    for select using (
        company_id = (select company_id from profiles where id = auth.uid())
        and (select role::text from profiles where id = auth.uid())
            in ('OWNER', 'MANAGER', 'ACCOUNTANT')
    );

-- ---------- 5. Only an owner changes someone's role ----------
-- Without this a crew member could promote themselves to OWNER and undo
-- everything above in one request.
drop policy if exists profiles_update_own_company on profiles;
create policy profiles_update_own_company on profiles
    for update using (
        company_id = (select company_id from profiles where id = auth.uid())
        and (select role::text from profiles where id = auth.uid()) = 'OWNER'
    );

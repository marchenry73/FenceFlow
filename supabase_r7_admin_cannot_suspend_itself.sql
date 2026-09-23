-- ============================================================
-- FenceFlow -- an admin cannot suspend their own company, and suspending any
--              company is finally written down
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- KIND
--   FUNCTION-REPLACING admin_suspend(uuid, text, boolean) and audit_changes().
--   ADDITIVE           one AFTER INSERT/UPDATE/DELETE trigger on companies.
--   No row is written by this file, nothing is deleted, no policy changes.
--
-- WHAT HAPPENED (2026-09-23, reported by the owner)
--   The owner suspended a company in the admin portal that was shown as
--   "Fence solutions / support@fenceflowapp.com", and their own office login
--   marchenry73@gmail.com lost everything. It looked like suspending one company
--   had affected another account.
--
--   It had not. They are the same company. aba5b097 is named "Fence solutions",
--   its companies.email is support@fenceflowapp.com, and its three profiles are
--   marchenry73@gmail.com (OWNER, and the platform admin),
--   beaunissantbiguene50@gmail.com (MANAGER) and marchenry73123@gmail.com (CREW).
--   Suspending it is meant to do exactly what it did: twenty-one RESTRICTIVE
--   policies named *_not_suspended refuse every row of jobs, fence_runs,
--   estimate_line_items, time_entries, payment_records, change_orders,
--   employees, expenses, job_steps, site_markers, punch_list_items,
--   field_changes, job_payments, material_items, manufacturers, pricing_tiers,
--   pricing_drift, build_templates, build_template_uses, company_settings and
--   sync_signals.
--
--   Three things made that a one-click accident that left no trace.
--
--   1. admin_suspend() takes a target id and asks nothing else. It never looks at
--      whose company it is, so the one account that can suspend companies can
--      suspend the company it belongs to -- and lock out itself, its manager and
--      its crew, all at once. PART 1.
--   2. companies is not audited AT ALL. audit_log holds zero rows for it and the
--      table carries no audit trigger, so the most destructive action in the
--      product -- along with plan, price, trial and Stripe-account changes --
--      left no record of who did it or when. After the fact the only honest
--      answer was "I cannot tell you from the data". PART 2.
--   3. The admin list identifies a company by companies.email, which for this one
--      reads support@fenceflowapp.com -- a FenceFlow address, not the owner's
--      login. Their own company looks like a FenceFlow support account sitting
--      among the customers. That is a page change, not a database one, and is
--      done in website/admin.html.
--
--   The company is already healthy: suspended false, reason cleared,
--   company_allowed true, plan Pro, status active. Nothing here repairs data.
--
-- WHY A SERVER GUARD AND NOT A CONFIRM BOX
--   A confirm box is advice. This is the one action that can take the whole
--   business offline, and the account that performs it is the account that would
--   be locked out -- so the person who could undo it is the person who cannot get
--   in. admin_unsuspend() still works from the same login (it is gated by
--   is_platform_admin, which does not read companies.suspended), so this is a
--   guard rail rather than a trap; but a rail that is checked where the write
--   happens cannot be clicked through.
-- ============================================================

-- ------------------------------------------------------------------------
-- PART 1  not your own company
-- ------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_suspend(target uuid, note text DEFAULT NULL::text, hold boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  mine uuid;
begin
    if not is_platform_admin() then
        raise exception 'Only a FenceFlow admin may change company access.';
    end if;

    -- The company the caller's own login belongs to. Suspending it locks this
    -- admin, and everyone else in it, out of every job, estimate, shift and
    -- payment -- see the twenty-one *_not_suspended policies. It is never what
    -- an admin means to do from the customer list, and the list shows a company
    -- by companies.email, which need not resemble the admin's own address.
    select p.company_id into mine from profiles p where p.id = auth.uid();
    if mine is not null and target = mine then
        raise exception
          'That is your own company. Suspending it would lock you, your managers and your crew out of every job, estimate, shift and payment. Nothing has been changed.'
          using errcode = '42501',
                hint = 'If a customer really does need suspending, check the company id against the one on your own profile first.';
    end if;

    update companies
       set suspended = true,
           suspended_reason = case when hold then 'HOLD' else 'UNPAID' end,
           admin_notes = coalesce(note, admin_notes)
     where id = target;
end;
$function$;

comment on function public.admin_suspend(uuid, text, boolean) is
    'Suspends a company. Refuses the caller''s own company -- that locks the admin and their crew out of '
    'everything, and the admin list shows a company by companies.email, which need not look like theirs. '
    'See supabase_r7_admin_cannot_suspend_itself.sql.';


-- ------------------------------------------------------------------------
-- PART 2  companies is audited
--
-- The live audit_changes() body with a companies arm added. Two things that
-- table does not share with the others and that the function assumed:
--   * it has no company_id column -- its own id IS the company;
--   * it has no customer_name -- its name is the label worth reading later.
-- Both are handled without changing anything for the six tables already on it.
-- ------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.audit_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    watched text[];
    col text;
    old_json jsonb;
    new_json jsonb;
    old_val text;
    new_val text;
    who uuid := auth.uid();
    who_email text;
    the_company uuid;
    the_label text;
    the_id text;
begin
    watched := case tg_table_name
        when 'jobs' then array[
            'status','payment_status','deposit_amount','amount_paid','refunded_amount',
            'labor_rate_per_ft','labor_flat_fee','markup_percent','discount_percent',
            'minimum_job_charge','minimum_labor_charge','tax_rate_percent'
        ]
        when 'payment_records' then array['amount','method','received_at','note']
        when 'time_entries' then array['approved_at','rejected_at','hourly_rate','started_at','ended_at']
        when 'employees' then array['hourly_rate','per_foot_rate','pay_type','is_active']
        when 'change_orders' then array['additional_cost','material_cost','signed_at']
        when 'estimate_line_items' then array['quantity','unit_price','supplier_unit_price']
        -- Everything an admin can do to a company from the portal that the
        -- company itself cannot undo. suspended is first because it is the one
        -- that takes a business offline, and until now it left no trace at all.
        when 'companies' then array[
            'suspended','suspended_reason','subscription_plan','subscription_status',
            'monthly_price','pass_card_fee','trial_ends_at','grace_ends_at',
            'subscription_ends_at','stripe_account_id'
        ]
        else array[]::text[]
    end;

    if tg_op = 'DELETE' then old_json := to_jsonb(old); new_json := old_json;
    else new_json := to_jsonb(new); old_json := case when tg_op = 'UPDATE' then to_jsonb(old) else new_json end;
    end if;

    -- companies has no company_id: it IS the company. Reading the missing
    -- column would have filed every entry against a null company, which the
    -- admin views group by.
    the_company := coalesce(new_json ->> 'company_id', new_json ->> 'id')::uuid;
    the_id := coalesce(new_json ->> 'sync_id', new_json ->> 'id', '');
    -- ...and no customer_name. Its name is what makes an entry readable a month
    -- later: "suspended Fence solutions", not "suspended aba5b097".
    the_label := coalesce(nullif(new_json ->> 'customer_name', ''),
                          case when tg_table_name = 'companies' then new_json ->> 'name' end,
                          '');
    select email into who_email from auth.users where id = who;

    -- No signed-in user. Say what did it instead of leaving the column empty.
    if who_email is null then
        who_email := case
            -- An approval that just landed carries the name the customer
            -- typed. It is not proof of identity -- anyone holding the link
            -- can type a name -- and the wording says so rather than dressing
            -- it up as a verified signature.
            when tg_table_name = 'jobs'
             and coalesce(new_json ->> 'quote_approved_at', '') <> ''
             and coalesce(old_json ->> 'quote_approved_at', '') = ''
            then 'customer via quote link: ' ||
                 coalesce(nullif(new_json ->> 'quote_approved_name', ''), 'unnamed')
            when tg_table_name = 'payment_records' then 'payment processor'
            when tg_table_name = 'jobs'
             and (new_json ->> 'amount_paid') is distinct from (old_json ->> 'amount_paid')
            then 'payment processor'
            -- A company row moved with no signed-in user is the billing
            -- webhook, which is the only thing that does it.
            when tg_table_name = 'companies' then 'billing webhook'
            else 'server'
        end;
    end if;

    if tg_op = 'INSERT' then
        insert into audit_log (company_id, actor, actor_email, table_name, record_id, action, label)
        values (the_company, who, who_email, tg_table_name, the_id, 'insert', the_label);
        return new;
    end if;

    if tg_op = 'DELETE' then
        insert into audit_log (company_id, actor, actor_email, table_name, record_id, action, label)
        values (the_company, who, who_email, tg_table_name, the_id, 'delete', the_label);
        return old;
    end if;

    foreach col in array watched loop
        -- Skip anything this table does not actually have. A watch list that
        -- drifts ahead of the schema must never break a write.
        if new_json ? col then
            old_val := old_json ->> col;
            new_val := new_json ->> col;
            -- Only real changes: a sync rewriting a row with identical values
            -- is not somebody changing a price, and logging it would drown the
            -- entries that are.
            if old_val is distinct from new_val then
                insert into audit_log (
                    company_id, actor, actor_email, table_name, record_id,
                    action, field, old_value, new_value, label
                )
                values (
                    the_company, who, who_email, tg_table_name, the_id,
                    'update', col, old_val, new_val, the_label
                );
            end if;
        end if;
    end loop;

    return new;
end;
$function$;

drop trigger if exists companies_audit on public.companies;
create trigger companies_audit
    after insert or delete or update on public.companies
    for each row execute function public.audit_changes();


-- ------------------------------------------------------------------------
-- PART 3  prove what landed. Every row must read true.
-- ------------------------------------------------------------------------

select 'admin_suspend now reads the caller''s own company' as check,
       (select position('profiles p where p.id = auth.uid()' in prosrc) > 0
           and position('target = mine' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'admin_suspend') as ok
union all
select 'admin_suspend still refuses a non-admin first',
       (select position('is_platform_admin()' in prosrc) > 0 from pg_proc
         where pronamespace = 'public'::regnamespace and proname = 'admin_suspend')
union all
select 'companies carries the audit trigger',
       exists (select 1 from pg_trigger t
                where t.tgrelid = 'public.companies'::regclass
                  and t.tgname = 'companies_audit' and not t.tgisinternal)
union all
select 'audit_changes watches suspended on companies',
       (select position('''suspended'',''suspended_reason''' in replace(prosrc, ' ', '')) > 0
          from pg_proc where pronamespace = 'public'::regnamespace and proname = 'audit_changes')
union all
select 'audit_changes files a company against ITSELF, not a missing company_id',
       (select position('new_json ->> ''company_id'', new_json ->> ''id''' in prosrc) > 0
          from pg_proc where pronamespace = 'public'::regnamespace and proname = 'audit_changes')
union all
select 'the six tables already audited still are',
       (select count(distinct t.tgrelid::regclass::text) = 7
          from pg_trigger t where t.tgfoid = 'public.audit_changes()'::regprocedure
            and not t.tgisinternal)
union all
-- The canary has to still be true the SECOND time this file is run. The first
-- version asserted "companies has no audit history", which was true for about an
-- hour and then went red the moment the trigger recorded a real reinstate --
-- reporting a working audit trail as a failure. A check made of a fact that the
-- change itself falsifies can only ever cry wolf.
--
-- What IS durable: the watch list is a filter, not "everything". If it silently
-- became every column, the log would drown in name and email edits and the
-- suspensions would be unfindable -- while every check above still read true.
-- Scoped to the companies ARRAY, not to the whole body. Grepping prosrc for
-- 'name' finds it in the label expression (new_json ->> 'name'), which is not a
-- watched column at all -- so the first version of this canary read false
-- against a perfectly correct function. Third time today a text check has read
-- the wrong part of what it was pointed at; a check made of source text has to
-- name the region it means.
select 'CANARY: the companies watch list filters -- it does not log every column',
       (select position('''name''' in watched) = 0
           and position('''email''' in watched) = 0
           and position('''suspended''' in watched) > 0
          from (select coalesce(substring(prosrc from 'when ''companies'' then array\[([^\]]*)\]'), '') as watched
                  from pg_proc
                 where pronamespace = 'public'::regnamespace and proname = 'audit_changes') a);

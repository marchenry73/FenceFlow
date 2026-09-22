-- ============================================================
-- FenceFlow -- crew see the jobs they are on, and ask for the rest
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- THE OWNER'S ASK (2026-09-21): crew should see only the jobs assigned to
-- them, be able to ask for access to the others, and the owner, a manager or
-- anyone above should be able to put a job on whoever they want.
--
-- APPLY ORDER -- READ THIS FIRST
--   1. LIVE DATA, BEFORE THIS FILE: every crew login has to be linked to a
--      crew record (office -> Crew tab -> edit the person -> "Linked login"),
--      and the jobs they work assigned to that record. A login with no crew
--      record correctly sees NO jobs once this is applied. On 2026-09-21 no
--      company in production had a single employee linked to a login. See
--      the "who is not linked yet" query at the end of
--      supabase_crew_job_scope_probe.sql.
--   2. AFTER supabase_r6_price_stability.sql and supabase_r6_crew_writes.sql
--      (listed just above this file in supabase/dev/apply-order.txt). Those
--      two patch crew_push_line_items and crew_save_job the same way PART 2
--      below does: read whatever body is live (pg_get_functiondef), insert
--      a few lines at a named anchor, execute the result. Their anchors and
--      these are different lines, each left in place for the other, so
--      either order keeps both sets of lines; after them is the tested
--      order. Nothing here depends on them: with r6 live a crew line push is
--      a no-op before it reaches the guard below, and without r6 the guard
--      is what stops it. If any file later REPLACES one of the three
--      functions wholesale, re-run this one -- every part is idempotent --
--      and the self-check at the bottom fails loudly until you do. If an
--      anchor has moved (a rewritten function), PART 2 raises and changes
--      nothing; merge the lines below by hand into that file instead.
--   3. Ship with the app's crew-scope release (sync hides, never deletes, a
--      job that stops arriving). Old builds keep their local copies of jobs
--      they lose, and their child pushes for those jobs are refused row by
--      row -- noisy, never lossy.
--
-- THE LINES PART 2 INSERTS (so a later rewrite can carry them verbatim):
--   crew_save_job, immediately after
--       if clean->>'sync_id' is null then raise exception 'sync_id required'; end if;
--   insert
--       perform public.crew_job_guard((clean->>'sync_id')::uuid);
--       clean := public.crew_strip_assignment(clean);
--   crew_push_line_items, in the job existence test, after
--       and j.deleted_at is null
--   add
--       and public.can_see_job(j.sync_id)
--   and immediately after that test's `continue; end if;`
--       if exists (select 1 from public.estimate_line_items e
--                   where e.company_id = co and e.sync_id = (clean->>'sync_id')::uuid
--                     and not public.can_see_job(e.job_sync_id)) then
--           continue;
--       end if;
--   set_production_stage, immediately after
--       if job_status is null then raise exception 'That job is not on this company.' ...; end if;
--   insert
--       perform public.crew_job_guard(job_sid::uuid);
--   Each insert is skipped when its own line is already there
--   (crew_job_guard; can_see_job(j.sync_id); can_see_job(e.job_sync_id)),
--   so a rewrite that carries the lines is left alone.
--
-- WHO SEES EVERY JOB: a capability test, never a role test.
--   sees_all_jobs() = SEE_MONEY or EDIT_JOBS or SCHEDULE_AND_ASSIGN.
--   So OWNER, MANAGER, SALES, ACCOUNTANT and FOREMAN see everything by
--   default and CREW is scoped. Per-person overrides keep working: a foreman
--   with -SCHEDULE_AND_ASSIGN becomes scoped, a crew member with +EDIT_JOBS
--   sees everything. Everyone who can read the base jobs table holds
--   SEE_MONEY, so the base jobs policies are not touched.
--
-- WHAT A SCOPED PERSON SEES: jobs whose lead (jobs.assigned_employee_sync_id)
-- is their own crew record, plus open job_assignments rows -- extra crew on a
-- job (kind CREW) and approved access requests (kind ACCESS). The lead stays
-- on the jobs column, so the calendar, Who's free, per-foot pay and the crew
-- attention card keep reading what they read today.
--
-- NOTHING IS DELETED. An assignment ends by setting ended_at. A request is
-- answered by status. A job a phone stops receiving is hidden there, never
-- removed, and its unsynced work is kept -- until the office deletes the job
-- itself, when the phone learns it from deleted_job_sync_ids() and takes its
-- ordinary delete path, once every shift worked on it is in the cloud.
--
-- A WORKED SHIFT ALWAYS UPLOADS. time_entries writes are deliberately not
-- narrowed: a crew member who clocks in on a job they have since lost still
-- gets paid for it. Only the crew READ door (time_entries_crew) narrows, to
-- their own shifts (PART 5).
--
-- ALSO CLOSED HERE (found while writing this, reproduced in a rollback on
-- production): the five *_crew views are auto-updatable, owned by postgres
-- (which bypasses RLS), and `authenticated` held INSERT/UPDATE/DELETE on
-- them. A CREW login could run `delete from jobs_crew where ...` and
-- hard-delete any job in its company -- and the same through
-- time_entries_crew for shifts. Nothing in the app, the office or an edge
-- function writes through these views, so the write grants go (PART 1b).
-- And the side doors a scoped login could still read or write around the
-- job scope (PART 1c): the attention findings (their text carries dollar
-- figures), automation flags and runs and the follow-up log, the customers
-- table (every customer's phone and email), and writes that planted or
-- moved line items, change orders and expenses on jobs the caller cannot
-- see.
--
-- ROLLBACK (policy-narrowing only, nothing to restore): drop the
-- *_only_visible_jobs policies; re-run supabase_p2_jobs_crew_view.sql and
-- the files that last defined estimate_line_items_crew, change_orders_crew
-- and time_entries_crew; re-apply the r6 / earlier definitions of the three
-- patched functions. The two new tables can stay -- nothing reads them then.
-- ============================================================


-- ============================================================
-- PART 0 -- who else is on a job, and who was let in
-- ============================================================
-- One row per (job, person) beyond the lead. kind CREW: the office put them
-- on the job. kind ACCESS: an approved request. Ending one sets ended_at; a
-- new row is written if they come back, so the history of who was on what
-- is never rewritten. Clients get no write privilege at all: every write is
-- a permission-checked RPC below.
create table if not exists public.job_assignments (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade,
    job_sync_id uuid not null,
    employee_sync_id uuid not null,
    kind text not null check (kind in ('CREW', 'ACCESS')),
    assigned_by uuid references public.profiles(id) on delete set null,
    assigned_at timestamptz not null default now(),
    ended_at timestamptz,
    ended_by uuid references public.profiles(id) on delete set null,
    constraint job_assignments_job_fk foreign key (company_id, job_sync_id)
        references public.jobs(company_id, sync_id) on delete cascade,
    constraint job_assignments_emp_fk foreign key (company_id, employee_sync_id)
        references public.employees(company_id, sync_id) on delete cascade
);

comment on table public.job_assignments is
  'Crew on a job beyond its lead (kind CREW) and approved access requests (kind ACCESS). '
  'Never deleted: ended_at closes a row. Written only by set_job_crew, decide_job_access and '
  'end_job_assignment (supabase_crew_job_scope.sql).';

create unique index if not exists job_assignments_one_open
    on public.job_assignments(company_id, job_sync_id, employee_sync_id) where ended_at is null;
create index if not exists job_assignments_open_by_emp
    on public.job_assignments(company_id, employee_sync_id) where ended_at is null;

alter table public.job_assignments enable row level security;
revoke all on public.job_assignments from anon, authenticated;
grant select on public.job_assignments to authenticated;
grant all on public.job_assignments to service_role;


-- ============================================================
-- PART 1 -- the one question: may this caller see this job?
-- ============================================================
-- Every reader below asks these four functions and nothing else, so "who
-- sees what" is decided in exactly one place. All are SECURITY DEFINER:
-- employees is SEE_PAY-gated and job_assignments is scoped, and the answer
-- must not depend on what the caller can already read.

-- The caller's own crew record(s) in their current company. The link is
-- employees.profile_id, the same one is_my_shift() uses; it is unique, so
-- this is zero rows or one. An INACTIVE record counts as no record:
-- switching someone off in the office takes their jobs off their phone and
-- stops them asking for more. Their shifts still upload -- that door asks
-- is_my_shift(), which does not look at is_active, not this.
create or replace function public.my_employee_sync_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
    select e.sync_id from public.employees e
     where e.company_id = public.current_company_id()
       and e.profile_id = auth.uid()
       and e.deleted_at is null
       and e.is_active
       and e.sync_id is not null
$$;

-- A capability, never a role name, so a per-person override moves someone
-- in or out of "sees everything" without touching this function.
create or replace function public.sees_all_jobs()
returns boolean
language sql stable security definer set search_path = public as $$
    select coalesce(public.has_permission('SEE_MONEY'), false)
        or coalesce(public.has_permission('EDIT_JOBS'), false)
        or coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false)
$$;

-- The jobs a scoped caller is on: lead, extra crew, or let in. Tombstoned
-- jobs are included on purpose -- a deleted job the phone holds must still
-- arrive as a tombstone so the phone can take its normal delete path.
create or replace function public.my_visible_job_sync_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
    select j.sync_id from public.jobs j
     where j.company_id = public.current_company_id()
       and j.assigned_employee_sync_id in (select s::text from public.my_employee_sync_ids() s)
    union
    select a.job_sync_id from public.job_assignments a
     where a.company_id = public.current_company_id()
       and a.ended_at is null
       and a.employee_sync_id in (select public.my_employee_sync_ids())
$$;

create or replace function public.can_see_job(p_job_sync_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
    select public.sees_all_jobs()
        or coalesce(p_job_sync_id in (select public.my_visible_job_sync_ids()), false)
$$;

-- Callable by a signed-in caller because the views and policies below call
-- them as the caller (a view's functions run with the reader's privileges).
revoke execute on function public.my_employee_sync_ids(), public.sees_all_jobs(),
    public.my_visible_job_sync_ids(), public.can_see_job(uuid) from public, anon;
grant execute on function public.my_employee_sync_ids(), public.sees_all_jobs(),
    public.my_visible_job_sync_ids(), public.can_see_job(uuid) to authenticated, service_role;

create index if not exists jobs_company_assignee_idx
    on public.jobs(company_id, assigned_employee_sync_id);

-- A crew member sees their own assignment rows (the app shows "you were let
-- in"); anyone who sees every job sees them all (the office chips).
drop policy if exists job_assignments_read on public.job_assignments;
create policy job_assignments_read on public.job_assignments
    for select to authenticated
    using (company_id = public.current_company_id()
           and ((select public.sees_all_jobs())
                or employee_sync_id in (select public.my_employee_sync_ids())));

-- ---------- The crew doors: same columns, one more condition ----------
-- Built from the LIVE definition, so no column list is retyped here and
-- none can drift. The live WITH options (security_barrier, and
-- security_invoker=false where it is spelled out) are carried over as they
-- are, because CREATE OR REPLACE VIEW replaces the option list wholesale.
-- The grants, the postgres ownership that lets a crew session read around
-- the base tables' money policies, and the comments all survive.
do $views$
declare
    v record;
    d text;
    opts text;
begin
    for v in select * from (values
            ('jobs_crew',                'sync_id'),
            ('estimate_line_items_crew', 'job_sync_id'),
            ('change_orders_crew',       'job_sync_id')) t(name, job_col)
    loop
        d := rtrim(pg_get_viewdef(('public.' || v.name)::regclass, true), E'; \n');
        -- A re-run must not append the condition twice.
        if position('my_visible_job_sync_ids' in d) > 0 then
            continue;
        end if;
        -- The condition is ANDed onto the end, which is only right if the
        -- live WHERE is one plain AND chain. With an OR at the top level it
        -- would bind to the last arm alone and scope nothing, so refuse.
        if d !~* '\mWHERE\M' or d ~* '\mOR\M' then
            raise exception '% no longer ends in a plain AND-only WHERE; not touched', v.name;
        end if;
        select coalesce(' with (' || array_to_string(c.reloptions, ', ') || ')', '') into opts
          from pg_class c where c.oid = ('public.' || v.name)::regclass;
        execute format(
            'create or replace view public.%I%s as %s AND ((SELECT public.sees_all_jobs()) OR %I IN (SELECT public.my_visible_job_sync_ids()))',
            v.name, opts, d, v.job_col);
    end loop;
end $views$;

-- ---------- PART 1b: the crew doors are read-only ----------
-- Every *_crew view is a simple one-table view, so Postgres makes it
-- updatable, and it runs with its owner's rights -- postgres, which
-- bypasses RLS. With INSERT/UPDATE/DELETE granted to authenticated, a CREW
-- login could hard-delete any job in its company through jobs_crew, delete
-- shifts through time_entries_crew, and insert rows for ANOTHER company,
-- none of it seen by a policy. Reproduced in a rollback on 2026-09-21:
-- `delete from jobs_crew where sync_id = ...` as a CREW user removed the
-- job. Nothing legitimate writes through these views (the app writes
-- through crew_save_job / crew_push_line_items and the base tables; the
-- office reads them only), so reading is all that is left.
revoke insert, update, delete, truncate, references, trigger
    on public.jobs_crew, public.estimate_line_items_crew, public.change_orders_crew,
       public.time_entries_crew, public.material_items_crew
  from anon, authenticated;

-- ---------- The base tables a crew phone reads and writes ----------
-- RESTRICTIVE, so the existing company policies stay exactly as they are and
-- this only takes away. A scoped phone can neither read nor write a row of a
-- job it is not on; everyone who sees every job short-circuits to true in an
-- initplan. job_stage_events and quote_reapprovals are office history, read
-- only, so they get the read half. time_entries is deliberately absent --
-- see the header.
do $narrow$
declare
    t text;
begin
    foreach t in array array['fence_runs', 'job_steps', 'site_markers', 'punch_list_items', 'field_changes'] loop
        execute format('drop policy if exists %I on public.%I', t || '_only_visible_jobs', t);
        execute format(
            'create policy %I on public.%I as restrictive for all to authenticated '
            'using ((select public.sees_all_jobs()) or job_sync_id in (select public.my_visible_job_sync_ids())) '
            'with check ((select public.sees_all_jobs()) or job_sync_id in (select public.my_visible_job_sync_ids()))',
            t || '_only_visible_jobs', t);
    end loop;
    -- PART 1c, the read side doors. The last four are written only by the
    -- server (the attention sweep, run_automation_rule, send-follow-ups, all
    -- as the owner or service role) and read only by the office, whose
    -- readers all see every job; each carries a job_sync_id (NOT NULL) and
    -- used to be readable company-wide, so a crew login could list the
    -- names and problems of jobs it is not on.
    foreach t in array array['job_stage_events', 'quote_reapprovals',
                             'attention_findings', 'automation_flags', 'automation_runs', 'follow_up_log'] loop
        execute format('drop policy if exists %I on public.%I', t || '_only_visible_jobs', t);
        execute format(
            'create policy %I on public.%I as restrictive for select to authenticated '
            'using ((select public.sees_all_jobs()) or job_sync_id in (select public.my_visible_job_sync_ids()))',
            t || '_only_visible_jobs', t);
    end loop;
    -- PART 1c, the write side doors. The policies on estimate_line_items,
    -- change_orders and expenses let anyone in the company UPDATE, and their
    -- SEE_MONEY read gate does not stop a write that reads no column: one
    -- UPDATE with no WHERE moved every line and change order in the company
    -- onto the caller's own job, where the crew views then showed them
    -- (rolled back, 2026-09-21). PostgREST's safeupdate refuses that
    -- particular statement over the API; this refuses it in the database.
    -- The UPDATE half is the one that decides anything today. Their INSERT
    -- policies check only the company too, but a crew INSERT into any of the
    -- three is refused first by something else: estimate_line_items by
    -- supabase_r6_price_stability.sql's line_items_insert_needs_money_or_edit
    -- (EDIT_JOBS or SEE_MONEY -- and either one already means sees_all_jobs(),
    -- so for that table the INSERT half here can never be the one that says
    -- no); expenses by guard_expense_amount ("Setting what a job cost needs
    -- SEE_MONEY", even at zero); and change_orders, for now, by the 42804 in
    -- hold_money_columns()'s untyped to_jsonb('') -- a separate bug in
    -- supabase_crew_money_shield_patch.sql, not this policy, and the day it
    -- is fixed a crew change order on a job they are not on meets this. So
    -- the INSERT half is kept for all three: it is the job-scope rule itself,
    -- and it must not rest on those other gates staying as they are. The
    -- probe shows it deciding (36b/37b) with the expense guard switched off
    -- for those two rows. Reads are untouched -- they are SEE_MONEY already
    -- -- and DELETE stays with enforce_delete_permission(). A crew phone's
    -- change-order push on its own jobs passes this.
    foreach t in array array['estimate_line_items', 'change_orders', 'expenses'] loop
        execute format('drop policy if exists %I on public.%I', t || '_insert_only_visible_jobs', t);
        execute format(
            'create policy %I on public.%I as restrictive for insert to authenticated '
            'with check ((select public.sees_all_jobs()) or job_sync_id in (select public.my_visible_job_sync_ids()))',
            t || '_insert_only_visible_jobs', t);
        execute format('drop policy if exists %I on public.%I', t || '_update_only_visible_jobs', t);
        execute format(
            'create policy %I on public.%I as restrictive for update to authenticated '
            'using ((select public.sees_all_jobs()) or job_sync_id in (select public.my_visible_job_sync_ids())) '
            'with check ((select public.sees_all_jobs()) or job_sync_id in (select public.my_visible_job_sync_ids()))',
            t || '_update_only_visible_jobs', t);
    end loop;
end $narrow$;

-- The attention sweep writes chargeback, dispute and failed-payment amounts
-- into message ("Payment attempt failed ($1,234.00): ..."). Job scope alone
-- would still hand a crew member the figures on their own jobs, and a
-- foreman sees every job without SEE_MONEY, so the table follows the other
-- money tables' rule. Nothing but the office's money holders and the
-- sweep itself (service role) reads it; crew have their own attention card
-- on the phone, computed there.
drop policy if exists attention_findings_money_hidden_from_crew on public.attention_findings;
create policy attention_findings_money_hidden_from_crew on public.attention_findings
    as restrictive for select to authenticated
    using ((select coalesce(public.has_permission('SEE_MONEY'), false)));

-- customers: no app build and no office screen reads or writes this table
-- (checked 2026-09-21: two rows, no client query), yet its policies let
-- every login in the company read every customer's phone, email and notes
-- and edit any row -- more than jobs_crew shows a crew member about their
-- own jobs. It has no job column to scope by, so reading needs both "sees
-- every job" and SEE_CUSTOMER_CONTACT (every office role holds the pair by
-- default; CREW holds neither), and writing needs EDIT_JOBS.
drop policy if exists customers_need_contact_permission on public.customers;
create policy customers_need_contact_permission on public.customers
    as restrictive for select to authenticated
    using ((select public.sees_all_jobs())
           and (select coalesce(public.has_permission('SEE_CUSTOMER_CONTACT'), false)));
drop policy if exists customers_insert_needs_edit_jobs on public.customers;
create policy customers_insert_needs_edit_jobs on public.customers
    as restrictive for insert to authenticated
    with check ((select coalesce(public.has_permission('EDIT_JOBS'), false)));
drop policy if exists customers_update_needs_edit_jobs on public.customers;
create policy customers_update_needs_edit_jobs on public.customers
    as restrictive for update to authenticated
    using ((select coalesce(public.has_permission('EDIT_JOBS'), false)))
    with check ((select coalesce(public.has_permission('EDIT_JOBS'), false)));

-- Not done here, on purpose: storage.objects for bucket job-files (folder 2
-- is the job sync id; photos, customer signatures, final sign-offs). The
-- design holds it until this file is proven on phones, because a refused
-- upload there is a photo that never leaves the handset. When it is time,
-- these three, with the cast guarded so a malformed path answers false
-- rather than erroring:
--   create policy job_files_only_visible_jobs_read on storage.objects
--       as restrictive for select to authenticated
--       using (bucket_id <> 'job-files' or public.can_see_job(
--              case when (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
--                   then (storage.foldername(name))[2]::uuid end));
--   ...and the same expression FOR INSERT (with check) and FOR UPDATE
--   (using and with check).


-- ============================================================
-- PART 2 -- the crew pens write only jobs the caller can see
-- ============================================================
-- crew_save_job, crew_push_line_items and set_production_stage are SECURITY
-- DEFINER, so the RLS above never sees their writes, and until now each
-- checked the company and nothing else. Worse, guard_job_assignment() --
-- the only thing requiring SCHEDULE_AND_ASSIGN to move a job's assignee or
-- date -- returns early when current_user is not authenticated/anon, which
-- inside a definer function it never is. So a CREW phone could reassign and
-- reschedule any job through crew_save_job (reproduced in a rollback).
--
-- Two small helpers carry the whole change, so the lines added to each
-- function stay one or two long and can be carried by any later rewrite.

-- Raises for a job the caller may not see. 42501 is what the app already
-- counts as "held back for retry" (isNotOursToSync), never as a failure.
create or replace function public.crew_job_guard(p_job_sync_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
    if p_job_sync_id is null or not public.can_see_job(p_job_sync_id) then
        raise exception 'This job is not assigned to you.' using errcode = '42501';
    end if;
end $$;

-- Drops who-and-when for anyone without SCHEDULE_AND_ASSIGN. STRIPPED, not
-- refused: a crew push echoes the assignee and date it last pulled, so
-- refusing on their presence would refuse every crew save there is.
create or replace function public.crew_strip_assignment(p_row jsonb)
returns jsonb
language sql stable security definer set search_path = public as $$
    select case when coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false) then p_row
                else p_row - array['assigned_employee_sync_id', 'assigned_employee_id', 'scheduled_date']
           end
$$;

-- Called only from inside definer functions, where the check runs as the
-- function owner, so no client needs them.
revoke execute on function public.crew_job_guard(uuid), public.crew_strip_assignment(jsonb)
    from public, anon, authenticated;
grant execute on function public.crew_job_guard(uuid), public.crew_strip_assignment(jsonb)
    to service_role;

-- The live bodies, patched in place. Each block: read the live definition,
-- skip it if it already carries the guard, insist the anchor appears exactly
-- once (a rewritten function raises here rather than being patched in the
-- wrong spot), insert, execute. CREATE OR REPLACE keeps owner and grants.
do $patch$
declare
    d text;
    n int;
    anchor text;
begin
    -- crew_save_job ---------------------------------------------------------
    d := pg_get_functiondef('public.crew_save_job(jsonb)'::regprocedure);
    if position('crew_job_guard' in d) = 0 then
        anchor := $re$(if clean->>'sync_id' is null then\s+raise exception 'sync_id required';\s+end if;)$re$;
        select count(*) into n from regexp_matches(d, anchor, 'g');
        if n <> 1 then
            raise exception 'crew_save_job: the sync_id check to anchor on appears % times, not once. '
                            'Not touched -- merge the PART 2 lines into the file that last defined it.', n;
        end if;
        d := regexp_replace(d, anchor, $rep$\1

    -- supabase_crew_job_scope.sql: only a job this caller can see, and
    -- never who is on it or when unless they hold SCHEDULE_AND_ASSIGN.
    perform public.crew_job_guard((clean->>'sync_id')::uuid);
    clean := public.crew_strip_assignment(clean);$rep$);
        execute d;
    end if;

    -- crew_push_line_items --------------------------------------------------
    -- A row for a job the caller cannot see is skipped like a row for a job
    -- that does not exist: one stale line must not refuse the whole batch.
    -- Two inserts, each with its own already-there test, applied to the
    -- text in turn and executed once.
    d := pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure);
    n := 0;
    -- (a) the job the row names must be one the caller can see.
    if position('can_see_job(j.sync_id)' in d) = 0 then
        anchor := $re$(where j\.company_id = co and j\.sync_id = \(clean->>'job_sync_id'\)::uuid\s+and j\.deleted_at is null)\) then$re$;
        select count(*) into n from regexp_matches(d, anchor, 'g');
        if n <> 1 then
            raise exception 'crew_push_line_items: the job existence test to anchor on appears % times, not once. '
                            'Not touched -- merge the PART 2 lines into the file that last defined it.', n;
        end if;
        d := regexp_replace(d, anchor, $rep$\1 and public.can_see_job(j.sync_id)) then$rep$);
    end if;
    -- (b) and the line must not already belong to a job they cannot see.
    -- The upsert is ON CONFLICT (company_id, sync_id) DO UPDATE, which
    -- rewrites job_sync_id on whatever row holds that sync_id, and this is
    -- a definer function, so no policy looks. A crew phone holds every
    -- line id from the company-wide pulls made before scoping; pushing one
    -- of them re-pointed at its own job moved an office line off an
    -- unassigned job and into the crew view (rolled back, 2026-09-21).
    if position('can_see_job(e.job_sync_id)' in d) = 0 then
        anchor := $re$(and public\.can_see_job\(j\.sync_id\)\) then\s+continue;\s+end if;)$re$;
        select count(*) into n from regexp_matches(d, anchor, 'g');
        if n <> 1 then
            raise exception 'crew_push_line_items: the guarded job existence test to anchor on appears % times, not once. '
                            'Not touched -- merge the PART 2 lines into the file that last defined it.', n;
        end if;
        d := regexp_replace(d, anchor, $rep$\1

        -- supabase_crew_job_scope.sql: never move a line off a job this
        -- caller cannot see (the upsert below rewrites job_sync_id).
        if exists (select 1 from public.estimate_line_items e
                    where e.company_id = co and e.sync_id = (clean->>'sync_id')::uuid
                      and not public.can_see_job(e.job_sync_id)) then
            continue;
        end if;$rep$);
    end if;
    if n > 0 then
        execute d;
    end if;

    -- set_production_stage --------------------------------------------------
    -- SCHEDULE_AND_ASSIGN is one of the sees-everything capabilities, so the
    -- office keeps moving any job; a scoped crew member moves only theirs.
    d := pg_get_functiondef('public.set_production_stage(text, text)'::regprocedure);
    if position('crew_job_guard' in d) = 0 then
        anchor := $re$(if job_status is null then\s+raise exception 'That job is not on this company\.' using errcode = '23503';\s+end if;)$re$;
        select count(*) into n from regexp_matches(d, anchor, 'g');
        if n <> 1 then
            raise exception 'set_production_stage: the job lookup check to anchor on appears % times, not once. '
                            'Not touched -- merge the PART 2 lines into the file that last defined it.', n;
        end if;
        d := regexp_replace(d, anchor, $rep$\1

    -- supabase_crew_job_scope.sql: a scoped crew member moves only a job
    -- they are on.
    perform public.crew_job_guard(job_sid::uuid);$rep$);
        execute d;
    end if;
end $patch$;


-- ============================================================
-- PART 3 -- asking for a job, and answering
-- ============================================================
-- The RPCs answer in SQLSTATEs, so the app and the office can show their own
-- translated sentence rather than this file's English:
--   42501  not allowed (no permission, not signed in, suspended, not your
--          job, or deciding your own request)
--   23514  your login is not linked to a crew member yet
--   22023  nothing to ask for (you already see every job / already have it)
--   23503  no such job or request in this company (a job that is not won
--          work -- a DRAFT, a lead -- answers the same)
--   54000  a limit: 20 requests waiting, or 10 asked in the last hour
create table if not exists public.job_access_requests (
    id uuid primary key default gen_random_uuid(),
    company_id uuid not null references public.companies(id) on delete cascade,
    job_sync_id uuid not null,
    requested_by uuid references public.profiles(id) on delete set null,
    employee_sync_id uuid not null,
    reason text not null default '' check (char_length(reason) <= 500),
    status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'DENIED', 'WITHDRAWN')),
    created_at timestamptz not null default now(),
    decided_by uuid references public.profiles(id) on delete set null,
    decided_at timestamptz,
    decision_note text not null default '' check (char_length(decision_note) <= 500),
    constraint job_access_requests_job_fk foreign key (company_id, job_sync_id)
        references public.jobs(company_id, sync_id) on delete cascade
);

comment on table public.job_access_requests is
  'A scoped crew member asking to see a job they are not on. Answered by status, never deleted. '
  'Written only by request_job_access, withdraw_job_access_request and decide_job_access '
  '(supabase_crew_job_scope.sql); approval writes a job_assignments row of kind ACCESS.';

create unique index if not exists job_access_requests_one_pending
    on public.job_access_requests(company_id, job_sync_id, requested_by) where status = 'PENDING';
create index if not exists job_access_requests_pending
    on public.job_access_requests(company_id, created_at) where status = 'PENDING';
create index if not exists job_access_requests_by_requester
    on public.job_access_requests(company_id, requested_by, created_at);

alter table public.job_access_requests enable row level security;
revoke all on public.job_access_requests from anon, authenticated;
grant select on public.job_access_requests to authenticated;
grant all on public.job_access_requests to service_role;

-- Your own requests, or all of them if you are the one who answers.
drop policy if exists job_access_requests_read on public.job_access_requests;
create policy job_access_requests_read on public.job_access_requests
    for select to authenticated
    using (company_id = public.current_company_id()
           and (requested_by = auth.uid()
                or (select coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false))));

-- The app's three-state answer. sees_all: show everything. linked=false:
-- "Your login is not linked to a crew member yet -- ask the office", which
-- must never read as a sync failure. Otherwise: visible jobs and pending asks.
-- visible counts live jobs only (tombstones still arrive, but are not work).
create or replace function public.my_job_scope()
returns jsonb
language sql stable security definer set search_path = public as $$
    select case when public.current_company_id() is null then null else jsonb_build_object(
        'sees_all', public.sees_all_jobs(),
        'linked', exists (select 1 from public.my_employee_sync_ids()),
        'visible', (select count(*) from public.jobs j
                     where j.company_id = public.current_company_id()
                       and j.deleted_at is null
                       and not coalesce(j.is_test_fixture, false)
                       and j.sync_id in (select public.my_visible_job_sync_ids())),
        'pending_requests', (select count(*) from public.job_access_requests r
                              where r.company_id = public.current_company_id()
                                and r.requested_by = auth.uid()
                                and r.status = 'PENDING'))
    end
$$;

-- Which jobs may be asked for at all: won work. The list below and the ask
-- after it both call this, so what the phone offers and what the server
-- accepts are one rule -- a crew phone holding a stale id for a DRAFT or a
-- lead cannot queue a request the list would never have shown. Widen it
-- here, once, if the owner wants more.
create or replace function public.job_status_is_requestable(p_status text)
returns boolean
language sql immutable set search_path = public as $$
    select coalesce(p_status in ('ACCEPTED', 'COMPLETED'), false)
$$;

-- What a scoped crew member may ask for: won work they are not on. No money,
-- no phone, no email -- a name and a place is enough to know which job it is.
create or replace function public.list_requestable_jobs()
returns table(job_sync_id uuid, customer_name text, address text, scheduled_date timestamptz,
              status text, production_stage text, my_request_status text, my_request_at timestamptz)
language sql stable security definer set search_path = public as $$
    select j.sync_id, j.customer_name, j.address, j.scheduled_date, j.status::text,
           j.production_stage::text, lr.status, coalesce(lr.decided_at, lr.created_at)
      from public.jobs j
      left join lateral (
            select q.status, q.created_at, q.decided_at
              from public.job_access_requests q
             where q.company_id = j.company_id and q.job_sync_id = j.sync_id
               and q.requested_by = auth.uid()
             order by q.created_at desc
             limit 1) lr on true
     where j.company_id = public.current_company_id()
       and not public.company_is_suspended()
       and not public.sees_all_jobs()
       and coalesce(public.has_permission('RECORD_FIELD_WORK'), false)
       and j.deleted_at is null
       and not coalesce(j.is_test_fixture, false)
       and public.job_status_is_requestable(j.status::text)
       and j.sync_id not in (select public.my_visible_job_sync_ids())
     order by j.scheduled_date nulls last, j.customer_name
$$;

-- Asking. Tapping twice returns the same request. Two limits keep the
-- office's list readable: at most 20 waiting at once, and at most 10 asked
-- in any hour (withdraw-and-ask-again cannot flood the office either). The
-- limits are counted under a per-caller lock: counted without one, asks
-- fired in parallel for different jobs each read a count under the limit
-- and all went in.
create or replace function public.request_job_access(p_job_sync_id uuid, p_reason text default '')
returns uuid
language plpgsql security definer set search_path = public as $$
declare
    co uuid := public.current_company_id();
    emp uuid;
    rid uuid;
    n int;
begin
    if auth.uid() is null or co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if public.company_is_suspended() then
        raise exception 'Company suspended' using errcode = '42501';
    end if;
    if not coalesce(public.has_permission('RECORD_FIELD_WORK'), false) then
        raise exception 'You cannot request jobs.' using errcode = '42501';
    end if;
    if public.sees_all_jobs() then
        raise exception 'You can already see every job.' using errcode = '22023';
    end if;
    select s into emp from public.my_employee_sync_ids() s limit 1;
    if emp is null then
        raise exception 'Your login is not linked to a crew member yet. Ask the office to link it.'
            using errcode = '23514';
    end if;
    -- A job that is not won work answers exactly like one that does not
    -- exist, so a stale id tells the phone nothing about it.
    if not exists (select 1 from public.jobs j
                    where j.company_id = co and j.sync_id = p_job_sync_id
                      and j.deleted_at is null and not coalesce(j.is_test_fixture, false)
                      and public.job_status_is_requestable(j.status::text)) then
        raise exception 'That job is not on this company.' using errcode = '23503';
    end if;
    if public.can_see_job(p_job_sync_id) then
        raise exception 'You already have this job.' using errcode = '22023';
    end if;

    -- One ask at a time per person, until this transaction ends.
    perform pg_advisory_xact_lock(hashtext('job_access_request:' || auth.uid()::text));

    select id into rid from public.job_access_requests
     where company_id = co and job_sync_id = p_job_sync_id
       and requested_by = auth.uid() and status = 'PENDING';
    if rid is not null then
        return rid;
    end if;

    select count(*) into n from public.job_access_requests
     where company_id = co and requested_by = auth.uid() and status = 'PENDING';
    if n >= 20 then
        raise exception 'You already have 20 requests waiting. Wait for the office to answer some.'
            using errcode = '54000';
    end if;
    select count(*) into n from public.job_access_requests
     where company_id = co and requested_by = auth.uid() and created_at > now() - interval '1 hour';
    if n >= 10 then
        raise exception 'You have asked for 10 jobs in the last hour. Try again later.'
            using errcode = '54000';
    end if;

    -- A double tap racing itself lands on the one-pending index; the loser
    -- returns the winner's id instead of an error.
    insert into public.job_access_requests(company_id, job_sync_id, requested_by, employee_sync_id, reason)
    values (co, p_job_sync_id, auth.uid(), emp, left(btrim(coalesce(p_reason, '')), 500))
    on conflict (company_id, job_sync_id, requested_by) where status = 'PENDING' do nothing
    returning id into rid;
    if rid is null then
        select id into rid from public.job_access_requests
         where company_id = co and job_sync_id = p_job_sync_id
           and requested_by = auth.uid() and status = 'PENDING';
    end if;
    return rid;
end $$;

create or replace function public.withdraw_job_access_request(p_request_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
    n int;
begin
    update public.job_access_requests
       set status = 'WITHDRAWN', decided_at = now()
     where id = p_request_id
       and company_id = public.current_company_id()
       and requested_by = auth.uid()
       and status = 'PENDING';
    get diagnostics n = row_count;
    return n > 0;
end $$;

-- Answering. Only someone who assigns work, and never their own request (a
-- crew member later given SCHEDULE_AND_ASSIGN could otherwise approve the
-- ask they made before the promotion). Answering twice changes nothing.
create or replace function public.decide_job_access(p_request_id uuid, p_approve boolean, p_note text default '')
returns boolean
language plpgsql security definer set search_path = public as $$
declare
    co uuid := public.current_company_id();
    r public.job_access_requests;
begin
    if auth.uid() is null or co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if public.company_is_suspended() then
        raise exception 'Company suspended' using errcode = '42501';
    end if;
    if not coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false) then
        raise exception 'Deciding job access needs SCHEDULE_AND_ASSIGN.' using errcode = '42501';
    end if;
    select * into r from public.job_access_requests
     where id = p_request_id and company_id = co
       for update;
    if not found then
        raise exception 'Request not found.' using errcode = '23503';
    end if;
    if r.requested_by = auth.uid() then
        raise exception 'You cannot decide your own request.' using errcode = '42501';
    end if;
    if r.status <> 'PENDING' then
        return false;
    end if;

    update public.job_access_requests
       set status = case when p_approve then 'APPROVED' else 'DENIED' end,
           decided_by = auth.uid(),
           decided_at = now(),
           decision_note = left(btrim(coalesce(p_note, '')), 500)
     where id = r.id;
    if p_approve then
        insert into public.job_assignments(company_id, job_sync_id, employee_sync_id, kind, assigned_by)
        values (co, r.job_sync_id, r.employee_sync_id, 'ACCESS', auth.uid())
        on conflict (company_id, job_sync_id, employee_sync_id) where ended_at is null do nothing;
    end if;
    return true;
end $$;

-- The office's "Also on this job": the full list of extra crew. People left
-- off get ended_at (their row stays); people added get a new row. The lead
-- is still jobs.assigned_employee_sync_id, saved the way it is today.
create or replace function public.set_job_crew(p_job_sync_id uuid, p_employee_sync_ids uuid[])
returns integer
language plpgsql security definer set search_path = public as $$
declare
    co uuid := public.current_company_id();
    n int := 0;
begin
    if auth.uid() is null or co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if public.company_is_suspended() then
        raise exception 'Company suspended' using errcode = '42501';
    end if;
    if not coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false) then
        raise exception 'Assigning crew needs SCHEDULE_AND_ASSIGN.' using errcode = '42501';
    end if;
    if not exists (select 1 from public.jobs
                    where company_id = co and sync_id = p_job_sync_id and deleted_at is null) then
        raise exception 'That job is not on this company.' using errcode = '23503';
    end if;

    update public.job_assignments
       set ended_at = now(), ended_by = auth.uid()
     where company_id = co and job_sync_id = p_job_sync_id and kind = 'CREW' and ended_at is null
       and not (employee_sync_id = any(coalesce(p_employee_sync_ids, '{}')));

    insert into public.job_assignments(company_id, job_sync_id, employee_sync_id, kind, assigned_by)
    select co, p_job_sync_id, e.sync_id, 'CREW', auth.uid()
      from public.employees e
     where e.company_id = co and e.deleted_at is null
       and e.sync_id = any(coalesce(p_employee_sync_ids, '{}'))
    on conflict (company_id, job_sync_id, employee_sync_id) where ended_at is null do nothing;
    get diagnostics n = row_count;
    return n;
end $$;

-- Taking someone off a job (extra crew or granted access). The row stays.
create or replace function public.end_job_assignment(p_assignment_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
    n int;
begin
    if auth.uid() is null or public.current_company_id() is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if public.company_is_suspended() then
        raise exception 'Company suspended' using errcode = '42501';
    end if;
    if not coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false) then
        raise exception 'Ending an assignment needs SCHEDULE_AND_ASSIGN.' using errcode = '42501';
    end if;
    update public.job_assignments
       set ended_at = now(), ended_by = auth.uid()
     where id = p_assignment_id
       and company_id = public.current_company_id()
       and ended_at is null;
    get diagnostics n = row_count;
    return n > 0;
end $$;

-- Which of the jobs a phone keeps after its person was taken off them the
-- office has since deleted. The crew door sends a tombstone only for a job
-- its caller can still see (my_visible_job_sync_ids), so a kept job deleted
-- later never reached the phone's delete path and sat under "Kept on this
-- phone" for good -- with an unsent edit on it, blocking an ordinary
-- sign-out. The phone asks with the ids it already holds and hears back the
-- deleted ones: ids only, never a name, an address or a figure, and only of
-- its own company's jobs, so it learns nothing about a job it did not
-- already have. At most 500 ids a call; the app asks in pieces.
create or replace function public.deleted_job_sync_ids(p_job_sync_ids uuid[])
returns setof uuid
language sql stable security definer set search_path = public as $$
    select j.sync_id from public.jobs j
     where j.company_id = public.current_company_id()
       and j.deleted_at is not null
       and j.sync_id = any ((p_job_sync_ids)[1:500])
$$;

revoke execute on function public.my_job_scope(), public.list_requestable_jobs(),
    public.request_job_access(uuid, text), public.withdraw_job_access_request(uuid),
    public.decide_job_access(uuid, boolean, text), public.set_job_crew(uuid, uuid[]),
    public.end_job_assignment(uuid), public.deleted_job_sync_ids(uuid[]) from public, anon;
grant execute on function public.my_job_scope(), public.list_requestable_jobs(),
    public.request_job_access(uuid, text), public.withdraw_job_access_request(uuid),
    public.decide_job_access(uuid, boolean, text), public.set_job_crew(uuid, uuid[]),
    public.end_job_assignment(uuid), public.deleted_job_sync_ids(uuid[]) to authenticated, service_role;
-- Called only from inside the two definer functions above.
revoke execute on function public.job_status_is_requestable(text) from public, anon, authenticated;
grant execute on function public.job_status_is_requestable(text) to service_role;

-- An approval should land on the phone in seconds, not at the next pass.
-- The app's realtime watcher listens per table with a company filter, and
-- Realtime applies each table's SELECT policy per subscriber -- a crew phone
-- hears only its own rows.
do $rt$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
        if not exists (select 1 from pg_publication_tables
                        where pubname = 'supabase_realtime' and schemaname = 'public'
                          and tablename = 'job_assignments') then
            alter publication supabase_realtime add table public.job_assignments;
        end if;
        if not exists (select 1 from pg_publication_tables
                        where pubname = 'supabase_realtime' and schemaname = 'public'
                          and tablename = 'job_access_requests') then
            alter publication supabase_realtime add table public.job_access_requests;
        end if;
    end if;
end $rt$;


-- ============================================================
-- PART 4 -- "nobody assigned" and the assignment push read the real column
-- ============================================================
-- jobs.assigned_employee_id (uuid) has never been written -- 0 of the live
-- jobs carry it. The assignee lives in assigned_employee_sync_id. So the
-- sweep's unassigned_scheduled detector called EVERY future scheduled job
-- "nobody assigned" (latent: none are scheduled today), and the push
-- trigger listened to a column that never changes.

-- attention_sweep_candidates: the live body, one condition swapped. A job
-- with a lead, or with extra crew on it, is assigned.
do $sweep$
declare
    d text;
    n int;
    anchor text := 'and j.assigned_employee_id is null';
begin
    d := pg_get_functiondef('public.attention_sweep_candidates()'::regprocedure);
    if position('job_assignments' in d) = 0 then
        n := (length(d) - length(replace(d, anchor, ''))) / length(anchor);
        if n <> 1 then
            raise exception 'attention_sweep_candidates: "%" appears % times, not once. Not touched.', anchor, n;
        end if;
        d := replace(d, anchor,
            'and coalesce(j.assigned_employee_sync_id, '''') = ''''' || E'\n' ||
            '     and not exists (select 1 from public.job_assignments a' || E'\n' ||
            '                      where a.company_id = j.company_id and a.job_sync_id = j.sync_id' || E'\n' ||
            '                        and a.ended_at is null and a.kind = ''CREW'')');
        execute d;
    end if;
end $sweep$;

-- The push trigger: the same definition with the right column. The
-- definition carries the trigger's secret header, so it is copied inside
-- the database and never typed, printed or read out. If the shape has
-- changed, this raises and the trigger is left exactly as it was.
--
-- Safe to ship before notify-job-change's phase 2: today that function
-- compares record.assigned_employee_id (always null), so an assignment
-- change reaches it and it answers "no notification needed". Phase 2 must
-- ship the sync-id comparison TOGETHER WITH its recipient filter (see-all
-- users plus the assignee's own login) -- the comparison alone would push
-- "Crew assignment changed", and "New job added" already names every new
-- job, to every phone in the company, including crew who cannot see it.
do $trg$
declare
    d text;
    old_cols text := 'UPDATE OF status, assigned_employee_id ';
    new_cols text := 'UPDATE OF status, assigned_employee_sync_id ';
begin
    select pg_get_triggerdef(t.oid) into d
      from pg_trigger t
     where t.tgrelid = 'public.jobs'::regclass and t.tgname = 'job-change-push';
    if d is not null and position('assigned_employee_sync_id' in d) = 0 then
        if (length(d) - length(replace(d, old_cols, ''))) / length(old_cols) <> 1 then
            raise exception 'job-change-push no longer has the expected column list; not touched';
        end if;
        d := replace(d, old_cols, new_cols);
        execute 'drop trigger "job-change-push" on public.jobs';
        execute d;
    end if;
end $trg$;


-- ============================================================
-- PART 5 -- crew pull only their own shifts
-- ============================================================
-- time_entries_crew handed every phone without SEE_PAY every shift in the
-- company, which is how a crew phone came to show "N shifts waiting for
-- approval" for other people's hours. Anyone who sees every job, or approves
-- time, reads what they read today; a scoped crew member reads their own.
-- Colleague rows already on a phone stay there (a pull never deletes); the
-- app's attention gating is what takes them off the screen. Writes are
-- untouched: a shift always uploads.
do $shifts$
declare
    d text;
    opts text;
begin
    d := rtrim(pg_get_viewdef('public.time_entries_crew'::regclass, true), E'; \n');
    if position('is_my_shift' in d) = 0 then
        if d !~* '\mWHERE\M' or d ~* '\mOR\M' then
            raise exception 'time_entries_crew no longer ends in a plain AND-only WHERE; not touched';
        end if;
        select coalesce(' with (' || array_to_string(c.reloptions, ', ') || ')', '') into opts
          from pg_class c where c.oid = 'public.time_entries_crew'::regclass;
        execute format(
            'create or replace view public.time_entries_crew%s as %s AND ((SELECT public.sees_all_jobs()) '
            'OR (SELECT coalesce(public.has_permission(''APPROVE_TIME''), false)) '
            'OR public.is_my_shift(employee_sync_id))',
            opts, d);
    end if;
end $shifts$;


-- ============================================================
-- Self-check. Everything above is idempotent and anchored, so the failure
-- worth catching is a later file putting something back. This fails the
-- run rather than leaving a phone to find out.
-- ============================================================
do $check$
declare
    missing text;
    v text;
begin
    -- Every function exists, and none of them is open to an anonymous caller.
    select string_agg(f, ', ') into missing
      from unnest(array['my_employee_sync_ids()', 'sees_all_jobs()', 'my_visible_job_sync_ids()',
                        'can_see_job(uuid)', 'crew_job_guard(uuid)', 'crew_strip_assignment(jsonb)',
                        'my_job_scope()', 'list_requestable_jobs()', 'request_job_access(uuid,text)',
                        'withdraw_job_access_request(uuid)', 'decide_job_access(uuid,boolean,text)',
                        'set_job_crew(uuid,uuid[])', 'end_job_assignment(uuid)',
                        'job_status_is_requestable(text)', 'deleted_job_sync_ids(uuid[])']) f
     where to_regprocedure('public.' || f) is null
        or has_function_privilege('anon', to_regprocedure('public.' || f), 'execute');
    if missing is not null then
        raise exception 'missing, or executable by anon: %', missing;
    end if;

    -- The four crew doors are scoped and still security barriers.
    foreach v in array array['jobs_crew', 'estimate_line_items_crew', 'change_orders_crew', 'time_entries_crew'] loop
        if position(case when v = 'time_entries_crew' then 'is_my_shift' else 'my_visible_job_sync_ids' end
                    in pg_get_viewdef(('public.' || v)::regclass, true)) = 0 then
            raise exception '% is not scoped', v;
        end if;
        if not exists (select 1 from pg_class c where c.oid = ('public.' || v)::regclass
                          and 'security_barrier=true' = any(coalesce(c.reloptions, '{}'))) then
            raise exception '% lost security_barrier', v;
        end if;
    end loop;

    -- No crew door can be written through.
    select string_agg(table_name || ':' || privilege_type, ', ') into missing
      from information_schema.role_table_grants
     where table_schema = 'public' and grantee in ('authenticated', 'anon')
       and table_name like '%\_crew' and privilege_type <> 'SELECT';
    if missing is not null then
        raise exception 'crew views still writable: %', missing;
    end if;

    -- Every narrowing policy is in place, the side doors (PART 1c) included.
    select string_agg(t.tab || '.' || t.pol, ', ') into missing
      from (select x as tab, x || '_only_visible_jobs' as pol
              from unnest(array['fence_runs', 'job_steps', 'site_markers', 'punch_list_items', 'field_changes',
                                'job_stage_events', 'quote_reapprovals', 'attention_findings',
                                'automation_flags', 'automation_runs', 'follow_up_log']) x
            union all
            select x, x || y
              from unnest(array['estimate_line_items', 'change_orders', 'expenses']) x,
                   unnest(array['_insert_only_visible_jobs', '_update_only_visible_jobs']) y
            union all
            select 'attention_findings', 'attention_findings_money_hidden_from_crew'
            union all
            select 'customers', y
              from unnest(array['customers_need_contact_permission', 'customers_insert_needs_edit_jobs',
                                'customers_update_needs_edit_jobs']) y) t
     where not exists (select 1 from pg_policies p
                        where p.schemaname = 'public' and p.tablename = t.tab
                          and p.policyname = t.pol and p.permissive = 'RESTRICTIVE');
    if missing is not null then
        raise exception 'narrowing policy missing: %', missing;
    end if;

    -- A worked shift always uploads: nothing here may narrow time_entries.
    if exists (select 1 from pg_policies p
                where p.schemaname = 'public' and p.tablename = 'time_entries'
                  and (coalesce(p.qual, '') || coalesce(p.with_check, '')) ~ 'my_visible_job_sync_ids|can_see_job|sees_all_jobs') then
        raise exception 'a policy on time_entries now depends on job visibility -- shifts would stop uploading';
    end if;

    -- The pens carry the guard (a later wholesale replacement would drop it).
    if position('crew_job_guard' in pg_get_functiondef('public.crew_save_job(jsonb)'::regprocedure)) = 0
       or position('crew_strip_assignment' in pg_get_functiondef('public.crew_save_job(jsonb)'::regprocedure)) = 0 then
        raise exception 'crew_save_job lost its guard -- re-run supabase_crew_job_scope.sql';
    end if;
    -- Both halves: the job a line names, and the job it is on now.
    if position('can_see_job(j.sync_id)' in pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure)) = 0
       or position('can_see_job(e.job_sync_id)' in pg_get_functiondef('public.crew_push_line_items(jsonb)'::regprocedure)) = 0 then
        raise exception 'crew_push_line_items lost its guard -- re-run supabase_crew_job_scope.sql';
    end if;
    if position('crew_job_guard' in pg_get_functiondef('public.set_production_stage(text, text)'::regprocedure)) = 0 then
        raise exception 'set_production_stage lost its guard -- re-run supabase_crew_job_scope.sql';
    end if;
    -- crew_push_change_orders (supabase_r6_crew_change_orders.sql) is not
    -- patched here: it asks can_see_job itself on every call, and refuses the
    -- call when job scope is present without can_see_job(uuid). A later
    -- rewrite that drops either would widen it to the whole company while the
    -- change_orders policies above stay scoped (verifier row J24, 2026-09-22).
    -- (to_regprocedure, not a ::regprocedure cast: the cast of a constant is
    -- resolved at plan time and would raise when the function is absent.)
    v := pg_get_functiondef(to_regprocedure('public.crew_push_change_orders(jsonb)'));
    if v is not null
       and (position('can_see_job($1)' in v) = 0 or position('scope_present and not scoped' in v) = 0) then
        raise exception 'crew_push_change_orders is not job-scoped, or no longer fails closed -- '
                        'merge the scope lines from supabase_r6_crew_change_orders.sql back into it';
    end if;

    -- The sweep and the push read the real assignee column.
    if position('assigned_employee_id is null' in pg_get_functiondef('public.attention_sweep_candidates()'::regprocedure)) > 0 then
        raise exception 'attention_sweep_candidates still tests assigned_employee_id';
    end if;
    if exists (select 1 from pg_trigger t
                where t.tgrelid = 'public.jobs'::regclass and t.tgname = 'job-change-push'
                  and position('assigned_employee_sync_id' in pg_get_triggerdef(t.oid)) = 0) then
        raise exception 'job-change-push still listens to assigned_employee_id';
    end if;
end $check$;

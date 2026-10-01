-- supabase_a28_crew_enquiry_capture.sql
--
-- ############################################################################
-- #  STATUS: NOT APPLIED.  Written 2026-10-01.                               #
-- #                                                                          #
-- #  Nothing in this file has been run against any database. It was checked  #
-- #  by reading the live catalogue (SELECTs only) and by the static tests in #
-- #  tests/a28-capture.test.mjs; the function body has NEVER been executed.  #
-- #  Apply it in a rolled-back transaction first, with the proof checklist   #
-- #  at the bottom, before it is applied for real.                           #
-- ############################################################################
--
-- KIND
--   ADDITIVE           one table (crew_enquiries) and one function
--                      (crew_capture_enquiry). No existing function, trigger,
--                      policy, grant or row is changed. has_permission() is NOT
--                      touched (see below: it needs no change).
--   The one optional behavioural change (a restrictive INSERT policy on jobs)
--   is written at the bottom, COMMENTED OUT, because it closes something that
--   is open today and that is the owner's call, not this file's.
--
-- THE OWNER'S ANSWER (this is the whole brief)
--   "I want the crew to be able to do quotes just in case they are doing a job
--   and the neighbour asks." Asked how far that should go, he chose CAPTURE
--   ONLY, granted PER PERSON: a nominated crew member records the enquiry on
--   the spot, it reaches the office, and the OFFICE prices it. No price, total,
--   rate or deposit ever reaches a crew phone.
--
-- WHAT THIS BUILDS
--   public.crew_capture_enquiry(p_capture jsonb) -- the one door. A caller who
--   holds CAPTURE_ENQUIRY (granted per person, held by no role) creates a DRAFT
--   job in their own company: the same record the public get-a-quote form makes
--   (supabase/functions/lead-intake), which the office already works as a lead.
--   It lands in the "New Lead" stage, is chased by the existing
--   uncontacted_lead alert once it is four hours old, and shows in the office's
--   job sheet with its photos (the app uploads them to
--   {company}/{lead sync id}/photo/, the folder the job sheet already lists).
--   Nothing about a price is written: the BEFORE INSERT hold on jobs
--   (hold_money_columns) zeroes every money column for this caller anyway, and
--   this function names none.
--
--   public.crew_enquiries -- who captured which lead, when. Read by the office
--   only; written only by the function. It is also what makes a retry harmless
--   (the same capture id sent twice answers "already have it", never a second
--   lead) and what the per-person hourly limit counts.
--
-- WHAT THE CREW MEMBER NEVER GETS BACK -- AND WHAT IS LIVE TODAY
--   The function answers {"job_sync_id": ..., "created": ...} and nothing else:
--   no job row, no status, no total. The phone never reads the lead afterwards
--   (it has no select on jobs; see EnquiryCaptureSender.kt). Beyond that:
--     1. NOTHING HERE ASSIGNS THE LEAD TO THE CAPTURER. assigned_employee_sync_id
--        is left null and no assignment row is written (the self-check below
--        refuses a function that mentions either).
--     2. crew_enquiries has no policy a crew member can read through (PART 1):
--        the office sees who captured what, the capturer sees nothing.
--     3. THE MONEY IS NOT IN ANY VIEW A CREW LOGIN READS. Live, 2026-10-01: the
--        jobs_crew view lists no column of job_money_columns() (accepted_total,
--        contract_total, the rates, deposit and payments all absent), the base
--        jobs table is closed to a caller without SEE_MONEY by the RESTRICTIVE
--        policy jobs_money_hidden_from_crew, and estimate_line_items and
--        change_orders are closed the same way. A priced lead is therefore
--        priced out of the capturer's sight whoever else can see the job.
--   WHAT IS ALSO TRUE, AND SHOULD BE KNOWN: supabase_crew_job_scope.sql IS NOT
--   APPLIED to the live database (job_assignments, job_access_requests,
--   sees_all_jobs(), can_see_job(), my_visible_job_sync_ids() and my_job_scope()
--   all return "does not exist", read 2026-10-01). So TODAY every crew login
--   already reads EVERY job of its company through jobs_crew, money-free; the
--   lead this function makes is one more of those, visible to its capturer as
--   every other job is, with no price on it. Once that file is applied a scoped
--   crew member sees only the jobs they are on, and (1) above is what keeps the
--   capturer off this one. This file therefore does not depend on that one:
--   the read policy below spells out sees_all_jobs() instead of calling it.
--
-- THE SERVER NEEDS NO has_permission() CHANGE
--   Read from the live database 2026-10-01 (not from the repo): has_permission()
--   answers an override generically -- position('+' || perm in overrides) -- and
--   lists the permission under NO role, so "+CAPTURE_ENQUIRY" on a profile
--   grants it, "-CAPTURE_ENQUIRY" revokes it, OWNER holds it (as it holds every
--   permission) and nobody else does by default. That is exactly the Kotlin
--   table (Permissions.kt: in no role's defaults). The substring match means no
--   permission name may contain another; EnquiryCaptureTest holds the names to
--   that. supabase/functions/_shared/job-push.ts keeps its own copy of the role
--   table; it likewise needs no entry, because the permission is in no role.
--
-- APPLY ORDER
--   Independent of supabase_crew_job_scope.sql, which is not applied. This file
--   calls only current_company_id(), company_is_suspended() and has_permission(),
--   all live (read from the catalogue 2026-10-01).
--   Ship it BEFORE or WITH the app release that carries the capture screen: until
--   it is applied, a captured enquiry waits on the phone (the server answers
--   "could not find the function", which the app reads as "not switched on yet"
--   -- see classifyEnquirySend) and nothing is lost. The app release does not
--   need this file to run.
--
-- STORAGE: PHOTOS INTO A JOB THE CAPTURER CANNOT SEE
--   The app uploads each photo to job-files at
--   {company}/{lead sync id}/photo/{file}. Today the bucket's policies only ask
--   that the first folder be the caller's company, so this works. If the
--   restrictive per-job storage policies that supabase_crew_job_scope.sql holds
--   back (job_files_only_visible_jobs_*, "Not done here, on purpose") are ever
--   created, they would refuse the capturer's INSERT, because the capturer
--   cannot see the lead. Those policies must then let an INSERT of
--   kind 'photo' through when
--       exists (select 1 from public.crew_enquiries e
--                where e.company_id = public.current_company_id()
--                  and e.job_sync_id::text = (storage.foldername(name))[2]
--                  and e.captured_by = auth.uid())
--   This file does not create that exemption: the policies it would amend do
--   not exist yet, and an exemption with nothing to exempt from is dead code.
--
-- ROLLBACK
--   drop function if exists public.crew_capture_enquiry(jsonb);
--   drop table if exists public.crew_enquiries;
--   Leads already created stay (they are ordinary jobs); only the "who captured
--   it" record goes.
--
-- PROOF CHECKLIST (run after applying inside begin ... rollback, in the style of
-- supabase_crew_job_scope_probe.sql; every check needs its positive control)
--   a. A CREW login with "+CAPTURE_ENQUIRY" in permission_overrides: the call
--      creates one jobs row (DRAFT, referral_source 'Crew on site', every money
--      column zero/null, assigned_employee_sync_id null) and one crew_enquiries
--      row; calling again with the same sync_id returns created=false and adds
--      neither.   CONTROL: the same call as an OWNER also works.
--   b. The same CREW login WITHOUT the override: 42501 "You cannot capture
--      enquiries."   CONTROL: (a) just worked for the same login with it.
--   c. The same login with "+CAPTURE_ENQUIRY,-CAPTURE_ENQUIRY": 42501 (revocation
--      wins, as in has_permission()).
--   d. After (a), price the lead as the office (set contract_total, add a line
--      item), then as the capturing CREW login: select from crew_enquiries
--      returns no row; select from jobs_crew where sync_id = the lead returns
--      the row WITH NO MONEY COLUMN (today, because every crew login reads every
--      job through that view) -- or NO row at all once supabase_crew_job_scope.sql
--      is applied; select from the base jobs table and from estimate_line_items
--      return nothing.   CONTROL: a manager reads the lead with its total, and
--      the same crew login reads a job it was assigned.
--   e. The same call from a crew login of a DIFFERENT company, with the first
--      company's lead id as sync_id: refused (22023); and a lead of the first
--      company is not touched.
--   f. 21 captures in an hour from one login: the 21st raises 54000.
--   g. anon: no EXECUTE.   h. A suspended company: 42501 "Company suspended".
--
-- Every sentence this function raises is matched by classifyEnquirySend in
-- app/src/main/java/com/fenceestimator/app/ui/crew/EnquiryCaptureLogic.kt, and
-- tests/a28-capture.test.mjs holds the two together: change one, change both.


-- ============================================================
-- PART 1 -- who captured which lead
-- ============================================================
create table if not exists public.crew_enquiries (
    company_id uuid not null references public.companies(id) on delete cascade,
    job_sync_id uuid not null,
    captured_by uuid references public.profiles(id) on delete set null,
    -- The name as the SERVER knows the person (profiles.full_name), never a
    -- name the phone sent.
    captured_by_name text not null default '',
    -- When the neighbour asked, as the phone recorded it, clamped to the last
    -- seven days and never in the future. jobs.created_at carries the same
    -- moment, so the office's call-back clock starts when they asked.
    captured_at timestamptz not null,
    received_at timestamptz not null default now(),
    primary key (company_id, job_sync_id),
    constraint crew_enquiries_job_fk foreign key (company_id, job_sync_id)
        references public.jobs(company_id, sync_id) on delete cascade
);

comment on table public.crew_enquiries is
  'Which lead a crew member captured on site, and when (supabase_a28_crew_enquiry_capture.sql). '
  'Written only by crew_capture_enquiry. Readable by whoever sees every job; never by the person who '
  'captured it, so nothing about the lead can reach them through here.';

create index if not exists crew_enquiries_by_person
    on public.crew_enquiries(company_id, captured_by, received_at);

alter table public.crew_enquiries enable row level security;
revoke all on public.crew_enquiries from anon, authenticated;
grant select on public.crew_enquiries to authenticated;
grant all on public.crew_enquiries to service_role;

-- The office, never the capturer. A crew member who captured a lead and holds
-- none of SEE_MONEY, EDIT_JOBS, SCHEDULE_AND_ASSIGN reads nothing here.
drop policy if exists crew_enquiries_read on public.crew_enquiries;
create policy crew_enquiries_read on public.crew_enquiries
    for select to authenticated
    using (company_id = public.current_company_id()
           -- sees_all_jobs(), spelled out so this file stands alone: that
           -- function belongs to supabase_crew_job_scope.sql, which is not live.
           and (select coalesce(public.has_permission('SEE_MONEY'), false)
                    or coalesce(public.has_permission('EDIT_JOBS'), false)
                    or coalesce(public.has_permission('SCHEDULE_AND_ASSIGN'), false)));


-- ============================================================
-- PART 2 -- the door
-- ============================================================
-- Answers in SQLSTATEs and fixed sentences, like request_job_access:
--   42501  not allowed (not signed in, suspended, no CAPTURE_ENQUIRY)
--   22023  something it will not take (a field, or an id that is not this
--          capture's) -- retrying the same bytes cannot change it
--   54000  more than 20 in an hour from one person
create or replace function public.crew_capture_enquiry(p_capture jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
    uid  uuid := auth.uid();
    co   uuid := public.current_company_id();
    sid  uuid;
    nm   text;
    ph   text;
    em   text;
    ad   text;
    fk   text;
    nt   text;
    ft   int;
    cap  timestamptz;
    who  text;
    n    int;
    made int;
    body text;
begin
    if uid is null or co is null then
        raise exception 'Sign in first.' using errcode = '42501';
    end if;
    if public.company_is_suspended() then
        raise exception 'Company suspended' using errcode = '42501';
    end if;
    -- Per person, never per role: has_permission() reads this caller's role and
    -- their own overrides, and no role lists CAPTURE_ENQUIRY.
    if not coalesce(public.has_permission('CAPTURE_ENQUIRY'), false) then
        raise exception 'You cannot capture enquiries.' using errcode = '42501';
    end if;
    if jsonb_typeof(p_capture) is distinct from 'object' then
        raise exception 'Nothing to capture.' using errcode = '22023';
    end if;

    -- The capture's own id is the lead's sync id. A guarded cast, so a malformed
    -- one answers 22023 rather than a cast error.
    if coalesce(p_capture->>'sync_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'The capture id is not valid.' using errcode = '22023';
    end if;
    sid := (p_capture->>'sync_id')::uuid;

    nm := left(btrim(coalesce(p_capture->>'customer_name', '')), 120);
    ph := left(btrim(coalesce(p_capture->>'phone', '')), 40);
    em := left(btrim(coalesce(p_capture->>'email', '')), 120);
    ad := left(btrim(coalesce(p_capture->>'address', '')), 200);
    nt := left(btrim(coalesce(p_capture->>'notes', '')), 1000);
    fk := left(btrim(coalesce(p_capture->>'fence_type', '')), 30);

    -- The same three rules as the public get-a-quote form, plus the address:
    -- somebody was promised a call, and the office has to know where the fence is.
    if length(nm) < 2 then
        raise exception 'Their name is needed.' using errcode = '22023';
    end if;
    if length(ph) < 7 and position('@' in em) = 0 then
        raise exception 'A phone number or an email is needed.' using errcode = '22023';
    end if;
    if em <> '' and position('@' in em) = 0 then
        raise exception 'That email address is not valid.' using errcode = '22023';
    end if;
    if length(ad) < 5 then
        raise exception 'The address is needed.' using errcode = '22023';
    end if;

    -- A rough length. Garbage is ignored, not refused: it is a guess, and a
    -- capture is never lost over one.
    ft := null;
    if coalesce(p_capture->>'approx_feet', '') ~ '^[0-9]{1,5}$' then
        ft := (p_capture->>'approx_feet')::int;
        if ft < 1 or ft > 20000 then
            ft := null;
        end if;
    end if;

    -- When they asked, clamped: a phone with a wrong clock cannot back-date a
    -- lead past a week or date it in the future.
    cap := now();
    if coalesce(p_capture->>'captured_at_ms', '') ~ '^[0-9]{10,14}$' then
        cap := to_timestamp(((p_capture->>'captured_at_ms')::numeric / 1000.0)::double precision);
        cap := least(now(), greatest(cap, now() - interval '7 days'));
    end if;

    -- One capture at a time per person until this transaction ends: the retry
    -- check and the hourly count below are read under it, so two sends racing
    -- cannot both pass them.
    perform pg_advisory_xact_lock(hashtext('crew_enquiry:' || uid::text));

    -- The same capture again (the answer was lost, or the phone retried): it is
    -- already here. Checked BEFORE the limit, so a retry is never refused for
    -- being one of many.
    if exists (select 1 from public.crew_enquiries e
                where e.company_id = co and e.job_sync_id = sid and e.captured_by = uid) then
        return jsonb_build_object('job_sync_id', sid, 'created', false);
    end if;

    select count(*) into n from public.crew_enquiries e
     where e.company_id = co and e.captured_by = uid and e.received_at > now() - interval '1 hour';
    if n >= 20 then
        raise exception 'You have captured 20 enquiries in the last hour. Try again later.'
            using errcode = '54000';
    end if;

    select coalesce(nullif(btrim(p.full_name), ''), 'Crew') into who
      from public.profiles p where p.id = uid;
    who := coalesce(who, 'Crew');

    -- What the office reads on the lead. In English, like the website lead's
    -- "From the website: ..." note; the structured values are on the lead's
    -- own columns (name, phone, email, address).
    body := 'Captured on site by ' || who || ' (crew enquiry).';
    if fk <> '' then
        body := body || E'\nFence wanted: ' || case fk
            when 'VINYL' then 'Vinyl'
            when 'WOOD' then 'Wood'
            when 'CHAIN_LINK' then 'Chain link'
            when 'ALUMINUM' then 'Aluminum'
            when 'ORNAMENTAL_IRON' then 'Ornamental iron'
            when 'SPLIT_RAIL' then 'Split rail'
            when 'COMPOSITE' then 'Composite'
            else initcap(replace(lower(fk), '_', ' '))
        end;
    else
        body := body || E'\nFence wanted: not sure';
    end if;
    if ft is not null then
        body := body || E'\nRoughly: ' || ft::text || ' ft (a guess, not measured)';
    else
        body := body || E'\nLength: not sure';
    end if;
    if nt <> '' then
        body := body || E'\n' || nt;
    end if;

    -- The lead: a DRAFT job, the record the office already works as a lead.
    -- No money column is named, and none can be set: hold_money_columns() zeroes
    -- them for a caller without SEE_MONEY. No assignee is named either -- see the
    -- header: the capturer is not put on the job.
    insert into public.jobs (company_id, sync_id, customer_name, phone, email, address,
                             notes, referral_source, status, created_at)
    values (co, sid, nm, ph, em, ad, body, 'Crew on site', 'DRAFT', cap)
    on conflict (company_id, sync_id) do nothing;
    get diagnostics made = row_count;
    if made = 0 then
        -- A job with this id already exists and is not this person's capture
        -- (we returned above for that). It must not be answered as theirs.
        raise exception 'The capture id is not valid.' using errcode = '22023';
    end if;

    insert into public.crew_enquiries (company_id, job_sync_id, captured_by, captured_by_name, captured_at)
    values (co, sid, uid, who, cap);

    return jsonb_build_object('job_sync_id', sid, 'created', true);
end
$fn$;

revoke all on function public.crew_capture_enquiry(jsonb) from public, anon;
grant execute on function public.crew_capture_enquiry(jsonb) to authenticated, service_role;


-- ============================================================
-- PART 3 -- self-check. Fails loudly, and the whole file rolls back with it.
-- ============================================================
do $check$
declare
    bad text[];
    c text;
begin
    if not exists (select 1 from pg_proc p
                    where p.oid = 'public.crew_capture_enquiry(jsonb)'::regprocedure and p.prosecdef) then
        raise exception 'crew_capture_enquiry is not a SECURITY DEFINER function';
    end if;
    if not exists (select 1 from pg_proc p
                    where p.oid = 'public.crew_capture_enquiry(jsonb)'::regprocedure
                      and exists (select 1 from unnest(p.proconfig) s where s like 'search_path=%')) then
        raise exception 'crew_capture_enquiry does not pin its search_path';
    end if;
    -- Nobody but a signed-in login (and the server) may call it.
    if has_function_privilege('anon', 'public.crew_capture_enquiry(jsonb)', 'execute') then
        raise exception 'anon can execute crew_capture_enquiry';
    end if;
    if exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = 'public.crew_capture_enquiry(jsonb)'::regprocedure
                  and a.grantee = 0 and a.privilege_type = 'EXECUTE') then
        raise exception 'PUBLIC can execute crew_capture_enquiry';
    end if;
    -- The provenance table is the office's to read and the function's to write.
    if not (select relrowsecurity from pg_class where oid = 'public.crew_enquiries'::regclass) then
        raise exception 'crew_enquiries does not have row level security on';
    end if;
    if has_table_privilege('authenticated', 'public.crew_enquiries', 'INSERT')
       or has_table_privilege('authenticated', 'public.crew_enquiries', 'UPDATE')
       or has_table_privilege('authenticated', 'public.crew_enquiries', 'DELETE')
       or has_table_privilege('anon', 'public.crew_enquiries', 'SELECT') then
        raise exception 'crew_enquiries is writable by a login, or readable by anon';
    end if;
    -- Every jobs column the function writes is a real one, and none is money.
    select array_agg(x) into bad
      from unnest(array['company_id', 'sync_id', 'customer_name', 'phone', 'email', 'address',
                        'notes', 'referral_source', 'status', 'created_at']) x
     where not exists (select 1 from information_schema.columns ic
                        where ic.table_schema = 'public' and ic.table_name = 'jobs' and ic.column_name = x)
        or x = any (public.job_money_columns());
    if bad is not null then
        raise exception 'crew_capture_enquiry writes jobs columns that do not exist, or that are money: %', bad;
    end if;
    -- It never assigns the lead to anyone.
    c := pg_get_functiondef('public.crew_capture_enquiry(jsonb)'::regprocedure);
    if c ~* 'assigned_employee' or c ~* 'job_assignments' then
        raise exception 'crew_capture_enquiry assigns the lead -- that would show the capturer what it is priced at';
    end if;
end $check$;

select 'a28 crew enquiry capture: table and function in place' as done;


-- ============================================================
-- OPTIONAL, NOT RUN: close the direct insert (a decision for the owner)
-- ============================================================
-- WHAT IS OPEN TODAY (read from the live catalogue 2026-10-01). The jobs
-- INSERT policy is `with check (company_id = current_company_id())` and nothing
-- more, and `authenticated` holds INSERT on jobs. So ANY signed-in login of a
-- company -- a crew member included -- can POST a job row straight to the REST
-- API with no permission at all. The money columns are zeroed on the way in
-- (hold_money_columns), so what they can make is an empty DRAFT shell, not a
-- priced job; and the app never does it (JobSync leaves a job a crew phone has
-- never seen from the cloud alone). But it means CAPTURE_ENQUIRY, like
-- EDIT_JOBS before it, is enforced at the app and at this function, not at the
-- table: a person who was never given it can still create a lead by hand.
--
-- THE FIX, if wanted: a RESTRICTIVE insert policy, so it can only narrow.
-- Callers it must keep working: holders of EDIT_JOBS (owner, manager, sales) and
-- of SEE_MONEY (an accountant's phone inserts a job it created, JobSync's
-- ALLOWED path). The service role (lead-intake, the webhooks) and the SECURITY
-- DEFINER functions (this one) bypass row level security and are unaffected.
-- Before running it, grep the dashboard, the app and every edge function for
-- anything that inserts into jobs as a login holding neither permission.
--
--   create policy jobs_insert_needs_job_permission on public.jobs
--       as restrictive for insert
--       with check ((select coalesce(public.has_permission('EDIT_JOBS'), false)
--                         or coalesce(public.has_permission('SEE_MONEY'), false)));
--
--   rollback: drop policy jobs_insert_needs_job_permission on public.jobs;

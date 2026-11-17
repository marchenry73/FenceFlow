-- ============================================================
-- FenceFlow -- ONE restore rule, on the server, for the office AND the phone
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- The owner, 17 Nov 2026: he could not find his deleted items to restore
-- them, and wants to restore from the website as well as the phone.
--
-- WHY THE OFFICE HAD NO RESTORE BUTTON, and why that was right until now. The
-- office said so on the page: "Put something back from the app ... Restoring a
-- job also brings back the parts deleted with it, and that rule lives in the
-- app so there is only one copy of it." The rule was in TrashBin.restore on the
-- phone. A second copy in dashboard.html is how two restores drift apart -- the
-- phone's version carries two hard-won corrections (below) that a fresh copy
-- would have to rediscover.
--
-- SO THE RULE MOVES HERE, and both clients call it. Still one copy.
--
-- THE RULE, exactly as TrashBin.restore has it:
--   1. Clear deleted_at and deleted_by on the record.
--   2. For a JOB, bring back its children too -- fence_runs,
--      estimate_line_items, change_orders, job_steps, site_markers, expenses,
--      punch_list_items, time_entries. A job restored alone has no fence runs,
--      so no footage, so no labour charge: it came back looking like it was
--      worth only its materials.
--   3. But ONLY children deleted with the job -- within a minute of it.
--      Clearing every child tombstone resurrected things deleted on purpose
--      weeks earlier: restore a job and a line item removed deliberately was
--      back on the estimate at its old price.
--
-- ONE DIFFERENCE, DELIBERATE: IT IS ATOMIC. The phone cleared each child in its
-- own runCatching, so a child table that refused left a job restored without
-- part of itself. Here it all happens in one statement's transaction: the job
-- comes back whole, or not at all and the caller is told why.
--
-- ------------------------------------------------------------------------
-- SECURITY INVOKER -- AND WHY THAT IS THE SAFE CHOICE
-- ------------------------------------------------------------------------
-- It runs with the CALLER's own rights. Row-level security and every existing
-- trigger apply exactly as they did to the phone's direct UPDATE, so this
-- opens no door that was not already open. Measured before writing: signed in
-- as the owner, the phone's exact restore UPDATE succeeds on a deleted job and
-- a deleted catalog item (rolled back). A SECURITY DEFINER version would have
-- needed its own permission check, and a missed case there is a way for crew
-- to undo an owner's deletion.
--
-- The table name is whitelisted before it is ever formatted into SQL, and
-- %I quotes it besides. Rows are always scoped to the caller's own company as
-- well as by RLS -- belt and braces, because restore writes.
--
-- Idempotent. PART 2 raises rather than reporting.
-- ============================================================

begin;

-- ------------------------------------------------------------------------
-- PART 1  the rule
-- ------------------------------------------------------------------------
create or replace function public.restore_deleted(p_table text, p_sync_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path to 'public'
as $$
declare
    v_co uuid;
    v_deleted_at timestamptz;
    v_main int := 0;
    v_children int := 0;
    v_n int;
    v_child text;
begin
    -- auth.uid() is null for anon AND for the service role, so a null company
    -- here covers both: nobody restores without being somebody.
    select company_id into v_co from profiles where id = auth.uid();
    if v_co is null then
        raise exception 'Sign in to restore anything.';
    end if;

    -- The same seven kinds TrashBin.kt RECOVERABLE and dashboard.html
    -- TRASH_TABLES list (tests/a74 holds those two together; tests/a173 holds
    -- this one to them).
    if p_table not in ('jobs', 'change_orders', 'expenses', 'employees',
                       'material_items', 'fence_runs', 'punch_list_items') then
        raise exception 'That kind of record cannot be restored here.';
    end if;

    execute format(
        'select deleted_at from public.%I where company_id = $1 and sync_id = $2', p_table)
      into v_deleted_at using v_co, p_sync_id;

    -- Already live, or not this company's: nothing to do, and not an error --
    -- a second tap on Restore, or the phone and the office both restoring the
    -- same thing, must be harmless.
    if v_deleted_at is null then
        return jsonb_build_object('restored', 0, 'children', 0);
    end if;

    execute format(
        'update public.%I set deleted_at = null, deleted_by = '''' '
        'where company_id = $1 and sync_id = $2 and deleted_at is not null', p_table)
      using v_co, p_sync_id;
    get diagnostics v_main = row_count;

    if p_table = 'jobs' and v_main > 0 then
        foreach v_child in array array[
            'fence_runs', 'estimate_line_items', 'change_orders', 'job_steps',
            'site_markers', 'expenses', 'punch_list_items', 'time_entries'] loop
            -- Only what went with the job: deleted no more than a minute
            -- before it. The minute covers the delete cascade stamping its
            -- rows a moment apart, exactly as TrashBin.restore allows.
            execute format(
                'update public.%I set deleted_at = null, deleted_by = '''' '
                'where company_id = $1 and job_sync_id = $2 and deleted_at >= $3', v_child)
              using v_co, p_sync_id, v_deleted_at - interval '60 seconds';
            get diagnostics v_n = row_count;
            v_children := v_children + v_n;
        end loop;
    end if;

    return jsonb_build_object('restored', v_main, 'children', v_children);
end $$;

comment on function public.restore_deleted(text, uuid) is
  'The one restore rule, for the office and the phone. SECURITY INVOKER: runs with the caller''s own rights, so RLS and triggers apply exactly as to a direct UPDATE. A job brings back only the children deleted within a minute of it. Atomic.';

-- New functions are executable by PUBLIC by default. Nobody unauthenticated
-- may call this; it would refuse them anyway, but refusing at the door is
-- cheaper than refusing inside.
revoke all on function public.restore_deleted(text, uuid) from public, anon;
grant execute on function public.restore_deleted(text, uuid) to authenticated;

-- ------------------------------------------------------------------------
-- PART 2  prove it. Every check raises rather than reporting.
-- ------------------------------------------------------------------------
do $$
declare d record;
begin
    select p.prosecdef, p.proname into d
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'restore_deleted';
    if d.proname is null then raise exception 'r74: restore_deleted is missing'; end if;
    if d.prosecdef then
        raise exception 'r74: restore_deleted is SECURITY DEFINER -- it would run past RLS with no permission check of its own';
    end if;
    if has_function_privilege('anon', 'public.restore_deleted(text, uuid)', 'EXECUTE') then
        raise exception 'r74: anon can execute restore_deleted';
    end if;
    if not has_function_privilege('authenticated', 'public.restore_deleted(text, uuid)', 'EXECUTE') then
        raise exception 'r74: signed-in users cannot execute restore_deleted';
    end if;
    raise notice 'r74 OK: one restore rule, run with the caller''s own rights';
end $$;

commit;

-- ------------------------------------------------------------------------
-- STILL OPEN after this
-- ------------------------------------------------------------------------
--   1. The phone still runs its own copy (TrashBin.restore) until the app
--      release that switches it to this function. Both copies follow the same
--      rule in the meantime, so they agree; the old one is deleted in that
--      release so there is one again.
--   2. The behaviour -- a job bringing back only what went with it -- is
--      exercised as the owner by tests/a173, not here: this file runs as the
--      migration role, which has no company, so the function would refuse it.

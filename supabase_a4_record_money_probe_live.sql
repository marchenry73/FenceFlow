-- ============================================================================
-- CHECKS THE RECORD_MONEY GATE AGAINST WHATEVER IS LIVE RIGHT NOW.
--
-- The same probe as supabase_a4_record_money_probe.sql with the staged
-- function bodies taken out, so it measures the LIVE has_permission,
-- record_money_trusted and hold_money_columns rather than a copy. Every
-- write is inside the transaction and the transaction is rolled back.
--
-- Run it after applying the fix, and again any time somebody wonders whether
-- the gate is still there. A deployed timestamp is not evidence; this is.
--
-- Run:
--   npx --no-install supabase@2.115.0 db query --linked \
--     --project-ref newcrgafcptspmapacrx -f supabase_a4_record_money_probe_live.sql
--
-- THE TRAPS THIS PROBE IS BUILT AROUND, all of them met before on this
-- project:
--
--  * money_caller_trusted() and record_money_trusted() both return TRUE when
--    request.jwt.claims is empty -- that is how migrations and the service
--    role get through. A probe that forgets to set the claims is "allowed"
--    for the wrong reason and proves nothing. Claims are set explicitly, with
--    `set local role authenticated` alongside them.
--
--  * POSITIVE CONTROLS, three of them, because a refusal is only evidence if
--    something comparable is accepted in the same breath:
--      - the same manager writing a NON-money column must still succeed, or
--        the probe is measuring a broken connection rather than a gate;
--      - the same manager writing a PRICE column must still succeed, or the
--        fix has quietly taken pricing away from managers;
--      - an OWNER must still be able to do the thing the manager cannot, or
--        the fix has locked the owner out of his own app.
--
--  * Fixtures are chosen BY PROPERTY and asserted, never by name, and the
--    probe STOPS and says so rather than reporting a clean sheet it did not
--    measure. An empty answer must never read as good news.
-- ============================================================================

begin;

create temporary table probe (n int, step text, measured text, verdict text) on commit drop;
grant insert, select on probe to authenticated;

-- ------------------------------------------------------------- the probe --

do $probe$
declare
    mgr_id    uuid;  mgr_co   uuid;
    own_id    uuid;
    job_id    uuid;   other_job uuid;
    before_amt double precision; after_amt double precision;
    before_st  text;             after_st  text;
    before_tot double precision; after_tot double precision;
    before_note text;            after_note text;
    n int;
begin
    -- ---- fixtures, by property, asserted ----------------------------------
    select id, company_id into mgr_id, mgr_co
      from profiles where role = 'MANAGER' and company_id is not null
      order by id limit 1;
    if mgr_id is null then
        insert into probe values (0, 'fixture', 'no MANAGER profile with a company',
            'STOP - nothing to measure, and this is NOT a pass');
        return;
    end if;

    select id into own_id from profiles
     where role = 'OWNER' and company_id = mgr_co order by id limit 1;

    select id into job_id from jobs
     where company_id = mgr_co and deleted_at is null order by id limit 1;
    select id into other_job from jobs
     where company_id <> mgr_co and deleted_at is null order by id limit 1;
    if job_id is null then
        insert into probe values (0, 'fixture', 'that manager''s company has no job',
            'STOP - nothing to measure, and this is NOT a pass');
        return;
    end if;

    select amount_paid, payment_status, contract_total, locate_notes
      into before_amt, before_st, before_tot, before_note
      from jobs where id = job_id;

    insert into probe values (0, 'fixture',
        'MANAGER found; their company has jobs; an owner in the same company is ' ||
        case when own_id is null then 'NOT available' else 'available' end ||
        '; another company''s job is ' ||
        case when other_job is null then 'NOT available' else 'available' end,
        'ok');

    -- ---- become that manager ----------------------------------------------
    perform set_config('request.jwt.claims',
        json_build_object('sub', mgr_id, 'role', 'authenticated')::text, true);
    set local role authenticated;

    insert into probe values (1, 'MANAGER holds SEE_MONEY',
        coalesce(public.has_permission('SEE_MONEY'), false)::text,
        'unchanged -- they must still SEE money');
    insert into probe values (2, 'MANAGER holds RECORD_MONEY',
        coalesce(public.has_permission('RECORD_MONEY'), false)::text,
        case when coalesce(public.has_permission('RECORD_MONEY'), false)
             then 'WRONG - the whole point is that they do not'
             else 'correct' end);

    -- ---- THE ATTEMPT -------------------------------------------------------
    begin
        update jobs
           set amount_paid = coalesce(amount_paid, 0) + 12345,
               payment_status = 'PAID_IN_FULL'
         where id = job_id;
        get diagnostics n = row_count;
    exception when others then
        insert into probe values (3, 'UPDATE jobs.amount_paid as MANAGER', sqlerrm, 'refused outright');
    end;

    select amount_paid, payment_status into after_amt, after_st from jobs where id = job_id;
    insert into probe values (3, 'UPDATE amount_paid / payment_status as MANAGER',
        'amount_paid ' || coalesce(before_amt,0)::text || ' -> ' || coalesce(after_amt,0)::text ||
        ', status ' || coalesce(before_st,'(null)') || ' -> ' || coalesce(after_st,'(null)'),
        case when coalesce(after_amt,0) = coalesce(before_amt,0)
              and coalesce(after_st,'') = coalesce(before_st,'')
             then 'HELD - the money columns did not move'
             else 'STILL OPEN - the money columns moved' end);

    -- ---- CONTROL A: a price column must still be writable ------------------
    update jobs set contract_total = coalesce(contract_total, 0) + 7 where id = job_id;
    select contract_total into after_tot from jobs where id = job_id;
    insert into probe values (4, 'CONTROL: MANAGER writes a PRICE column (contract_total)',
        coalesce(before_tot,0)::text || ' -> ' || coalesce(after_tot,0)::text,
        case when coalesce(after_tot,-1) = coalesce(before_tot,0) + 7
             then 'accepted - pricing still works for managers'
             else 'ALARM - the fix took pricing away from managers' end);

    -- ---- CONTROL B: a plain column must still be writable ------------------
    update jobs set locate_notes = coalesce(locate_notes,'') || ' probe' where id = job_id;
    select locate_notes into after_note from jobs where id = job_id;
    insert into probe values (5, 'CONTROL: MANAGER writes an ordinary column',
        case when after_note is distinct from before_note then 'changed' else 'unchanged' end,
        case when after_note is distinct from before_note
             then 'accepted - the connection and RLS are really working'
             else 'ALARM - nothing is writable, so step 3 proves nothing' end);

    -- ---- CONTROL C: cross-company, which must be refused -------------------
    if other_job is not null then
        update jobs set locate_notes = coalesce(locate_notes,'') || ' probe' where id = other_job;
        get diagnostics n = row_count;
        insert into probe values (6, 'CONTROL: same MANAGER, another company''s job',
            'rows affected ' || n,
            case when n = 0 then 'refused - so this is running under RLS'
                 else 'ALARM - cross-company write succeeded' end);
    end if;

    reset role;
    perform set_config('request.jwt.claims', '', true);

    -- ---- CONTROL D: the OWNER must still be able to do it ------------------
    if own_id is not null then
        select amount_paid into before_amt from jobs where id = job_id;
        perform set_config('request.jwt.claims',
            json_build_object('sub', own_id, 'role', 'authenticated')::text, true);
        set local role authenticated;

        update jobs set amount_paid = coalesce(amount_paid,0) + 99 where id = job_id;
        select amount_paid into after_amt from jobs where id = job_id;

        reset role;
        perform set_config('request.jwt.claims', '', true);

        insert into probe values (7, 'CONTROL: the OWNER writes amount_paid',
            coalesce(before_amt,0)::text || ' -> ' || coalesce(after_amt,0)::text,
            case when coalesce(after_amt,0) = coalesce(before_amt,0) + 99
                 then 'accepted - the owner is not locked out of his own app'
                 else 'ALARM - the fix locked the OWNER out' end);
    end if;

    -- ---- CONTROL E: a +RECORD_MONEY override lets a named manager through --
    update profiles set permission_overrides =
        coalesce(nullif(permission_overrides,''), '') ||
        case when coalesce(permission_overrides,'') = '' then '' else ',' end || '+RECORD_MONEY'
      where id = mgr_id;

    select amount_paid into before_amt from jobs where id = job_id;
    perform set_config('request.jwt.claims',
        json_build_object('sub', mgr_id, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update jobs set amount_paid = coalesce(amount_paid,0) + 5 where id = job_id;
    select amount_paid into after_amt from jobs where id = job_id;
    reset role;
    perform set_config('request.jwt.claims', '', true);

    insert into probe values (8, 'CONTROL: MANAGER with a +RECORD_MONEY override',
        coalesce(before_amt,0)::text || ' -> ' || coalesce(after_amt,0)::text,
        case when coalesce(after_amt,0) = coalesce(before_amt,0) + 5
             then 'accepted - he can still give it to a named person'
             else 'ALARM - the override does not work, so the fix has no escape hatch' end);
end
$probe$;

select n, step, measured, verdict from probe order by n;

rollback;

-- ============================================================================
-- THE LEDGER ROUTE, AND THE HAND-WRITE HOLD, AGAINST WHATEVER IS LIVE NOW.
--
-- The companion to supabase_a4_record_money_probe_live.sql. That one proves a
-- manager cannot DECLARE money; this one proves the same manager can still
-- RECORD it -- because the first version of the RECORD_MONEY hold broke
-- exactly that, and the two failures look nothing like each other from the
-- outside:
--
--   * hold too weak  -> a manager marks a job paid with nothing behind it;
--   * hold too hard  -> a manager records a $250 cash payment, the ledger row
--                       lands, and the job's figure never moves, because
--                       recompute_job_totals() runs inside the manager's own
--                       session and its write was being reverted.
--
-- Both are measured here, in one transaction, so neither can pass by itself.
-- Step 3 is the one that distinguishes "frozen at the old value" from
-- "corrected to the ledger", which is the whole point of
-- supabase_a4_record_money_follows_the_ledger.sql.
--
-- Run:
--   npx --no-install supabase@2.115.0 db query --linked --     --project-ref newcrgafcptspmapacrx -f supabase_a4_ledger_route_probe_live.sql
--
-- Everything is inside BEGIN/ROLLBACK. The $250 ledger row is never kept.
-- ============================================================================

begin;
create temporary table probe (n int, step text, measured text, verdict text) on commit drop;
grant insert, select on probe to authenticated;

do $probe$
declare
    mgr_id uuid; mgr_co uuid; own_id uuid; job_sid uuid; job_row uuid; other_job uuid;
    b_amt double precision; a_amt double precision;
    b_st text; a_st text; b_tot double precision; a_tot double precision;
    ledger_sum double precision; n int;
begin
    select id, company_id into mgr_id, mgr_co
      from profiles where role='MANAGER' and company_id is not null order by id limit 1;
    select id into own_id from profiles where role='OWNER' and company_id=mgr_co order by id limit 1;
    select id, sync_id into job_row, job_sid from jobs
     where company_id=mgr_co and deleted_at is null order by id limit 1;
    select id into other_job from jobs where company_id<>mgr_co and deleted_at is null order by id limit 1;
    if mgr_id is null or job_sid is null then
        insert into probe values (0,'fixture','no manager or job','STOP - not a pass'); return;
    end if;
    select amount_paid, payment_status, contract_total into b_amt, b_st, b_tot from jobs where id=job_row;
    insert into probe values (0,'fixture','amount_paid '||coalesce(b_amt,0)::text||
        ', status '||coalesce(b_st,'(null)')||', contract '||coalesce(b_tot,0)::text,'ok');

    perform set_config('request.jwt.claims',
        json_build_object('sub',mgr_id,'role','authenticated')::text, true);
    set local role authenticated;

    -- 1. THE HOLE: a hand write with nothing behind it.
    update jobs set amount_paid = coalesce(amount_paid,0)+12345,
                    payment_status='PAID_IN_FULL' where id=job_row;
    select amount_paid, payment_status into a_amt, a_st from jobs where id=job_row;
    insert into probe values (1,'hand write +12345 / PAID_IN_FULL as MANAGER',
        'amount_paid '||coalesce(b_amt,0)::text||' -> '||coalesce(a_amt,0)::text||
        ', status '||coalesce(b_st,'(null)')||' -> '||coalesce(a_st,'(null)'),
        case when coalesce(a_amt,0)=coalesce(b_amt,0) and coalesce(a_st,'')=coalesce(b_st,'')
             then 'HELD' else 'STILL OPEN' end);

    -- 2. THE REGRESSION: a cash payment recorded in the ledger must show.
    insert into payment_records (sync_id, company_id, job_sync_id, amount, method,
                                 received_at, note, recorded_by)
    values ('probe-cash-'||gen_random_uuid()::text, mgr_co, job_sid, 250,
            'CASH', now(), 'probe', 'probe');
    select amount_paid, payment_status into a_amt, a_st from jobs where id=job_row;
    select coalesce(sum(amount) filter (where amount>=0),0) into ledger_sum
      from payment_records where company_id=mgr_co and job_sync_id=job_sid and deleted_at is null;
    insert into probe values (2,'MANAGER records $250 CASH in the ledger',
        'amount_paid -> '||coalesce(a_amt,0)::text||' (ledger sums to '||ledger_sum::text||
        '), status -> '||coalesce(a_st,'(null)'),
        case when abs(coalesce(a_amt,0)-ledger_sum)<0.005
             then 'FOLLOWED THE LEDGER' else 'BROKEN - the cash does not show' end);

    -- 3. And a hand write AFTER that must land on the ledger figure, not on
    --    the manager's number and not back at zero.
    update jobs set amount_paid = 99999 where id=job_row;
    select amount_paid into a_amt from jobs where id=job_row;
    insert into probe values (3,'hand write 99999 after the cash row',
        'amount_paid -> '||coalesce(a_amt,0)::text||' (ledger '||ledger_sum::text||')',
        case when abs(coalesce(a_amt,0)-ledger_sum)<0.005
             then 'CORRECTED TO THE LEDGER' else 'wrong figure stuck' end);

    -- 4. CONTROL: a price column still writes.
    update jobs set contract_total = coalesce(contract_total,0)+7 where id=job_row;
    select contract_total into a_tot from jobs where id=job_row;
    insert into probe values (4,'CONTROL: MANAGER writes contract_total',
        coalesce(b_tot,0)::text||' -> '||coalesce(a_tot,0)::text,
        case when coalesce(a_tot,-1)=coalesce(b_tot,0)+7 then 'accepted'
             else 'ALARM - pricing broken' end);

    -- 5. CONTROL: cross-company refused.
    if other_job is not null then
        update jobs set locate_notes = coalesce(locate_notes,'')||' probe' where id=other_job;
        get diagnostics n = row_count;
        insert into probe values (5,'CONTROL: same MANAGER, another company',
            'rows '||n, case when n=0 then 'refused - RLS is on' else 'ALARM' end);
    end if;

    reset role;
    perform set_config('request.jwt.claims','',true);

    -- 6. CONTROL: the OWNER can still declare money by hand.
    if own_id is not null then
        select amount_paid into b_amt from jobs where id=job_row;
        perform set_config('request.jwt.claims',
            json_build_object('sub',own_id,'role','authenticated')::text, true);
        set local role authenticated;
        update jobs set amount_paid = coalesce(amount_paid,0)+99 where id=job_row;
        select amount_paid into a_amt from jobs where id=job_row;
        reset role;
        perform set_config('request.jwt.claims','',true);
        insert into probe values (6,'CONTROL: the OWNER writes amount_paid',
            coalesce(b_amt,0)::text||' -> '||coalesce(a_amt,0)::text,
            case when coalesce(a_amt,0)=coalesce(b_amt,0)+99 then 'accepted'
                 else 'ALARM - the owner is locked out' end);
    end if;
end
$probe$;

select n, step, measured, verdict from probe order by n;
rollback;

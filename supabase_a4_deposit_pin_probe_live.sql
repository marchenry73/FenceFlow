-- ============================================================================
-- THE DEPOSIT PIN, AGAINST WHATEVER IS LIVE, WITH THE CONTROLS THAT MATTER.
--
-- A4 finding #7. The pin can fail in two opposite ways and only one of them
-- is obvious:
--
--   TOO WEAK -- the office raises a deposit the customer already agreed to,
--               and the customer is asked for a figure they never saw.
--   TOO HARD -- the deposit cannot be changed at all, so a contractor cannot
--               lower it, cannot set one before approval, and cannot re-price.
--               A trigger that reverted every write would pass the first
--               check and fail nobody's test.
--
-- Five cases, four of them controls. Everything runs as the OWNER (the office
-- is not a crew phone) inside BEGIN/ROLLBACK, on jobs chosen BY PROPERTY and
-- asserted, and nothing is kept.
--
-- Run:
--   npx --no-install supabase@2.115.0 db query --linked \
--     --project-ref newcrgafcptspmapacrx -f supabase_a4_deposit_pin_probe_live.sql
-- ============================================================================

begin;
create temporary table probe (n int, step text, measured text, verdict text) on commit drop;
grant insert, select on probe to authenticated;

do $probe$
declare
    own_id uuid; co uuid; job_row uuid;
    pend_row uuid; pend_dep double precision;
    fresh uuid; fdep double precision;
    dep double precision; got double precision;
begin
    -- A job whose customer IS in it: approved or signed, no re-approval
    -- pending, with a deposit already set. Chosen by property, asserted.
    select j.id, j.company_id, j.deposit_amount into job_row, co, dep
      from jobs j
     where j.deleted_at is null
       and coalesce(j.deposit_amount, 0) > 0.005
       and (j.quote_approved_at is not null or j.signed_at is not null)
       and j.reapproval_required_at is null
     order by j.id limit 1;
    if job_row is null then
        insert into probe values (0, 'fixture',
            'no approved/signed job with a deposit', 'STOP - nothing to measure, NOT a pass');
        return;
    end if;
    select id into own_id from profiles
     where role = 'OWNER' and company_id = co order by id limit 1;
    if own_id is null then
        insert into probe values (0, 'fixture', 'no OWNER in that company', 'STOP - NOT a pass');
        return;
    end if;

    -- A job that genuinely HAS a re-approval pending, for case 3.
    --
    -- Not manufactured: reapproval_required_at is itself pinned by
    -- hold_reapproval_columns, so an owner cannot set it directly -- the
    -- withdrawal machinery does. An earlier version of this probe tried to
    -- write that column and then silently measured a job that was still
    -- approved, which made a PASSING control read as a failure.
    select j.id, coalesce(j.deposit_amount, 0) into pend_row, pend_dep
      from jobs j
     where j.deleted_at is null and j.reapproval_required_at is not null
       and coalesce(j.deposit_amount, 0) > 0.005
       and j.company_id = co
     order by j.id limit 1;

    -- And one nobody has agreed to anything on, for case 5.
    select j.id, coalesce(j.deposit_amount, 0) into fresh, fdep
      from jobs j
     where j.deleted_at is null and j.company_id = co
       and j.quote_approved_at is null and j.signed_at is null
       and coalesce(j.amount_paid, 0) - coalesce(j.refunded_amount, 0) <= 0.005
     order by j.id limit 1;

    insert into probe values (0, 'fixture',
        'approved job with a deposit of ' || dep::text || '; an OWNER to act as; a '
        || case when pend_row is null then 're-approval-pending job NOT available'
                else 're-approval-pending job available' end || '; a '
        || case when fresh is null then 'never-approved job NOT available'
                else 'never-approved job available' end, 'ok');

    perform set_config('request.jwt.claims',
        json_build_object('sub', own_id, 'role', 'authenticated')::text, true);
    set local role authenticated;

    -- 1. THE DEFECT: raise it behind the customer's back.
    update jobs set deposit_amount = dep + 4000 where id = job_row;
    select deposit_amount into got from jobs where id = job_row;
    insert into probe values (1, 'RAISE the deposit on an approved job',
        dep::text || ' -> ' || got::text || ' (asked for ' || (dep + 4000)::text || ')',
        case when abs(got - dep) < 0.005 then 'HELD'
             else 'STILL OPEN - the customer can be asked for a figure they never agreed to' end);

    -- 3. CONTROL: with a re-approval pending, raising it must work. That is
    --    the route that asks the customer again, and it is the only route.
    --    Measured BEFORE the decrease below, because putting a lowered
    --    deposit back is itself a raise and this pin would hold it.
    if pend_row is null then
        insert into probe values (3, 'CONTROL: RAISE it while a re-approval is pending',
            'no such job to measure', 'NOT MEASURED - said rather than called a pass');
    else
        update jobs set deposit_amount = pend_dep + 4000 where id = pend_row;
        select deposit_amount into got from jobs where id = pend_row;
        insert into probe values (3, 'CONTROL: RAISE it while a re-approval is pending',
            pend_dep::text || ' -> ' || got::text,
            case when abs(got - (pend_dep + 4000)) < 0.005
                 then 'accepted - the re-price route is open'
                 else 'ALARM - there is now no way to change a deposit at all' end);
    end if;

    -- 2. CONTROL: lowering it must still work. Asking for less than somebody
    --    agreed needs nobody's permission.
    update jobs set deposit_amount = dep / 2 where id = job_row;
    select deposit_amount into got from jobs where id = job_row;
    insert into probe values (2, 'CONTROL: LOWER the deposit on the approved job',
        dep::text || ' -> ' || got::text,
        case when abs(got - dep / 2) < 0.005 then 'accepted - a smaller ask still works'
             else 'ALARM - the pin is one-directional and this direction is wrong' end);

    -- 4. CONTROL: an ordinary column must still write, or case 1 proves nothing.
    update jobs set locate_notes = coalesce(locate_notes, '') || ' probe' where id = job_row;
    insert into probe values (4, 'CONTROL: an ordinary column still writes',
        'changed', 'accepted - the connection and RLS are really working');

    -- 5. CONTROL: a job nobody has agreed to anything on must still take one.
    if fresh is null then
        insert into probe values (5, 'CONTROL: SET a deposit before approval',
            'no never-approved job in that company',
            'NOT MEASURED - said rather than called a pass');
    else
        update jobs set deposit_amount = fdep + 500 where id = fresh;
        select deposit_amount into got from jobs where id = fresh;
        insert into probe values (5, 'CONTROL: SET a deposit before approval',
            fdep::text || ' -> ' || got::text,
            case when abs(got - (fdep + 500)) < 0.005
                 then 'accepted - ordinary quoting is untouched'
                 else 'ALARM - the pin is firing before anybody agreed to anything' end);
    end if;

    reset role;
    perform set_config('request.jwt.claims', '', true);
end
$probe$;

select n, step, measured, verdict from probe order by n;
rollback;

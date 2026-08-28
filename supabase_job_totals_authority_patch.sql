-- The home screen kept flickering between different money totals.
--
-- Three jobs sat in the cloud with amount_paid = 0 while their ledgers held
-- $19,204.45, $7,058.08 and $10,754.85. Every sync, the phone rebuilt the real
-- figure from the ledger and pushed it; the next pull brought the cloud's
-- stale zero back down and overwrote it. The number on screen depended on
-- which pass had run last, so it changed every few seconds -- $4,486, then
-- $22,720, then something else.
--
-- The cure is to stop having two writers. The ledger is the truth and the
-- cached total is derived from it, so the server now derives it: any change
-- to payment_records recomputes the job's cached figures in the same
-- statement. Phones stop being responsible for keeping the cache honest, and
-- a phone that pushes a wrong figure is corrected by the next ledger write
-- rather than believed.
--
-- The formula is copied from the app (Repository.syncJobTotalsFromLedger),
-- deliberately: paid is the sum of non-negative amounts, refunded is the
-- positive sum of the negatives, over rows that are not soft-deleted. Two
-- formulas is how the office and the phone once disagreed about the same job.

create or replace function public.recompute_job_totals(co uuid, job_sid uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    v_paid numeric;
    v_refunded numeric;
begin
    if job_sid is null then return; end if;
    select coalesce(sum(amount) filter (where amount >= 0), 0),
           coalesce(-sum(amount) filter (where amount < 0), 0)
      into v_paid, v_refunded
      from payment_records
     where company_id = co and job_sync_id = job_sid and deleted_at is null;

    update jobs
       set amount_paid = v_paid,
           refunded_amount = v_refunded
     where company_id = co and sync_id = job_sid
       and (abs(amount_paid - v_paid) > 0.005
            or abs(refunded_amount - v_refunded) > 0.005);
end;
$$;

create or replace function public.payment_records_recompute()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
    if tg_op in ('INSERT','UPDATE') then
        perform recompute_job_totals(new.company_id, new.job_sync_id);
    end if;
    -- An UPDATE that moved a payment to a different job must fix BOTH jobs,
    -- and a DELETE must fix the one it left.
    if tg_op in ('UPDATE','DELETE')
       and (tg_op = 'DELETE' or old.job_sync_id is distinct from new.job_sync_id
            or old.company_id is distinct from new.company_id) then
        perform recompute_job_totals(old.company_id, old.job_sync_id);
    end if;
    return coalesce(new, old);
end;
$$;

drop trigger if exists payment_records_totals on public.payment_records;
create trigger payment_records_totals
after insert or update or delete on public.payment_records
for each row execute function public.payment_records_recompute();

-- The button in the app. Recomputes every job in the caller's company from
-- its ledger -- harmless to run at any time, because it only writes what the
-- ledger already says.
create or replace function public.recalculate_my_job_totals()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    co uuid := public.current_company_id();
    j record;
    n integer := 0;
begin
    if co is null then return 0; end if;
    for j in select sync_id from jobs where company_id = co and deleted_at is null loop
        perform recompute_job_totals(co, j.sync_id);
        n := n + 1;
    end loop;
    return n;
end;
$$;

grant execute on function public.recalculate_my_job_totals() to authenticated;
revoke execute on function public.recalculate_my_job_totals() from anon;

-- One-time repair: bring every cached figure into line with its ledger.
do $$
declare j record; begin
    for j in select company_id, sync_id from jobs loop
        perform recompute_job_totals(j.company_id, j.sync_id);
    end loop;
end $$;

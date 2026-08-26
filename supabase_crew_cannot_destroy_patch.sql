-- Crew could delete the payment ledger, rewrite payment amounts, and read
-- every penny the company has taken.
--
-- March's rule has been the same all along: "I don't want to delete anything
-- on the app. No data at all", and crew must not be able to delete anything
-- in the UI OR in RLS. The UI held. RLS did not.
--
-- 1. payment_records carried a single FOR ALL policy whose only test was the
--    company id:
--        payment_records_write | ALL | USING (company_id = current_company_id())
--    FOR ALL includes DELETE, so any crew member on any phone could hard-delete
--    every payment the company had ever recorded -- not tombstones, real
--    DELETEs, with no trash to restore from and nothing in the app able to
--    bring them back. The same policy let them rewrite an amount: a $12,200
--    payment set to $1, so the job shows a balance a customer has already
--    settled. Reproduced against production inside a rollback as a real CREW
--    profile.
--
-- 2. Fourteen of the sixteen tables carrying deleted_at have the
--    enforce_delete_permission trigger, which requires DELETE_RECORDS to set a
--    tombstone. customers and manufacturers were missed, so crew could make
--    the entire customer list and manufacturer catalog vanish from every
--    screen in the office at once.
--
-- 3. The safety rule was inverted. The RECOVERABLE delete (setting deleted_at)
--    was blocked for a manager, while the IRREVERSIBLE one -- a real DELETE
--    through the REST API with their own login -- was allowed on jobs, every
--    estimate line item, time entries, expenses and the catalog. What the
--    product forbids as recoverable it permitted as unrecoverable.
--
-- Nothing in the app or either website issues a database DELETE: checked, and
-- every .delete() in the Kotlin is a local java.io.File. Deletion in this
-- product means setting deleted_at, and that is gated by DELETE_RECORDS. So
-- the hard-DELETE policies grant a power the product never uses and cannot
-- undo. They are removed rather than narrowed.

-- ---------------------------------------------------------------------------
-- 1. The money ledger
-- ---------------------------------------------------------------------------
-- SEE_MONEY is the product's own answer to "who is allowed to look at the
-- money": OWNER, MANAGER, SALES, ACCOUNTANT. Not FOREMAN, not CREW.
drop policy if exists payment_records_write on public.payment_records;
drop policy if exists payment_records_read  on public.payment_records;

create policy payment_records_read on public.payment_records
    for select using (
        company_id = public.current_company_id()
        and public.has_permission('SEE_MONEY'));

create policy payment_records_insert on public.payment_records
    for insert with check (
        company_id = public.current_company_id()
        and public.has_permission('SEE_MONEY'));

create policy payment_records_update on public.payment_records
    for update using (
        company_id = public.current_company_id()
        and public.has_permission('SEE_MONEY'))
    with check (
        company_id = public.current_company_id()
        and public.has_permission('SEE_MONEY'));

-- No DELETE policy, deliberately. A payment is retired by setting deleted_at,
-- which enforce_delete_permission already gates on DELETE_RECORDS.

-- ---------------------------------------------------------------------------
-- 2. The two tombstone tables that were missed
-- ---------------------------------------------------------------------------
drop trigger if exists enforce_delete_permission_customers on public.customers;
create trigger enforce_delete_permission_customers
    before update on public.customers
    for each row execute function public.enforce_delete_permission();

drop trigger if exists enforce_delete_permission_manufacturers on public.manufacturers;
create trigger enforce_delete_permission_manufacturers
    before update on public.manufacturers
    for each row execute function public.enforce_delete_permission();

-- ---------------------------------------------------------------------------
-- 3. Every hard-DELETE policy on customer data
-- ---------------------------------------------------------------------------
-- device_tokens is deliberately left alone: a phone retiring its own push
-- token is a real delete of a row that is not customer data, and the sender
-- prunes stale tokens itself.
do $$
declare r record;
begin
    for r in
        select c.relname as tbl, pol.polname
          from pg_policy pol
          join pg_class c on c.oid = pol.polrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public'
           and pol.polcmd = 'd'
           and pol.polpermissive
           and c.relname <> 'device_tokens'
    loop
        execute format('drop policy if exists %I on public.%I', r.polname, r.tbl);
        raise notice 'dropped % on %', r.polname, r.tbl;
    end loop;
end $$;

-- One login, one crew record.
--
-- employees.profile_id links a crew member's payroll row to their auth
-- login. Nothing before this stopped the SAME login being written onto TWO
-- employees.profile_id values -- attaching a second crew record to a
-- login already linked elsewhere would let one person's login satisfy
-- `employees.profile_id = auth.uid()` on two different payroll rows, which
-- both acknowledge_my_shift and dispute_my_shift trust as "this is their
-- own row", and which employees_read trusts to widen what a login may read
-- of an employee record without SEE_PAY.
--
-- The office dashboard (website/dashboard.html, showEmp/saveEmp) already
-- refuses to offer or save a login that is linked to a different employee
-- in this company, using the employees list it already has loaded. That is
-- a client-side check only -- two office tabs (or two managers) racing to
-- link the same login in the same few seconds would both pass it. This
-- index is the backstop that makes the second write fail in Postgres
-- instead of silently double-linking, and the dashboard already reads a
-- 23505 (unique_violation) from this index as "someone else just took
-- that login" and shows a plain message rather than the raw error.
--
-- Partial (WHERE profile_id IS NOT NULL): every employee with no login
-- attached has profile_id null, and a plain UNIQUE constraint treats every
-- null as distinct in Postgres anyway -- the WHERE clause is only here to
-- say that out loud rather than rely on an incidental behavior.
create unique index if not exists employees_profile_id_unique
  on public.employees (profile_id)
  where profile_id is not null;

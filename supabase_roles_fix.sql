-- ============================================================
-- FenceFlow -- roles fix + held-up jobs
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- Fixes a real bug in supabase_roles_patch.sql: the three new roles were
-- added inside a DO block, and Postgres refuses ALTER TYPE ... ADD VALUE
-- from inside a function or DO block. The block's exception handler then
-- swallowed the error, so the script looked like it succeeded while the
-- roles were never created. They have to be plain top-level statements.
--
-- Everything else in that patch (the policies) did apply correctly.
-- ============================================================

-- ---------- 1. The three new roles, for real this time ----------
alter type user_role add value if not exists 'SALES';
alter type user_role add value if not exists 'ACCOUNTANT';
alter type user_role add value if not exists 'FOREMAN';

-- ---------- 2. Held-up jobs ----------
-- Why the crew couldn't finish, what the customer has to clear, and whether
-- the estimated hours were typed by hand or follow the footage.
alter table jobs add column if not exists blocked_reason        text    not null default '';
alter table jobs add column if not exists customer_must_clear   text    not null default '';
alter table jobs add column if not exists duration_manually_set boolean not null default false;

-- ---------- 3. Check it worked ----------
-- Should list all six: OWNER, MANAGER, CREW, SALES, ACCOUNTANT, FOREMAN.
select enumlabel as role
from pg_enum
join pg_type on pg_type.oid = pg_enum.enumtypid
where pg_type.typname = 'user_role'
order by enumsortorder;

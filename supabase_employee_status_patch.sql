-- Leaving the crew without leaving the books.
--
-- There was no way to remove somebody. Deleting them would take their clocked
-- hours and job costs with them, which is exactly the record payroll and tax
-- need to keep -- so instead they are marked inactive: gone from crew lists and
-- assignment pickers, unable to sign in, with every hour they ever worked
-- intact and still counted in reports.
--
-- profile_id links a crew record to the account that signs in as them. Without
-- it the app cannot tell whose shift it is looking at -- clocking in records
-- against the job's ASSIGNED employee, not whoever holds the phone -- which is
-- why "nobody approves their own hours" currently falls back to matching email
-- addresses. With the link it becomes a fact rather than a guess.
--
-- Additive: existing rows are active with no linked account, which is what they
-- already are in practice.
alter table public.employees
  add column if not exists is_active     boolean not null default true,
  add column if not exists deactivated_at timestamptz,
  add column if not exists profile_id    uuid references public.profiles(id) on delete set null;

-- One account belongs to at most one crew record per company. Without this a
-- mistaken link could make two people look like the same person, which for a
-- self-approval check is the failure that matters.
create unique index if not exists employees_profile_unique
  on public.employees (company_id, profile_id)
  where profile_id is not null and deleted_at is null;

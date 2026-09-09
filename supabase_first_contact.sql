-- When somebody first got back to the customer.
--
-- The brief asks how quickly leads are contacted, and the answer today is that
-- nobody can know: there is no column for it. Speed to lead is the single
-- number most contractor sales operations live or die on -- a website enquiry
-- answered in an hour converts several times better than the same enquiry
-- answered tomorrow -- and FenceFlow was not recording it at all.
--
-- One column, filled in by a person saying "I called them", not inferred.
-- Inferring it from the first edit would quietly count opening the job to look
-- at it as contact, which is the sort of metric that makes a business feel
-- fast while the phone goes unanswered.
alter table jobs
  add column if not exists first_contact_at timestamptz,
  add column if not exists first_contact_by uuid references profiles(id);

comment on column jobs.first_contact_at is
  'When someone first reached the customer. Set by a person, never inferred from edits.';

-- Written once. A second "contacted" click months later must not reset the
-- clock and make a slow response look quick.
create or replace function public.first_contact_is_first()
returns trigger
language plpgsql
as $$
begin
    if old.first_contact_at is not null and new.first_contact_at is distinct from old.first_contact_at then
        new.first_contact_at := old.first_contact_at;
        new.first_contact_by := old.first_contact_by;
    end if;
    return new;
end;
$$;

drop trigger if exists first_contact_is_first_trg on jobs;
create trigger first_contact_is_first_trg
  before update on jobs
  for each row execute function public.first_contact_is_first();

-- Undo:
--   drop trigger if exists first_contact_is_first_trg on jobs;
--   drop function if exists public.first_contact_is_first();
--   alter table jobs drop column if exists first_contact_at, drop column if exists first_contact_by;

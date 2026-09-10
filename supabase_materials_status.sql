-- Whether the materials for a job are actually on hand.
--
-- The readiness checklist has said "not checked here: materials" on every job
-- since it shipped, because FenceFlow had nowhere to record it. So a job could
-- read READY with nothing on the truck, and the only honest thing to do was
-- say so out loud.
--
-- Three states, not a procurement system. A purchase-order module with
-- suppliers, line matching and receiving is a month of work and most fence
-- companies do not want one: they ring the yard, the yard delivers, somebody
-- looks at the pile. What the office needs is the answer to "can I send a crew
-- on Tuesday", and that is one field.
alter table jobs
  add column if not exists materials_status text not null default 'NOT_ORDERED',
  add column if not exists materials_ordered_at  timestamptz,
  add column if not exists materials_received_at timestamptz,
  add column if not exists materials_note text;

-- Spelled out rather than left to the clients to agree on. Three of them write
-- to this table -- the office, the phone and the edge functions -- and the one
-- that disagrees is the one that quietly breaks the readiness check.
alter table jobs drop constraint if exists jobs_materials_status_check;
alter table jobs add constraint jobs_materials_status_check
  check (materials_status in ('NOT_ORDERED','ORDERED','RECEIVED','NOT_NEEDED'));

comment on column jobs.materials_status is
  'NOT_ORDERED, ORDERED, RECEIVED or NOT_NEEDED. Set by a person; the dates below are stamped by trigger when it moves.';

-- The dates are stamped from the status rather than typed, for the same reason
-- first contact is: a date somebody can type is a date that always says
-- whatever makes the report look best.
create or replace function public.stamp_materials_dates()
returns trigger
language plpgsql
as $$
begin
    if new.materials_status is distinct from old.materials_status then
        if new.materials_status = 'ORDERED' and new.materials_ordered_at is null then
            new.materials_ordered_at := now();
        end if;
        if new.materials_status = 'RECEIVED' then
            new.materials_received_at := coalesce(new.materials_received_at, now());
            -- Received implies ordered. A job that jumps straight to received --
            -- stock off the shelf, a yard delivery nobody logged -- would
            -- otherwise leave a gap that reads as "never ordered".
            new.materials_ordered_at := coalesce(new.materials_ordered_at, now());
        end if;
        if new.materials_status in ('NOT_ORDERED','NOT_NEEDED') then
            new.materials_ordered_at := null;
            new.materials_received_at := null;
        end if;
    end if;
    return new;
end;
$$;

drop trigger if exists stamp_materials_dates_trg on jobs;
create trigger stamp_materials_dates_trg
  before update on jobs
  for each row execute function public.stamp_materials_dates();

-- Undo:
--   drop trigger if exists stamp_materials_dates_trg on jobs;
--   drop function if exists public.stamp_materials_dates();
--   alter table jobs drop constraint if exists jobs_materials_status_check;
--   alter table jobs drop column if exists materials_status, drop column if exists materials_ordered_at,
--     drop column if exists materials_received_at, drop column if exists materials_note;

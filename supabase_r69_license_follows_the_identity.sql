-- ============================================================
-- FenceFlow -- the licence number the app shows is NOT the licence number
-- FenceFlow prints. The identity mirror carried name and phone and dropped
-- the licence.
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- MARCH, 6 Nov 2026: "Fix the licence two-store split too."
--
-- ------------------------------------------------------------------------
-- WHAT IS WRONG, MEASURED
-- ------------------------------------------------------------------------
--
-- The licence lives in two places. company_settings -> 'license_number' is
-- what the phone and the office Settings panel write and show.
-- companies.license_no is what everything OUTSIDE them reads. Across all 12
-- companies on file today:
--
--     companies.license_no set ....... 0
--     blob license_number set ........ 2   (one of them Legacy Solutions')
--     blob set, column blank ......... 2   <- the bug, in the data
--     set in both and disagreeing ..... 0   <- so the backfill is unambiguous
--
-- So the office shows C-1375317095283 and the company row holds ''. Two
-- customer-facing consumers read the blank one:
--
--   supabase/functions/hoa-letter/index.ts:145
--       .from("companies").select("name, license_no, phone, email, is_sandbox")
--     -- the HOA letter goes to an HOA with no licence on it.
--
--   supabase/functions/_shared/job-spec.ts:289
--       if (clean(company.license_no)) lines.push(`License: ...`)
--     -- the line is omitted entirely, so the spec looks like it never had one.
--
-- The app's own PDF is fine: PdfExporter.kt prints business.licenseNumber,
-- which is the blob. That is exactly why this went unnoticed -- every screen
-- a person looks at reads the store that has the value.
--
-- ------------------------------------------------------------------------
-- WHY THE MIRROR MISSED IT, AND WHY THAT MATTERS MORE THAN THE FIELD
-- ------------------------------------------------------------------------
--
-- supabase_company_business_record.sql (29 Sept) named all THREE fields --
-- name, phone and licence -- and chose mirroring over moving.
-- supabase_r62_one_company_identity.sql then implemented the mirror for two
-- of them and excluded the third, giving this reason:
--
--     "license_number is NOT mirrored either: it exists only in the settings
--      blob, companies has no such column, so there is nothing to keep in
--      step."
--
-- THAT REASON IS FALSE, and was false when it was written. companies.license_no
-- is in supabase_schema.sql as `text not null default ''`, the same line that
-- declares name and phone; the Settings panel has written to it since the 29
-- Sept change; and r19's grant list includes it. A correct-sounding sentence
-- about a column that does exist is what kept the gap open for five weeks.
-- PART 4 corrects that comment in r62, and tests/a160 asserts the correction,
-- so the prose is under test rather than merely tidied.
--
-- ------------------------------------------------------------------------
-- THE TRIGGER, WHICH IS THE HALF THAT WOULD HAVE MADE THIS INERT
-- ------------------------------------------------------------------------
--
-- Live definition, read with pg_get_triggerdef before writing this:
--
--     CREATE TRIGGER companies_mirror_identity
--       AFTER UPDATE OF name, phone ON public.companies ...
--
-- A column list. Teaching the FUNCTION about the licence and leaving that list
-- alone would have produced a mirror that passes any test written against the
-- function body and never fires on a licence-only write -- a guard the test
-- reaches by a path the guard is not on. PART 2 recreates the trigger with
-- license_no in the list. The company_settings side fires on `settings`, which
-- already covers a licence change, and is left exactly as it is.
--
-- ------------------------------------------------------------------------
-- WHAT THIS DOES NOT DO
-- ------------------------------------------------------------------------
--
-- Both triggers are UPDATE-only, which r62 chose: a brand-new company gets its
-- details through complete_company_details(), and a company with no
-- company_settings row at all is returned early from rather than having a
-- whole settings blob invented for it from one field. That is unchanged here.
-- A company whose FIRST ever settings save creates the row therefore still
-- leaves companies.license_no behind until the next save. It is recorded at
-- the end rather than fixed quietly inside a change about one field.
--
-- NON-BLANK NEVER LOSES TO BLANK, the same rule as name and phone: clearing a
-- licence deliberately has to be done in both places. For a number that prints
-- on a contract that is the right way round -- absence is not an instruction
-- to delete.
--
-- Idempotent. Every statement is create-or-replace, drop-if-exists or a
-- guarded update, and PART 5 raises rather than leaving it half applied.
-- ============================================================

begin;

-- ------------------------------------------------------------------------
-- PART 1  the mirror learns the licence, both ways
-- ------------------------------------------------------------------------
-- Extended from the LIVE body (pg_proc.prosrc, read 6 Nov 2026, project
-- newcrgafcptspmapacrx), which matched r62's file exactly -- so nothing
-- deployed is being overwritten by a stale copy from the repo.
create or replace function public.mirror_company_identity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    s_name    text;
    s_phone   text;
    s_license text;
begin
    if tg_table_name = 'companies' then
        -- companies.* changed: push a non-blank name, phone or licence into the blob.
        select cs.settings ->> 'business_name', cs.settings ->> 'phone',
               cs.settings ->> 'license_number'
          into s_name, s_phone, s_license
          from company_settings cs where cs.company_id = new.id;
        -- No settings row yet: nothing to mirror into, and creating one here
        -- would invent a company's whole settings blob from three fields.
        if not found then return new; end if;

        if coalesce(btrim(new.name), '') <> ''
           and coalesce(btrim(new.name), '') is distinct from coalesce(btrim(s_name), '') then
            update company_settings
               set settings = coalesce(settings, '{}'::jsonb)
                              || jsonb_build_object('business_name', btrim(new.name))
             where company_id = new.id;
        end if;
        if coalesce(btrim(new.phone), '') <> ''
           and coalesce(btrim(new.phone), '') is distinct from coalesce(btrim(s_phone), '') then
            update company_settings
               set settings = coalesce(settings, '{}'::jsonb)
                              || jsonb_build_object('phone', btrim(new.phone))
             where company_id = new.id;
        end if;
        -- THE LICENCE. Same shape as the two above, and the `is distinct from`
        -- is what terminates the mirror: the opposite trigger fires on this
        -- write, finds the values already equal, and writes nothing back.
        if coalesce(btrim(new.license_no), '') <> ''
           and coalesce(btrim(new.license_no), '') is distinct from coalesce(btrim(s_license), '') then
            update company_settings
               set settings = coalesce(settings, '{}'::jsonb)
                              || jsonb_build_object('license_number', btrim(new.license_no))
             where company_id = new.id;
        end if;
        return new;
    end if;

    -- company_settings.settings changed: push a non-blank name, phone or
    -- licence back. This is the direction that matters most today, because the
    -- blob is the side the phone and the Settings panel write.
    s_name    := new.settings ->> 'business_name';
    s_phone   := new.settings ->> 'phone';
    s_license := new.settings ->> 'license_number';
    if coalesce(btrim(s_name), '') <> '' then
        update companies set name = btrim(s_name)
         where id = new.company_id
           and coalesce(btrim(name), '') is distinct from coalesce(btrim(s_name), '');
    end if;
    if coalesce(btrim(s_phone), '') <> '' then
        update companies set phone = btrim(s_phone)
         where id = new.company_id
           and coalesce(btrim(phone), '') is distinct from coalesce(btrim(s_phone), '');
    end if;
    if coalesce(btrim(s_license), '') <> '' then
        update companies set license_no = btrim(s_license)
         where id = new.company_id
           and coalesce(btrim(license_no), '') is distinct from coalesce(btrim(s_license), '');
    end if;
    return new;
end;
$$;

comment on function public.mirror_company_identity() is
  'Keeps companies.name/phone/license_no and company_settings -> business_name/phone/license_number '
  'in step, whichever side is written. A non-blank value never loses to a blank. Email is '
  'deliberately NOT mirrored (see F3): companies.email is the customer-facing address and the '
  'settings copy is a separate field. The licence was added 6 Nov 2026 (r69): r62 excluded it on '
  'the stated grounds that companies had no such column, which was never true.';

-- ------------------------------------------------------------------------
-- PART 2  the trigger fires on the licence as well
-- ------------------------------------------------------------------------
-- Without this the function above never runs for a licence-only write. The
-- column list is the reason a licence typed into the office reached the blob
-- and stopped there.
drop trigger if exists companies_mirror_identity on public.companies;
create trigger companies_mirror_identity
    after update of name, phone, license_no on public.companies
    for each row execute function public.mirror_company_identity();

-- The settings side is unchanged: `settings` is one column and a licence
-- change is a change to it. Recreated anyway so a re-run of this file leaves
-- both triggers in a state this file describes, rather than one it inherited.
drop trigger if exists company_settings_mirror_identity on public.company_settings;
create trigger company_settings_mirror_identity
    after update of settings on public.company_settings
    for each row execute function public.mirror_company_identity();

-- ------------------------------------------------------------------------
-- PART 3  the backfill -- 2 rows, measured, with nothing to resolve
-- ------------------------------------------------------------------------
-- Counted before this was written: 2 companies hold a licence in the blob and
-- blank in the column, 0 hold one in the column only, and 0 hold two that
-- disagree. So this cannot overwrite a decision anybody made.
--
-- The guard is on the TARGET being blank, not merely different: a licence
-- already in the column stays, even against a different blob value, because
-- choosing between two real licences is not a migration's business.
update companies c
   set license_no = btrim(cs.settings ->> 'license_number')
  from company_settings cs
 where cs.company_id = c.id
   and coalesce(btrim(cs.settings ->> 'license_number'), '') <> ''
   and coalesce(btrim(c.license_no), '') = '';

-- The other direction, for completeness. Zero rows today; it exists so a
-- company licensed through the admin console is not left half-mirrored.
update company_settings cs
   set settings = coalesce(cs.settings, '{}'::jsonb)
                  || jsonb_build_object('license_number', btrim(c.license_no))
  from companies c
 where c.id = cs.company_id
   and coalesce(btrim(c.license_no), '') <> ''
   and coalesce(btrim(cs.settings ->> 'license_number'), '') = '';

-- ------------------------------------------------------------------------
-- PART 4  r62's false sentence, corrected in place
-- ------------------------------------------------------------------------
-- Nothing to run. The comment in supabase_r62_one_company_identity.sql is
-- corrected in the repo by this change, and tests/a160 asserts the correction,
-- because a stale reason that reads as deliberate is what cost five weeks
-- here. Recorded in this file so the two changes are not separable.

-- ------------------------------------------------------------------------
-- PART 5  prove it. Every row must read true, or this raises.
-- ------------------------------------------------------------------------
do $$
declare
    bad text;
begin
    -- 1. the trigger fires on the licence
    if not exists (
        select 1 from pg_trigger
         where tgname = 'companies_mirror_identity'
           and pg_get_triggerdef(oid) ilike '%UPDATE OF name, phone, license_no%') then
        raise exception 'r69: companies_mirror_identity does not fire on license_no -- the function change is inert';
    end if;

    -- 2. the function writes the licence in BOTH directions
    select prosrc into bad from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'mirror_company_identity';
    if bad not like '%jsonb_build_object(''license_number'', btrim(new.license_no))%' then
        raise exception 'r69: the mirror does not push companies.license_no into the blob';
    end if;
    if bad not like '%update companies set license_no = btrim(s_license)%' then
        raise exception 'r69: the mirror does not push the blob licence into companies.license_no';
    end if;

    -- 3. CANARY FIRST: at least one company has a licence somewhere at all.
    --    Without this, check 4 reads true on an empty table and says nothing.
    if not exists (select 1 from companies c
                     left join company_settings cs on cs.company_id = c.id
                    where coalesce(btrim(c.license_no), '') <> ''
                       or coalesce(btrim(cs.settings ->> 'license_number'), '') <> '') then
        raise exception 'r69 CANARY: no company has a licence in either store, so the parity check below is vacuous';
    end if;

    -- 4. no company has a licence in one store that the other is missing
    if exists (
        select 1 from companies c join company_settings cs on cs.company_id = c.id
         where (coalesce(btrim(cs.settings ->> 'license_number'), '') <> ''
                and coalesce(btrim(c.license_no), '') = '')
            or (coalesce(btrim(c.license_no), '') <> ''
                and coalesce(btrim(cs.settings ->> 'license_number'), '') = '')) then
        raise exception 'r69: a licence still exists in one store and not the other after the backfill';
    end if;

    -- 5. nothing was BLANKED. The two that had a licence must still have one,
    --    and now in both stores -- a fix that tidied them away would otherwise
    --    satisfy check 4 perfectly.
    if (select count(*) from companies where coalesce(btrim(license_no), '') <> '') < 2 then
        raise exception 'r69: fewer than the 2 measured licences survive on companies.license_no';
    end if;

    raise notice 'r69 OK: licence mirrored both ways, trigger fires on it, % companies now carry one',
        (select count(*) from companies where coalesce(btrim(license_no), '') <> '');
end $$;

commit;

-- ------------------------------------------------------------------------
-- STILL OPEN, deliberately, and for the owner to decide
-- ------------------------------------------------------------------------
--   1. A company's FIRST ever settings save INSERTS the company_settings row,
--      and both triggers are UPDATE-only, so that one save does not reach
--      companies. The second save does. Covering it means either an INSERT
--      trigger on company_settings or teaching save_company_settings() to
--      write both -- a change to the save path, not to one field.
--   2. companies.email and the blob's `email` still disagree on purpose (F3).
--      PdfExporter prints the blob copy, which is a personal gmail, in the
--      contract header a customer reads. Reported, not decided.
--   3. r19's per-column SELECT grant on companies is still a one-shot
--      snapshot of information_schema. It will go stale again the next time a
--      column is added, exactly as it did before r19 repaired it.

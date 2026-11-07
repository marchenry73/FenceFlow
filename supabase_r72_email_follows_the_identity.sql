-- ============================================================
-- FenceFlow -- the customer-facing EMAIL is the last identity field still
-- stored twice without a mirror (owner list F4)
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- r62 mirrored business name and phone both ways. r69 added the licence, and
-- corrected r62's stated reason for leaving it out, which was false. This is
-- the fourth and last field of the same identity, and r62 left it out too:
--
--     -- EMAIL IS DELIBERATELY NOT MIRRORED. companies.email is the
--     -- customer-facing company address (marc@fenceflowapp.com) and
--     -- company_settings -> email is a separate field; item F3 records that
--     -- distinction as intentional. Mirroring them would quietly replace one
--     -- with the other. Their current disagreement -- the settings copy is a
--     -- personal gmail, and it is what PdfExporter prints in the contract
--     -- header a customer reads -- is reported to the owner rather than
--     -- decided here.
--
-- TWO THINGS IN THAT PARAGRAPH ARE NO LONGER TRUE, MEASURED 7 Nov 2026:
--
--   1. There is no disagreement. Every company holding both values has the
--      same one in each:
--          Legacy Solutions   companies=marc@fenceflowapp.com  blob=marc@fenceflowapp.com
--          Marc               companies=marc@fenceflowapp.com  blob=marc@fenceflowapp.com
--      The personal gmail it describes is gone. Six other companies have a
--      companies.email and no settings row at all, so they cannot disagree
--      either.
--
--   2. F3's distinction is a DIFFERENT pair. F3 separates companies.email
--      (customer-facing) from the OWNER'S LOGIN address, which
--      admin_companies() returns as owner_email out of `profiles`
--      (marchenry73@gmail.com). Nothing here touches profiles, so that
--      distinction is untouched by this file. The blob's `email` is not the
--      login: it is BusinessProfile.email, declared in SettingsStore.kt
--      between businessName/phone and licenseNumber -- the same three fields
--      r62 and r69 already mirror -- and PdfExporter prints it in the contract
--      header. It is the customer-facing business address, stored twice.
--
-- So the two stores hold one concept, they agree only by luck, and nothing
-- keeps them that way. The owner asked on 30 Oct 2026 for the two stores to
-- be written through both ways so they cannot drift again; this is that
-- instruction applied to the field it was always about. Decided by the owner
-- 7 Nov 2026, which is what r62 asked for ("reported to the owner rather than
-- decided here").
--
-- ------------------------------------------------------------------------
-- WHAT THIS CHANGES
-- ------------------------------------------------------------------------
-- public.mirror_company_identity() gains an `email` branch in both
-- directions, built exactly like the licence branch r69 added, and the
-- companies-side trigger gains `email` to its column list -- without that, an
-- email-only write on companies does not fire the trigger at all and the
-- function fix would be inert. That exact trap is why r69 exists.
--
-- ONE DIFFERENCE FROM THE OTHER THREE: A SHAPE CHECK. A blank never
-- overwrites a real value, as before. But a name or a phone that is nonsense
-- is merely wrong on a page, while an email that is nonsense silently breaks
-- customer mail -- fenceflowReplyTo() rejects an unparseable address and
-- mail-send then refuses to send at all. So a value is mirrored only if it
-- looks like an address (something, then @, then something with a dot). This
-- is deliberately loose: it rejects "n/a" and a phone number typed in the
-- wrong box, and it passes anything a mail server would accept.
--
-- Idempotent. PART 4 raises rather than reporting, and carries a canary.
-- ============================================================

begin;

-- ------------------------------------------------------------------------
-- PART 0  "is this an address at all?"
-- ------------------------------------------------------------------------
-- Deliberately loose. Its job is NOT to validate an address -- that argument
-- has no end and a regex that tries loses real addresses. Its job is to stop
-- a value that was never an address from becoming a company's reply-to:
-- "n/a", a phone number typed in the wrong box, a name. Something, then one
-- @, then something containing a dot, and no whitespace anywhere.
--
-- immutable: pure text, reads nothing. A null or blank is false, so the
-- callers need no separate blank check.
create or replace function public.looks_like_email(p_value text)
returns boolean
language sql
immutable
as $$
  select btrim(coalesce(p_value, '')) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
$$;

comment on function public.looks_like_email(text) is
  'Loose shape check for an address, used by mirror_company_identity() so a non-address ("n/a", a phone number) cannot become a company customer-facing reply-to. Not validation.';

-- ------------------------------------------------------------------------
-- PART 1  the mirror carries the email, both ways
-- ------------------------------------------------------------------------
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
    s_email   text;
begin
    if tg_table_name = 'companies' then
        -- companies.* changed: push a non-blank name, phone, licence or email
        -- into the blob.
        select cs.settings ->> 'business_name', cs.settings ->> 'phone',
               cs.settings ->> 'license_number', cs.settings ->> 'email'
          into s_name, s_phone, s_license, s_email
          from company_settings cs where cs.company_id = new.id;
        -- No settings row yet: nothing to mirror into, and creating one here
        -- would invent a company's whole settings blob from four fields.
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
        -- THE EMAIL, with the shape check described in the header. Note it
        -- guards the SOURCE value: a malformed address already sitting in
        -- companies.email is left where it is rather than copied onward.
        if public.looks_like_email(new.email)
           and btrim(new.email) is distinct from coalesce(btrim(s_email), '') then
            update company_settings
               set settings = coalesce(settings, '{}'::jsonb)
                              || jsonb_build_object('email', btrim(new.email))
             where company_id = new.id;
        end if;
        return new;
    end if;

    -- company_settings.settings changed: push a non-blank name, phone,
    -- licence or email back. This is the direction that matters most today,
    -- because the blob is the side the phone and the Settings panel write.
    s_name    := new.settings ->> 'business_name';
    s_phone   := new.settings ->> 'phone';
    s_license := new.settings ->> 'license_number';
    s_email   := new.settings ->> 'email';
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
    if public.looks_like_email(s_email) then
        update companies set email = btrim(s_email)
         where id = new.company_id
           and coalesce(btrim(email), '') is distinct from btrim(s_email);
    end if;
    return new;
end $$;

-- ------------------------------------------------------------------------
-- PART 2  the companies-side trigger must FIRE on an email-only write
-- ------------------------------------------------------------------------
-- Without `email` in this list the branch above is unreachable from the
-- companies side: the office changing only the address would never mirror.
-- r69 exists because exactly that happened to the licence.
drop trigger if exists companies_mirror_identity on public.companies;
create trigger companies_mirror_identity
    after update of name, phone, license_no, email on public.companies
    for each row execute function public.mirror_company_identity();

-- The settings-side trigger is untouched by this change; recreated with r70's
-- exact definition so a re-run of this file cannot leave the pair in a state
-- only one of the two files describes.
drop trigger if exists company_settings_mirror_identity on public.company_settings;
create trigger company_settings_mirror_identity
    after insert or update of settings on public.company_settings
    for each row execute function public.mirror_company_identity();

-- ------------------------------------------------------------------------
-- PART 3  close the gaps that already exist
-- ------------------------------------------------------------------------
-- Fills a BLANK side from a non-blank one, in both directions, for companies
-- that hold a settings row. It cannot disagree with anything: where both
-- sides have a value today they are already equal (measured, see header), and
-- this touches neither.
update company_settings cs
   set settings = coalesce(cs.settings, '{}'::jsonb)
                  || jsonb_build_object('email', btrim(c.email))
  from companies c
 where c.id = cs.company_id
   and public.looks_like_email(c.email)
   and coalesce(btrim(cs.settings ->> 'email'), '') = '';

update companies c
   set email = btrim(cs.settings ->> 'email')
  from company_settings cs
 where cs.company_id = c.id
   and public.looks_like_email(cs.settings ->> 'email')
   and coalesce(btrim(c.email), '') = '';

-- ------------------------------------------------------------------------
-- PART 4  prove it. Every check raises rather than reporting.
-- ------------------------------------------------------------------------
do $$
declare
    d text;
    v_id uuid;
    v_before text;
    v_blob text;
begin
    -- The shape check answers.
    if not public.looks_like_email('marc@fenceflowapp.com') then
        raise exception 'r72: a real address was rejected by looks_like_email';
    end if;
    if public.looks_like_email('n/a') or public.looks_like_email('8135779330')
       or public.looks_like_email('') or public.looks_like_email(null)
       or public.looks_like_email('two words@x.com') then
        raise exception 'r72: looks_like_email accepts something that is not an address';
    end if;

    select pg_get_triggerdef(oid) into d from pg_trigger
     where tgname = 'companies_mirror_identity';
    if d is null then
        raise exception 'r72: companies_mirror_identity is missing';
    end if;
    if d !~* 'UPDATE OF name, phone, license_no, email' then
        raise exception 'r72: the companies trigger does not fire on an email-only write: %', d;
    end if;

    select pg_get_triggerdef(oid) into d from pg_trigger
     where tgname = 'company_settings_mirror_identity';
    if d !~* 'INSERT' or d !~* 'UPDATE OF settings' then
        raise exception 'r72: the settings trigger lost r70''s INSERT or its UPDATE: %', d;
    end if;

    -- AND IT ACTUALLY MIRRORS. Everything above passes on a function that
    -- never touches the email. Write one on a real company that HAS a
    -- settings row, read the blob back, then put it where it was.
    select c.id, c.email into v_id, v_before
      from companies c join company_settings cs on cs.company_id = c.id
     limit 1;
    if v_id is null then
        raise exception 'r72: no company with a settings row -- the mirror was never exercised, so this proves nothing about it';
    end if;

    update companies set email = 'r72probe@example.com' where id = v_id;
    select cs.settings ->> 'email' into v_blob from company_settings cs where cs.company_id = v_id;

    -- Put it back BEFORE judging, so a failed check cannot leave a probe
    -- address as a company's customer-facing email.
    update companies set email = v_before where id = v_id;

    if v_blob is distinct from 'r72probe@example.com' then
        raise exception 'r72: companies.email -> blob did not mirror (blob read back as %)', v_blob;
    end if;

    raise notice 'r72 OK: the customer-facing email follows the identity, both ways';
end $$;

commit;

-- ------------------------------------------------------------------------
-- STILL OPEN after this
-- ------------------------------------------------------------------------
--   1. "Marc fence" has no customer-facing email in EITHER store, so there is
--      nothing for this to mirror. FenceFlow mail for that company refuses
--      with "Add your business email in Settings first"; its quote pages show
--      no contact address. Only the owner can supply one.
--   2. "Legacy" uses a personal yahoo address as its customer-facing email.
--      Accurate mirroring will now keep that address in both stores, which is
--      correct behaviour and may not be the intended address.
--   3. Six companies still have no company_settings row, so the
--      companies-side mirror returns early for them (r62's choice, kept). The
--      first settings save fixes each one, per r70.

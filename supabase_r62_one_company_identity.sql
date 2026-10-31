-- r62: the business name and phone live in two places, and they had drifted.
--
-- WHAT IT COST, read off the live database on 30 October 2026:
--
--   companies.name                        'Fence solutions'
--   company_settings -> business_name     'Legacy solutions'
--   companies.phone                       ''            (empty)
--   company_settings -> phone             '8135779310'
--
-- Both are read, by different halves of the product, for the same sentence:
--
--   * The PHONE sends a quote with profile.businessName (JobDetailScreen, the
--     quote_email_subject string), which is the settings blob -- so three
--     customers on 24 and 26 October received "Your fence quote from Legacy
--     solutions".
--   * The SERVER sends the approval confirmation with co.name
--     (quote-approval-email), which is companies.name -- so the SAME customer
--     then received "Your approved fence quote from Fence solutions".
--
-- Two emails, two business names, to one person, about one job. The phone
-- number splits the same way in the other direction: companies.phone is empty,
-- so every reader of the company record -- HOA letters, payment-link
-- descriptions, crew invitations -- has no number for a company that has one.
--
-- The owner settled the name on 30 Oct 2026: 'Fence solutions', the value in
-- companies.name, which is what the server-sent mail, payment links and HOA
-- letters already used. He also asked for the two stores to be written through
-- both ways so they cannot drift again.
--
-- WHY A TRIGGER, and not a fix in each writer. There are at least four: the
-- phone's settings screen through SettingsSync, the office's business-settings
-- panel through save_company_settings, the signup wizard, and the admin portal.
-- A rule applied in four places is a rule the fifth writer will not have. This
-- is the funnel both tables actually share, so new code is covered by default.
--
-- HOW RECURSION IS AVOIDED, without a depth guard: each direction writes ONLY
-- when the target differs. The mirror write fires the opposite trigger, which
-- finds the two already equal and writes nothing, so it terminates in one hop.
-- A pg_trigger_depth() test would also work, but it silently stops mirroring a
-- legitimate second write made inside another trigger; comparing values does
-- not.
--
-- A NON-BLANK VALUE NEVER LOSES TO A BLANK. That is the rule that resolves the
-- phone case correctly -- the settings number fills the empty companies.phone
-- rather than the empty column wiping the number -- and it is the same
-- reasoning as every other half-loaded-copy guard in this product: absence is
-- not an instruction to delete. The cost, stated: clearing a name or phone
-- deliberately has to be done in BOTH places, because one blank will not
-- propagate. That is the right way round for identity fields that print on a
-- contract.
--
-- EMAIL IS DELIBERATELY NOT MIRRORED. companies.email is the customer-facing
-- company address (marc@fenceflowapp.com) and company_settings -> email is a
-- separate field; item F3 records that distinction as intentional. Mirroring
-- them would quietly replace one with the other. Their current disagreement --
-- the settings copy is a personal gmail, and it is what PdfExporter prints in
-- the contract header a customer reads -- is reported to the owner rather than
-- decided here.
--
-- license_number is NOT mirrored either: it exists only in the settings blob,
-- companies has no such column, so there is nothing to keep in step.
--
-- Idempotent. The self-check at the end raises rather than leaving it half
-- applied, and restores every row it touched.

begin;

-- --------------------------------------------------------------- the mirror
create or replace function public.mirror_company_identity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    s_name  text;
    s_phone text;
begin
    if tg_table_name = 'companies' then
        -- companies.* changed: push a non-blank name or phone into the blob.
        select cs.settings ->> 'business_name', cs.settings ->> 'phone'
          into s_name, s_phone
          from company_settings cs where cs.company_id = new.id;
        -- No settings row yet: nothing to mirror into, and creating one here
        -- would invent a company's whole settings blob from two fields.
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
        return new;
    end if;

    -- company_settings.settings changed: push a non-blank name or phone back.
    s_name  := new.settings ->> 'business_name';
    s_phone := new.settings ->> 'phone';
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
    return new;
end;
$$;

comment on function public.mirror_company_identity() is
  'Keeps companies.name/phone and company_settings -> business_name/phone in step, whichever side is '
  'written. A non-blank value never loses to a blank. Email is deliberately NOT mirrored (see F3): '
  'companies.email is the customer-facing address and the settings copy is a separate field.';

drop trigger if exists companies_mirror_identity on public.companies;
create trigger companies_mirror_identity
    after update of name, phone on public.companies
    for each row execute function public.mirror_company_identity();

drop trigger if exists company_settings_mirror_identity on public.company_settings;
create trigger company_settings_mirror_identity
    after update of settings on public.company_settings
    for each row execute function public.mirror_company_identity();

-- ------------------------------------------------------- settle the drift now
-- THE OWNER'S ANSWER, 30 Oct 2026: 'Legacy Solutions'.
--
-- He was asked which of the two stored names was right, answered one, then
-- corrected it to 'Legacy Solutions' before anything had been applied. So
-- NEITHER stored value was right as it stood: the column held a different name
-- and the settings blob held 'Legacy solutions' with a lower-case s. Both are
-- set to his spelling, written here as a literal rather than copied from
-- whichever side happened to be less wrong.
--
-- WHAT THIS CHANGES FOR CUSTOMERS, since it is the direction nobody has seen
-- yet: the server-sent mail, the Stripe payment-link descriptions, the HOA
-- letters and the crew invitations all read companies.name, and all of them
-- will now say 'Legacy Solutions'. The three quotes the phone sent on 24 and
-- 26 October were the closer of the two.
--
-- Scoped to this one company by id, deliberately. The generic reconcile below
-- handles every other company by copying ITS OWN name, because a sweep that
-- wrote one owner's trading name across the table would be a far worse bug
-- than the one being fixed.
update public.companies
   set name = 'Legacy Solutions'
 where id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and name is distinct from 'Legacy Solutions';

update public.company_settings
   set settings = coalesce(settings, '{}'::jsonb)
                  || jsonb_build_object('business_name', 'Legacy Solutions')
 where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4'
   and coalesce(settings ->> 'business_name', '') is distinct from 'Legacy Solutions';

-- EVERY OTHER COMPANY: each keeps its own name, and the blob is brought into
-- step with the column where they differ. A no-op for one already consistent.
update public.company_settings cs
   set settings = coalesce(cs.settings, '{}'::jsonb)
                  || jsonb_build_object('business_name', btrim(c.name))
  from public.companies c
 where c.id = cs.company_id
   and coalesce(btrim(c.name), '') <> ''
   and coalesce(btrim(cs.settings ->> 'business_name'), '') is distinct from coalesce(btrim(c.name), '');

update public.companies c
   set phone = btrim(cs.settings ->> 'phone')
  from public.company_settings cs
 where cs.company_id = c.id
   and coalesce(btrim(cs.settings ->> 'phone'), '') <> ''
   and coalesce(btrim(c.phone), '') is distinct from coalesce(btrim(cs.settings ->> 'phone'), '');

-- ------------------------------------------------------------------ self-check
do $check$
declare
    bad        int;
    co         uuid;
    had_name   text;
    had_s_name text;
begin
    -- 0. The name the owner actually asked for, spelled his way, on both sides.
    if (select name from public.companies where id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4')
       is distinct from 'Legacy Solutions' then
        raise exception 'r62: companies.name is not the name the owner gave (%)',
            (select name from public.companies where id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4');
    end if;
    if (select settings ->> 'business_name' from public.company_settings
         where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4')
       is distinct from 'Legacy Solutions' then
        raise exception 'r62: the settings blob is not the name the owner gave (%)',
            (select settings ->> 'business_name' from public.company_settings
              where company_id = 'aba5b097-afc4-48dd-9851-b50200d5e8f4');
    end if;

    -- 1. Nothing disagrees any more, anywhere.
    select count(*) into bad
      from public.companies c join public.company_settings cs on cs.company_id = c.id
     where coalesce(btrim(c.name), '') <> ''
       and coalesce(btrim(cs.settings ->> 'business_name'), '') is distinct from coalesce(btrim(c.name), '');
    if bad > 0 then
        raise exception 'r62: % companies still disagree with their settings about the business name', bad;
    end if;
    select count(*) into bad
      from public.companies c join public.company_settings cs on cs.company_id = c.id
     where coalesce(btrim(cs.settings ->> 'phone'), '') <> ''
       and coalesce(btrim(c.phone), '') is distinct from coalesce(btrim(cs.settings ->> 'phone'), '');
    if bad > 0 then
        raise exception 'r62: % companies still disagree about the phone', bad;
    end if;

    -- 2. THE MIRROR ACTUALLY FIRES, both ways, proven on a real row and put
    -- back. A trigger that is installed and does nothing is the failure this
    -- whole file exists to prevent, so it is not taken on trust.
    select c.id, c.name, cs.settings ->> 'business_name'
      into co, had_name, had_s_name
      from public.companies c join public.company_settings cs on cs.company_id = c.id
     where coalesce(btrim(c.name), '') <> '' limit 1;
    if co is null then
        raise notice 'r62 self-check skipped: no company with a name to test the mirror on';
        return;
    end if;

    -- companies -> settings
    update public.companies set name = 'R62 MIRROR PROBE' where id = co;
    if (select cs.settings ->> 'business_name' from public.company_settings cs where cs.company_id = co)
       is distinct from 'R62 MIRROR PROBE' then
        raise exception 'r62: writing companies.name did NOT reach the settings blob';
    end if;

    -- settings -> companies
    update public.company_settings
       set settings = coalesce(settings, '{}'::jsonb) || '{"business_name": "R62 MIRROR BACK"}'::jsonb
     where company_id = co;
    if (select name from public.companies where id = co) is distinct from 'R62 MIRROR BACK' then
        raise exception 'r62: writing the settings blob did NOT reach companies.name';
    end if;

    -- A BLANK MUST NOT WIN. This is the rule that filled the empty phone
    -- instead of wiping the real number, so it is proven rather than asserted.
    update public.company_settings
       set settings = coalesce(settings, '{}'::jsonb) || '{"business_name": ""}'::jsonb
     where company_id = co;
    if (select name from public.companies where id = co) is distinct from 'R62 MIRROR BACK' then
        raise exception 'r62: a BLANK settings name overwrote a real company name -- absence is not an instruction to delete';
    end if;

    -- Put both sides back exactly as they were found.
    update public.companies set name = had_name where id = co;
    update public.company_settings
       set settings = coalesce(settings, '{}'::jsonb)
                      || jsonb_build_object('business_name', coalesce(had_s_name, btrim(had_name)))
     where company_id = co;
    if (select name from public.companies where id = co) is distinct from had_name then
        raise exception 'r62 self-check could not put the company name back as it found it';
    end if;
end $check$;

commit;

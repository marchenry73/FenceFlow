-- ============================================================
-- FenceFlow -- a company's FIRST settings save never reached the company
-- record, because both mirror triggers were UPDATE-only
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- Recorded as "still open" by supabase_r69_license_follows_the_identity.sql
-- earlier today, then measured. It is not theoretical:
--
--     companies ....................... 12
--     with a company_settings row ...... 2
--     with NO settings row yet ........ 10
--
-- Ten of twelve. save_company_settings() does
--
--     insert into company_settings (...) values (...)
--     on conflict (company_id) do update set settings = ... || excluded.settings
--
-- so for those ten the first save is an INSERT, and the trigger was
--
--     AFTER UPDATE OF settings ON public.company_settings
--
-- which does not fire on INSERT. The office says "Saved", the blob is
-- correct, and companies.name / .phone / .license_no keep whatever onboarding
-- left there. The SECOND save is an UPDATE and does mirror -- so the symptom
-- is "it worked the time after", which is about the worst shape a bug can
-- have for anyone trying to report it.
--
-- WHAT READS THE COLUMNS, and therefore what was stale for those ten:
--   quote-view/index.ts      name + phone on the public quote page a customer opens
--   invite-crew/index.ts     name + phone on crew invitations
--   send-follow-ups, _shared/mail/caller.ts   the name every email is sent under
--   create-payment-link, lead-intake          the name
--   hoa-letter, _shared/job-spec.ts            license_no
--
-- ------------------------------------------------------------------------
-- WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT
-- ------------------------------------------------------------------------
--
-- One word: the trigger also fires on INSERT. public.mirror_company_identity()
-- is NOT touched -- its settings branch already reads new.settings and
-- new.company_id, both of which an INSERT has, so it works unchanged. Leaving
-- the function alone is the point: r69 changed it this morning and a second
-- rewrite in one day is how a mirror quietly stops mirroring.
--
-- THE ASYMMETRY IS KEPT ON PURPOSE. On INSERT this pushes blob -> companies
-- for every non-blank value, and does not pull companies -> blob for the
-- fields the blob happens to lack. The non-blank rule means nothing is lost
-- either way: a blank never overwrites a real value, so companies keeps the
-- name onboarding gave it, and the next edit on either side closes the gap.
-- Making INSERT bidirectional would mean a second branch in a function that
-- is doing exactly one job today.
--
-- The companies-side trigger still returns early when there is no settings
-- row ("No settings row yet: nothing to mirror into"), which r62 chose and
-- r69 kept: inventing a company's whole settings blob out of three fields is
-- a worse failure than a late mirror.
--
-- Idempotent -- drop-if-exists then create, and PART 2 raises rather than
-- leaving it half applied.
-- ============================================================

begin;

-- ------------------------------------------------------------------------
-- PART 1  the settings-side mirror also fires on INSERT
-- ------------------------------------------------------------------------
drop trigger if exists company_settings_mirror_identity on public.company_settings;
create trigger company_settings_mirror_identity
    after insert or update of settings on public.company_settings
    for each row execute function public.mirror_company_identity();

-- The companies side is untouched by this change. Recreated with r69's exact
-- column list so a re-run of this file cannot leave the pair in a state only
-- one of the two files describes.
drop trigger if exists companies_mirror_identity on public.companies;
create trigger companies_mirror_identity
    after update of name, phone, license_no on public.companies
    for each row execute function public.mirror_company_identity();

-- ------------------------------------------------------------------------
-- PART 2  prove it. Every check raises rather than reporting.
-- ------------------------------------------------------------------------
do $$
declare d text;
begin
    select pg_get_triggerdef(oid) into d from pg_trigger
     where tgname = 'company_settings_mirror_identity';
    if d is null then
        raise exception 'r70: company_settings_mirror_identity is missing';
    end if;
    if d !~* 'INSERT' then
        raise exception 'r70: the settings mirror still does not fire on INSERT -- the first save is still lost';
    end if;
    if d !~* 'UPDATE OF settings' then
        raise exception 'r70: the settings mirror no longer fires on UPDATE -- every save after the first is now lost';
    end if;

    select pg_get_triggerdef(oid) into d from pg_trigger
     where tgname = 'companies_mirror_identity';
    if d !~* 'UPDATE OF name, phone, license_no' then
        raise exception 'r70: the companies mirror lost r69''s license_no column';
    end if;

    -- The function must still be r69's. A trigger pointing at a mirror that
    -- no longer carries the licence would satisfy everything above.
    if (select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'mirror_company_identity')
       not like '%update companies set license_no = btrim(s_license)%' then
        raise exception 'r70: mirror_company_identity no longer carries the licence (r69 was undone)';
    end if;

    raise notice 'r70 OK: the first settings save now reaches companies';
end $$;

commit;

-- ------------------------------------------------------------------------
-- STILL OPEN after this
-- ------------------------------------------------------------------------
--   1. companies.email and the settings blob's `email` still disagree on
--      purpose (F3). PdfExporter prints the blob copy, a personal gmail, in
--      the contract header a customer reads. Reported, not decided.
--   2. A company with no company_settings row still gets nothing mirrored
--      INTO the blob when its companies row is edited -- the early return
--      described above. Ten companies are in that state today; the first
--      settings save now fixes each one as it happens.

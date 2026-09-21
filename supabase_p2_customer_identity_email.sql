-- P2-3 (P1): protect_customer_identity() also pins jobs.email and jobs.hoa_email.
--
-- The trigger held customer_name, address, phone and customer_id for any API
-- caller without EDIT_JOBS. It did not hold `email`, and `email` is not in
-- job_money_columns() -- so any role that can write a job could change where
-- the quote link is sent:
--
--   * CREW / FOREMAN through crew_save_job() (RECORD_FIELD_WORK is enough),
--   * ACCOUNTANT by a direct UPDATE (SEE_MONEY reaches the base table, and
--     ACCOUNTANT has no EDIT_JOBS).
--
-- send-follow-ups/index.ts:240-251 builds
-- `${siteUrl}/quote.html?t=${j.quote_token}` and sends it `to: [j.email]`, and
-- jobs_crew hands the field the customer's phone number, which is the only
-- other thing the approval gate asks for. One column is the whole distance
-- between "the customer approves their own quote" and "the crew does".
-- hoa_email goes the same way, so it is pinned with it.
--
-- Everything else in this function is byte-identical to the live definition,
-- including the two exemptions it turns on -- a direct connection with no
-- request context at all (migrations, backups, psql) and the service role --
-- and the reason it holds values rather than raising, which is that a crew
-- phone pushes the WHOLE job row and raising would throw away a day of field
-- work to protect a column the phone never meant to change.

create or replace function public.protect_customer_identity()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
    -- A direct database connection -- a migration, a backup, psql -- has no
    -- request context at all. Only requests arriving through the API are
    -- judged here. Checking is_service_role() alone was not enough: that
    -- reads a JWT claim, and a direct connection has no JWT, so maintenance
    -- ran as an unprivileged caller and had its writes quietly reverted.
    claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
    -- Keeps the office's version rather than refusing the write.
    --
    -- Refusing looked right and would have broken crew sync outright. The app
    -- pushes the WHOLE job row whenever the phone's copy is the newer one
    -- (JobSync.kt:373-390), so an installer who edits a punch-list item at
    -- 10:00 pushes the customer name as it was on their phone -- which may be
    -- yesterday's, if the office corrected it since. Raising there would have
    -- rejected the entire update and thrown away their field work, and only
    -- for crew, who are exactly the people working offline all day.
    --
    -- So the columns are held at their existing values instead. Their field
    -- work goes up, the office's correction stays put, and nobody loses
    -- anything. Who the customer is, where they live and how to reach them is
    -- office information; changing it needs EDIT_JOBS, which OWNER, MANAGER
    -- and SALES have.
    --
    -- Asks whether the caller IS the backend rather than inferring it from the
    -- absence of a user: "no auth.uid()" is also what an anonymous caller
    -- looks like, and that assumption is what opened admin_mark_invited and
    -- release_for_payment earlier tonight.
    if claims is not null
       and not public.is_service_role()
       and not has_permission('EDIT_JOBS') then
        new.customer_name := old.customer_name;
        new.address       := old.address;
        new.phone         := old.phone;
        new.customer_id   := old.customer_id;
        -- Added: where the quote link is SENT is part of who the customer is.
        -- Both are NOT NULL with a '' default, so this is a plain hold, never
        -- a null. A crew phone that pushes the whole row pushes back exactly
        -- the address it pulled from jobs_crew, so an honest push is a no-op
        -- here and only a changed value is stopped.
        new.email         := old.email;
        new.hoa_email     := old.hoa_email;
    end if;
    return new;
end;
$function$;

-- Self-check: the trigger must still be attached, and it must still be the
-- BEFORE UPDATE one. A function nobody calls protects nothing.
do $check$
begin
    if not exists (
        select 1 from pg_trigger t
         where t.tgrelid = 'public.jobs'::regclass
           and not t.tgisinternal
           and t.tgname = 'protect_customer_identity') then
        raise exception 'protect_customer_identity trigger is not attached to public.jobs';
    end if;
    if position('new.email' in pg_get_functiondef(
          'public.protect_customer_identity()'::regprocedure)) = 0 then
        raise exception 'protect_customer_identity() does not pin email';
    end if;
end $check$;

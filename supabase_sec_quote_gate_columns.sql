-- F5 (P2): a company member without EDIT_JOBS (CREW through crew_save_job,
-- ACCOUNTANT and FOREMAN through a direct UPDATE jobs) could set
-- quote_approved_at / quote_approved_name, and could clear
-- quote_phone_attempts / quote_phone_locked_until. The first forges a
-- homeowner's approval -- which is exactly what create-payment-link treats as
-- its gate -- and the second resets the phone-gate lockout.
--
-- These five columns are the homeowner's side of the quote. Only the
-- quote-view edge function (service role) has any business writing them, so
-- they are pinned for every API caller, the same way hold_money_columns()
-- pins the money columns. Note this deliberately does NOT reuse
-- money_caller_trusted(): that returns true for anyone with SEE_MONEY, and
-- SEE_MONEY is not consent from a homeowner.

create or replace function public.hold_quote_gate_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
    -- No request claims at all: a trigger, a migration, psql. The service
    -- role is the quote-view function itself.
    if nullif(current_setting('request.jwt.claims', true), '') is null
       or public.is_service_role() then
        return new;
    end if;

    if tg_op = 'UPDATE' then
        new.quote_approved_at                 := old.quote_approved_at;
        new.quote_approved_name               := old.quote_approved_name;
        new.quote_approved_without_phone_check := old.quote_approved_without_phone_check;
        new.quote_phone_attempts              := old.quote_phone_attempts;
        new.quote_phone_locked_until          := old.quote_phone_locked_until;
    else
        new.quote_approved_at                 := null;
        new.quote_approved_name               := '';
        new.quote_approved_without_phone_check := false;
        new.quote_phone_attempts              := 0;
        new.quote_phone_locked_until          := null;
    end if;
    return new;
end;
$function$;

drop trigger if exists "00_hold_quote_gate" on public.jobs;
create trigger "00_hold_quote_gate"
    before insert or update on public.jobs
    for each row execute function public.hold_quote_gate_columns();

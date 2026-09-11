-- A chargeback must not beat a crew member's offline edit.
--
-- jobs.updated_at is the offline sync clock: last edit wins. touch_updated_at
-- keeps a list of columns that are bookkeeping rather than editing, and leaves
-- the clock alone when only those change. The dispute columns were added after
-- that list was written and never joined it.
--
-- Nobody types those columns. They are written by the Stripe and Square
-- webhooks when a customer's bank pulls money back -- an event that arrives
-- whenever the bank decides, with no person at a keyboard. Measured on a real
-- job in a rolled-back transaction: writing only dispute_status and
-- dispute_reason moved updated_at from 29 August to now. A crew member who
-- edited that job in a dead spot would have had their edit silently discarded
-- by a chargeback landing while the phone was out of signal.
--
-- This is the same fix, and the same reasoning, as the quote-gate counters
-- earlier today. That it happened twice in one day is the argument for
-- checking the list every time a column is added to jobs.
--
-- Replaces the function because there is one of it. The list below is the
-- current live one with five names added and nothing removed -- if anything
-- looks wrong here, check first that every original entry survives.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $function$
declare
    quiet constant text[] := array[
        'updated_at',
        -- derived from the payment ledger, or written by the webhook
        'amount_paid', 'refunded_amount', 'payment_status', 'payments_from_processor',
        -- derived from the line items by every phone
        'contract_total',
        -- a homeowner opening their link, and the office geocoding a pin
        'quote_viewed_at', 'site_lat', 'site_lon',
        -- presence, not editing
        'last_seen_at',
        -- which engine priced it, and where the office wizard is up to
        'priced_by', 'priced_at', 'pricing_engine_version', 'wizard_step',
        -- somebody failing to guess the last four digits of the phone, and the
        -- record that the gate could not run because there was no phone
        'quote_phone_attempts', 'quote_phone_locked_until',
        'quote_approved_without_phone_check',
        -- a bank pulling money back. Written by the payment webhooks only,
        -- never by a person, and arriving whenever the bank decides.
        'dispute_opened_at', 'dispute_closed_at', 'dispute_status',
        'dispute_reason', 'dispute_amount'
    ];
begin
    if (to_jsonb(new) - quiet) is distinct from (to_jsonb(old) - quiet) then
        new.updated_at = now();
    else
        -- A client that sent updated_at with a bookkeeping write is
        -- overruled the same way it was when the clock only moved forward.
        new.updated_at = old.updated_at;
    end if;
    return new;
end $function$;

select 'a chargeback is bookkeeping, not an edit' as done;

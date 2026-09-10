-- The phone gate's counters must not look like somebody editing the job.
--
-- jobs.updated_at is the offline sync clock: the phone that edited last wins,
-- and a write that moves that clock without changing anything a person cares
-- about can silently beat a real edit made in the field. touch_updated_at
-- already keeps a list of columns that are bookkeeping rather than editing --
-- the payment ledger, the derived contract total, a homeowner opening their
-- link -- and leaves the clock alone when only those change.
--
-- The three columns the quote approval gate writes belong on that list. A
-- stranger typing four wrong digits five times is not an edit to the job. Left
-- off, each wrong guess would move the clock, tell every phone the job had
-- changed, and stand a real chance of overwriting a crew member's offline
-- edit on the next sync -- which is a large price for a failed guess.
--
-- This replaces the function rather than adding beside it because there is one
-- of it. The list below is the existing one with three names added; nothing is
-- removed. If anything looks wrong here, the line to check first is that every
-- original entry is still present.
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
        'quote_approved_without_phone_check'
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

select 'quote gate counters are bookkeeping, not edits' as done;

-- Bookkeeping writes no longer move the edit clock.
--
-- jobs.updated_at is the one signal last-edit-wins has: a phone pushes its
-- copy of a job only when its own edit is newer than the cloud's, and pulls
-- the cloud's copy over its own only when the cloud's is newer. That works
-- as long as updated_at means "somebody edited this job".
--
-- It stopped meaning that. touch_updated_at() bumped the clock on ANY update,
-- and three writers update jobs without anybody editing anything: the
-- payment webhook recording money, the ledger trigger recomputing
-- amount_paid, and the phone correcting contract_total on a background sync.
-- Each one made the cloud row "newer" than an edit a crew phone had made
-- offline an hour earlier -- so when that phone came back into signal, its
-- edit lost the race, was never pushed, and was then overwritten by the
-- stale cloud copy. Silently. The address a customer had corrected in the
-- yard reverted to the wrong one, and nothing said so.
--
-- Money already has its own path onto phones (the ledger rows, and the
-- take-the-money-only branch of the pull), and the recomputed total is
-- re-derived on every phone from the items. None of it needs the clock. So
-- the clock now moves only when a column that a person edits has changed.
-- The same function serves every synced table; the quiet list names jobs
-- columns and is harmless elsewhere, where those keys simply do not exist.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
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
        'last_seen_at'
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
end $$;

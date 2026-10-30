-- THE REVIEW STAMP IS BOOKKEEPING, NOT AN EDIT.
--
-- send-follow-ups writes jobs.review_email_sent_at after the review request
-- goes out. Left out of touch_updated_at's quiet list, that write moves
-- jobs.updated_at -- and a phone that edited the same job while offline then
-- loses its edit on the next sync, because the cloud row looks newer. The
-- same trap as quote_viewed_at and opted_out_at before it; see
-- docs/OFFLINE_SYNC.md and supabase_followups_settings.sql.
--
-- WHAT IS *NOT* ADDED HERE, deliberately:
--
--   completed_at -- it is stamped by r47's trigger in the same statement that
--   changes status, which is a real edit the phone must see. Quieting it
--   would be quieting that status change.
--
--   cancelled_at -- a cancellation IS an edit, and the loudest one on the
--   table. It must beat an offline price change, not hide behind it.
--
-- The whole function is restated because that is the only way to change the
-- array; the list below is the live definition (read back with
-- pg_get_functiondef on 2026-10-29) plus one entry, and the r43 note is kept
-- with it.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $function$
declare
    quiet constant text[] := array[
        'updated_at', 'dispute_opened_at', 'dispute_closed_at', 'dispute_status', 'dispute_reason', 'dispute_amount',
        'amount_paid', 'refunded_amount', 'payment_status', 'payments_from_processor',
        'contract_total', 'accepted_total',
        'quote_viewed_at', 'site_lat', 'site_lon',
        'last_seen_at',
        'priced_by', 'priced_at', 'pricing_engine_version', 'wizard_step',
        'quote_phone_attempts', 'quote_phone_locked_until',
        'quote_approved_without_phone_check',
        'opted_out_at',
        -- r43: written by price-job in the same statement as contract_total.
        'labor_cost',
        -- r48: written by send-follow-ups when the review request goes out.
        'review_email_sent_at'
    ];
begin
    if (to_jsonb(new) - quiet) is distinct from (to_jsonb(old) - quiet) then
        new.updated_at = now();
    else
        new.updated_at = old.updated_at;
    end if;
    return new;
end
$function$;

-- ---------------------------------------------------------------------------
-- Self-test, with the control that matters: a write that MUST still be loud.
--
-- A quiet list is the kind of thing that passes its own test by doing nothing
-- at all -- if the trigger were dropped, or never fired on this table, every
-- "did not move" assertion below would pass for the wrong reason. So the last
-- step edits an ordinary field and requires updated_at to MOVE. That one is
-- the canary; without it this whole block is theatre.
--
-- THE BASELINE IS PINNED TO 2020 ON PURPOSE, and the first version of this
-- test got it wrong. A DO block is one transaction, and the loud branch sets
-- updated_at = now(), which in Postgres is the TRANSACTION's timestamp -- the
-- same value the row's own insert default had just used. So a correct loud
-- write looked like "updated_at did not move" and the canary failed on
-- working code. Inserting an explicitly old updated_at (the trigger is BEFORE
-- UPDATE only, so an insert may set it) makes the two branches tell apart by
-- value rather than by clock: quiet leaves 2020, loud jumps to today.
-- ---------------------------------------------------------------------------
do $$
declare
  cid uuid; js uuid := gen_random_uuid();
  t0 constant timestamptz := '2020-01-01 00:00:00+00';
  t1 timestamptz; t2 timestamptz; t3 timestamptz;
begin
  select id into cid from public.companies order by created_at limit 1;
  if cid is null then raise notice 'r48: no company to probe with; skipped'; return; end if;

  insert into public.jobs (company_id, sync_id, customer_name, status, is_test_fixture, updated_at)
  values (cid, js, 'ZZ R48 PROBE', 'COMPLETED', true, t0);
  if (select updated_at from public.jobs where sync_id = js) is distinct from t0 then
      raise exception 'r48 FAILED: the probe could not be given an old updated_at, '
        'so neither branch below can be told from the other';
  end if;

  -- 1. The stamp itself: quiet.
  update public.jobs set review_email_sent_at = now() where sync_id = js;
  select updated_at into t1 from public.jobs where sync_id = js;
  if t1 is distinct from t0 then
      raise exception 'r48 FAILED: stamping review_email_sent_at moved updated_at (% -> %)', t0, t1;
  end if;

  -- 2. Still quiet when it is re-stamped (a second run, a correction).
  update public.jobs set review_email_sent_at = now() + interval '1 minute' where sync_id = js;
  select updated_at into t2 from public.jobs where sync_id = js;
  if t2 is distinct from t0 then
      raise exception 'r48 FAILED: re-stamping moved updated_at';
  end if;

  -- 3. THE CANARY. An ordinary edit must still be loud, or the two passes
  --    above prove only that nothing here runs.
  update public.jobs set customer_name = 'ZZ R48 PROBE 2' where sync_id = js;
  select updated_at into t3 from public.jobs where sync_id = js;
  if t3 <= t0 then
      raise exception 'r48 FAILED: a real edit did NOT move updated_at -- the '
        'trigger is not firing on jobs, so the quiet assertions above mean nothing';
  end if;

  delete from public.jobs where sync_id = js;
  raise notice 'r48 ok: the review stamp is quiet, and a real edit is still loud';
end $$;

-- And the list is readable from outside, so the next person does not have to
-- guess which patch file won.
select 'review_email_sent_at is quiet' as check,
       pg_get_functiondef(p.oid) like '%review_email_sent_at%' as pass
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'touch_updated_at';

-- WHEN THE HOA DETAILS WENT TO THE CUSTOMER.
--
-- "I also want to send the verbiage to the HOA to the customer's email so the
--  customer can send it to the HOA with every information needed."
--
-- The same lesson as the review request: a send with no record is a question
-- nobody can answer a week later. hoa_letter_sent_at is the marker, and it is
-- also what stops the office sending the same packet three times because the
-- first two left no trace.
--
-- QUIET, like review_email_sent_at (r48). It is bookkeeping written by a
-- function, not an edit somebody made, so it must not move jobs.updated_at
-- and beat a phone's offline edit of the same job.
--
-- And it still reaches the phone, which is worth writing down because it is
-- not obvious: JobSync pulls EVERY job row for the company (jobs, or
-- jobs_crew for crew) rather than filtering on a watermark, so a quiet column
-- is picked up on the next sync anyway. Quiet costs nothing here. If the pull
-- ever becomes incremental, every quiet column becomes invisible to the app
-- at the same moment -- that is the thing to remember.

alter table public.jobs
  add column if not exists hoa_letter_sent_at timestamptz;

comment on column public.jobs.hoa_letter_sent_at is
  'When the HOA details were emailed to the customer to forward. Written by '
  'the hoa-letter function. Quiet in touch_updated_at (r54): bookkeeping, '
  'not an edit.';

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
        'review_email_sent_at',
        -- r54: written by hoa-letter when the HOA packet goes to the customer.
        'hoa_letter_sent_at'
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

-- The crew view is an explicit column list, so it does not get this for free.
-- Crew do not need it (they are not the ones emailing an association), and it
-- is left out deliberately rather than by accident -- unlike the review stamp,
-- whose absence from the view invited a second email (see r52).

-- ---------------------------------------------------------------------------
-- Self-test, with the canary that r48 taught: pin an old updated_at, because
-- now() is the transaction timestamp and a loud write inside one DO block
-- otherwise looks like no write at all.
-- ---------------------------------------------------------------------------
do $$
declare
  cid uuid; js uuid := gen_random_uuid();
  t0 constant timestamptz := '2020-01-01 00:00:00+00';
  t1 timestamptz; t2 timestamptz;
begin
  select id into cid from public.companies order by created_at limit 1;
  if cid is null then raise notice 'r54: no company to probe with; skipped'; return; end if;

  insert into public.jobs (company_id, sync_id, customer_name, status, is_test_fixture, updated_at)
  values (cid, js, 'ZZ R54 PROBE', 'ACCEPTED', true, t0);
  if (select updated_at from public.jobs where sync_id = js) is distinct from t0 then
      raise exception 'r54 FAILED: the probe could not be given an old updated_at';
  end if;

  update public.jobs set hoa_letter_sent_at = now() where sync_id = js;
  select updated_at into t1 from public.jobs where sync_id = js;
  if t1 is distinct from t0 then
      raise exception 'r54 FAILED: stamping hoa_letter_sent_at moved updated_at';
  end if;

  -- THE CANARY: a real edit must still be loud, or the pass above only shows
  -- that nothing here runs.
  update public.jobs set customer_name = 'ZZ R54 PROBE 2' where sync_id = js;
  select updated_at into t2 from public.jobs where sync_id = js;
  if t2 <= t0 then
      raise exception 'r54 FAILED: a real edit did NOT move updated_at -- the '
        'trigger is not firing, so the quiet check above means nothing';
  end if;

  -- And the earlier quiet columns must still be quiet: restating the whole
  -- array is how one of them would get dropped.
  --
  -- Compared against whatever the row holds NOW, not against t0. The first
  -- version of this check tried to reset updated_at with an UPDATE, which
  -- cannot work: 'updated_at' is itself in the quiet list, so a statement
  -- that changes only updated_at has an empty diff and the trigger writes
  -- old.updated_at straight back over it. The reset silently did nothing and
  -- the check failed on correct code.
  update public.jobs set review_email_sent_at = now(), quote_viewed_at = now()
   where sync_id = js;
  if (select updated_at from public.jobs where sync_id = js) is distinct from t2 then
      raise exception 'r54 FAILED: restating the quiet list made an older '
        'bookkeeping column loud again';
  end if;

  delete from public.jobs where sync_id = js;
  raise notice 'r54 ok: the HOA stamp is quiet, real edits are loud, the old quiet columns survived';
end $$;

select 'hoa_letter_sent_at exists and is quiet' as check,
       (exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='jobs'
                   and column_name='hoa_letter_sent_at'))
       and (select pg_get_functiondef(p.oid) like '%hoa_letter_sent_at%'
              from pg_proc p join pg_namespace n on n.oid=p.pronamespace
             where n.nspname='public' and p.proname='touch_updated_at') as pass;

-- ============================================================================
-- FenceFlow -- r17: a trial that has run out must not become a wall
--
-- WRITTEN 2026-09-30.  NOT APPLIED.  Dry-run only: every statement in this
-- file was run inside a transaction that was rolled back (recipe at the end).
--
-- WHAT THE LIVE DATABASE SHOWED (read from the catalogue and the tables, never
-- from a repo .sql file)
--
--   The check.  public.company_allowed(cid) is the ONE gate: my_service_status
--   (phone and web), company_is_suspended (the 21 restrictive policies on the
--   data tables), admin_companies, the attention sweep and mail all ask it. Its
--   'trialing' arm is
--       subscription_status = 'trialing'
--       and (trial_ends_at is null or trial_ends_at > now())
--   so a company still marked 'trialing' after its trial date is refused, in
--   the app AND in the database. supabase_access_gate_patch.sql (26 August)
--   made it strict; until then 'trialing' passed whatever the date.
--
--   The handover.  Nothing in the database moves a company off 'trialing'
--   when the date passes: there is no scheduler (no pg_cron; extensions are
--   pg_net, pg_stat_statements, pgcrypto, plpgsql, supabase_vault, uuid-ossp)
--   and the only writers of subscription_status are the stripe-webhook edge
--   function and three admin functions. So "trialing -> active" happens if and
--   only if Stripe's customer.subscription.updated or invoice.payment_succeeded
--   reaches stripe-webhook and is written. The deployed handler for both is
--   byte-identical to the repo's. Legacy and Marc still carry the values the
--   trial-START event wrote (subscription_ends_at = trial_ends_at,
--   monthly_price from the price) and nothing since: no write ever followed
--   their trial end. What is NOT visible from here is why: Stripe's own
--   delivery log for the endpoint is the only place that says whether the
--   events were sent, refused or never selected.
--
--   Trial end dates are correct: each is exactly 14 days after checkout, taken
--   from Stripe's trial_end. None was set in the past.
--
--   "Paid".  Every Stripe object in this project is test-mode: all 19 rows in
--   job_payments carry livemode = false (Stripe's own field, copied at link
--   creation) and STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET have not changed
--   since 15 and 16 August. A test-mode checkout only takes a Stripe test card.
--   Legacy's "100 dollar deposit" is deposit_amount = 100 typed on a DRAFT job,
--   amount_paid = 0, no payment link, no job_payments row, no payment_records
--   row. Nobody has paid FenceFlow, and nobody has paid Legacy through it.
--
-- PART 1 (THE GATE)  a subscriber whose trial has run out but whose company
--   row still says 'trialing' has not been told anything by Stripe -- neither
--   "paid" nor "failed". That is an unknown, and this project's recurring bug
--   is reading an unknown as a no. So: 72 hours of grace (Stripe's documentation
--   gives three days of retries for a live-mode webhook delivery; not checked
--   against this account), then the
--   wall, with a message that says what is true instead of "pick a plan below"
--   to somebody who already has one. No grace for a trial with no Stripe
--   subscription behind it (admin-started trials simply end), none for a
--   suspended or cancelled company, none once Stripe has said past_due.
--   Applied by ANCHORED patch of the live bodies, so it composes with any
--   other change made to these functions and raises, changing nothing, if an
--   anchor has moved.
--
-- PART 2 (THE DATA)  a billing decision. INERT unless armed (see the guard).
--   It is here so the owner can see exactly what each choice would set.
--
-- PART 3  a read-only report.
-- ============================================================================


-- ============================================================================
-- PART 1a -- one definition of "trial over, conversion unconfirmed"
-- ============================================================================
-- One helper, so the gate, the wording, the deadline and the self-serve flag
-- cannot drift apart. Returns the moment the confirmation window closes, for
-- a company that (a) still reads 'trialing', (b) has a Stripe subscription,
-- and (c) is past its trial date -- NULL for everybody else. It returns the
-- deadline whether or not that moment has passed, so "is not null" means "in
-- this state" and "> now()" means "still inside the window".
--
-- Not callable by signed-in users: like company_allowed, an oracle keyed by a
-- company id would let anybody who has worked somewhere read its billing
-- state. The definer functions below reach it as their owner.
create or replace function public.trial_conversion_grace_ends(cid uuid)
returns timestamptz
language sql
stable
security definer
set search_path to 'public'
as $$
    select case
             when c.subscription_status = 'trialing'
              and c.stripe_subscription_id is not null
              and c.trial_ends_at is not null
              and c.trial_ends_at <= now()
             then c.trial_ends_at + interval '72 hours'
           end
      from companies c
     where c.id = cid;
$$;
revoke all on function public.trial_conversion_grace_ends(uuid) from public, anon, authenticated;


-- ============================================================================
-- PART 1b -- company_allowed: add the grace arm (anchored, idempotent)
-- ============================================================================
do $r17_gate$
declare
    d      text;
    anchor text;
    n      int;
begin
    d := pg_get_functiondef('public.company_allowed(uuid)'::regprocedure);
    if position('trial_conversion_grace_ends' in d) = 0 then
        anchor := $re$(or \(c\.subscription_status = 'trialing'\s+and \(c\.trial_ends_at is null or c\.trial_ends_at > now\(\)\)\))$re$;
        select count(*) into n from regexp_matches(d, anchor, 'g');
        if n <> 1 then
            raise exception 'company_allowed: the trialing arm to anchor on appears % times, not once. '
                'It has been rewritten since r17 was written; nothing was changed. Add this arm by hand, '
                'right after the trialing arm: or coalesce(public.trial_conversion_grace_ends(c.id) > now(), false)', n;
        end if;
        d := regexp_replace(d, anchor, $rep$\1
            -- r17_trial_conversion_grace: the trial has run out, the company still
            -- reads 'trialing', and it holds a Stripe subscription. Stripe has said
            -- neither "paid" nor "failed" -- nothing is known. Unknown is not no:
            -- 72 hours to hear, then the wall. (A failed card arrives as past_due
            -- with its own grace; this arm is only for silence.)
            or coalesce(public.trial_conversion_grace_ends(c.id) > now(), false)$rep$);
        execute d;
    end if;
end
$r17_gate$;


-- ============================================================================
-- PART 1c -- my_service_status: say the true thing (anchored, idempotent)
-- ============================================================================
-- Three edits, same signature and return type (so grants are untouched):
--   reason           a subscriber past the trial date is not told to "pick a
--                    plan below" -- they have one -- but that we have not had
--                    confirmation of the first payment.
--   grace_ends_at    while the window is open, its deadline (computed, not
--                    stored). No client shows it yet; it is here so the banner
--                    that should can, without another migration. Never for a
--                    suspended company: a suspension has no grace.
--   can_self_serve   false in this state. The web page's plan buttons, for a
--                    company that already holds a subscription, CHANGE that
--                    subscription in Stripe and leave this row as it is: the
--                    button "works" and the wall stays. Note the web page
--                    titles a can_self_serve = false screen "Your account is
--                    on hold"; the reason underneath is the accurate part.
--                    A suspended company keeps the answer it always had.
do $r17_status$
declare
    d      text;
    anchor text;
    n      int;
begin
    d := pg_get_functiondef('public.my_service_status()'::regprocedure);
    if position('trial_conversion_grace_ends' in d) = 0 then

        -- (1) reason
        anchor := $re$(when c\.subscription_status = 'canceled' then 'Your subscription has ended\.')$re$;
        select count(*) into n from regexp_matches(d, anchor, 'g');
        if n <> 1 then
            raise exception 'my_service_status: the canceled line to anchor on appears % times, not once. Nothing was changed.', n;
        end if;
        d := regexp_replace(d, anchor, $rep$\1
            when public.trial_conversion_grace_ends(c.id) is not null
                then 'Your free trial has ended and we have not yet had confirmation of your first payment from our payment provider. Your jobs and records are safe. Please get in touch so we can sort it out.'$rep$);

        -- (2) grace_ends_at
        anchor := $re$(end as reason,\s+)c\.grace_ends_at,$re$;
        select count(*) into n from regexp_matches(d, anchor, 'g');
        if n <> 1 then
            raise exception 'my_service_status: the grace_ends_at column to anchor on appears % times, not once. Nothing was changed.', n;
        end if;
        d := regexp_replace(d, anchor, $rep$\1case when not c.suspended
                  and coalesce(public.trial_conversion_grace_ends(c.id) > now(), false)
             then public.trial_conversion_grace_ends(c.id) else c.grace_ends_at end,$rep$);

        -- (3) can_self_serve
        anchor := $re$\(not \(c\.suspended and coalesce\(c\.suspended_reason,''\) = 'HOLD'\)\) as can_self_serve$re$;
        select count(*) into n from regexp_matches(d, anchor, 'g');
        if n <> 1 then
            raise exception 'my_service_status: the can_self_serve column to anchor on appears % times, not once. Nothing was changed.', n;
        end if;
        d := regexp_replace(d, anchor, $rep$((not (c.suspended and coalesce(c.suspended_reason,'') = 'HOLD'))
            and (c.suspended or public.trial_conversion_grace_ends(c.id) is null)) as can_self_serve$rep$);

        execute d;
    end if;
end
$r17_status$;


-- ============================================================================
-- PART 1d -- self-check. Fails loudly (and, in one transaction, undoes PART 1)
-- if either body does not carry the change, or lost something it had.
-- ============================================================================
do $r17_check$
declare
    a text := pg_get_functiondef('public.company_allowed(uuid)'::regprocedure);
    s text := pg_get_functiondef('public.my_service_status()'::regprocedure);
begin
    if position('r17_trial_conversion_grace' in a) = 0
       or position('trial_conversion_grace_ends' in a) = 0 then
        raise exception 'r17 self-check: company_allowed does not carry the grace arm';
    end if;
    -- Everything the gate had before must still be there.
    if position('not c.suspended' in a) = 0
       or position('is distinct from ''canceled''' in a) = 0
       or position('c.subscription_status = ''active''' in a) = 0
       or position('c.trial_ends_at is null or c.trial_ends_at > now()' in a) = 0
       or position('-infinity' in a) = 0 then
        raise exception 'r17 self-check: company_allowed lost one of its original arms';
    end if;
    if (length(s) - length(replace(s, 'trial_conversion_grace_ends', ''))) / length('trial_conversion_grace_ends') <> 4 then
        raise exception 'r17 self-check: my_service_status should call the helper 4 times (reason, deadline x2, self-serve)';
    end if;
    if position('company_allowed(c.id)' in s) = 0 or position('c.stripe_subscription_id is not null' in s) = 0 then
        raise exception 'r17 self-check: my_service_status lost something it had';
    end if;
end
$r17_check$;


-- ============================================================================
-- PART 2 -- THE DATA.  A BILLING DECISION.  INERT UNLESS ARMED.
-- ============================================================================
-- Unlocking a company is a billing decision and is not an engineer's to make.
-- Nothing below runs unless this is issued first, in the same transaction:
--     select set_config('fenceflow.r17_apply_decisions', 'yes-i-have-decided', true);
-- and optionally   select set_config('fenceflow.r17_days', '14', true);
--
-- WHAT THE EVIDENCE SAYS, company by company
--
--   Legacy  (real, third party)  trialing, Solo, trial ran its full 14 days and
--     ended 2026-09-10 18:02 UTC, holds a Stripe (test-mode) subscription, has
--     one draft job, signed in again on 2026-09-24 and met the wall. Paid:
--     nothing, and nothing could be -- the checkout is test-mode. Entitled to
--     an access decision, not to a payment's worth of access.
--       -> DECISION A: extend the trial. Status STAYS 'trialing': setting it to
--          'active' would say somebody paid, and the admin page would count
--          $99 of recurring revenue that does not exist (the webhook's own
--          comments guard against exactly that). When Stripe's event finally
--          lands it overwrites this with Stripe's truth, whatever that is.
--
--   Horizon fence llc  (real, third party)  'pending': signed up 2026-09-09,
--     signed the agreement, never reached checkout (no Stripe customer), never
--     signed in again. Has never had a day of access. The plan step is a
--     test-mode checkout, which refuses a real card, so the product's promise
--     of "14 days free" cannot currently be kept for them.
--       -> DECISION B: start a trial by hand (what admin_start_trial does).
--          No Stripe subscription, so no grace afterwards: it ends when it ends.
--
--   Marc  an internal test company on the product's own email domain, 0 jobs,
--     one sign-in on the day it was made, never again. Nobody is locked out of
--     anything. NO ACTION.
--
--   Marco  'pending', made by an admin on 2026-08-25 with a price and a plan
--     pre-set; no login has ever joined it (0 people). Nobody is locked out.
--     NO ACTION.
--
-- Each update names the company by id AND name AND the state the decision was
-- made in, and must match exactly one row or the whole block raises and
-- changes nothing. The audit trail will file these as done by "billing
-- webhook" (the trigger's word for any company change with no login behind
-- it); admin_notes says what really happened.
do $r17_data$
declare
    armed text := coalesce(current_setting('fenceflow.r17_apply_decisions', true), '');
    grant_days int := coalesce(nullif(current_setting('fenceflow.r17_days', true), ''), '14')::int;
    n     int;
    stamp text := to_char(now() at time zone 'utc', 'YYYY-MM-DD');
begin
    if armed <> 'yes-i-have-decided' then
        raise notice 'r17 PART 2 (data) is not armed: nothing was changed.';
        return;
    end if;
    if grant_days < 1 or grant_days > 60 then
        raise exception 'r17: fenceflow.r17_days must be between 1 and 60, got %', grant_days;
    end if;

    -- DECISION A -- Legacy
    update public.companies c
       set trial_ends_at = now() + make_interval(days => grant_days),
           admin_notes = coalesce(nullif(c.admin_notes, '') || E'\n', '')
                      || 'r17 ' || stamp || ': trial extended ' || grant_days || ' days by SQL. The 14-day trial had ended '
                      || 'and no word from Stripe had moved the company off trialing. Status left as trialing, not '
                      || 'active: nothing was paid. Audit log names this change as the billing webhook.'
     where c.id = 'ccb9b8cd-0925-45cd-a04d-c2c106c370bd'
       and c.name = 'Legacy'
       and c.subscription_status = 'trialing'
       and c.stripe_subscription_id is not null
       and c.trial_ends_at <= now()
       and not c.suspended;
    get diagnostics n = row_count;
    if n <> 1 then
        raise exception 'r17: Legacy is no longer in the state decision A was made for (matched % rows). Nothing was changed.', n;
    end if;

    -- DECISION B -- Horizon fence llc
    update public.companies c
       set subscription_status = 'trialing',
           trial_ends_at = now() + make_interval(days => grant_days),
           admin_notes = coalesce(nullif(c.admin_notes, '') || E'\n', '')
                      || 'r17 ' || stamp || ': ' || grant_days || '-day trial started by SQL. The company signed up, '
                      || 'signed the agreement and never reached checkout. No Stripe subscription. '
                      || 'Audit log names this change as the billing webhook.'
     where c.id = '20f62301-6737-4385-ad95-3610a115b4b7'
       and c.name = 'Horizon fence llc'
       and c.subscription_status = 'pending'
       and c.stripe_subscription_id is null
       and c.trial_ends_at is null
       and not c.suspended;
    get diagnostics n = row_count;
    if n <> 1 then
        raise exception 'r17: Horizon fence llc is no longer in the state decision B was made for (matched % rows). Nothing was changed.', n;
    end if;
end
$r17_data$;


-- ============================================================================
-- PART 3 -- read-only: the real companies under the gate as it now reads
-- (no email, phone or address is selected)
-- ============================================================================
select c.name,
       c.subscription_status                         as status,
       c.trial_ends_at                               as trial_ends_at,
       (c.stripe_subscription_id is not null)        as holds_subscription,
       public.company_allowed(c.id)                  as allowed,
       public.trial_conversion_grace_ends(c.id)      as conversion_window_closes
  from public.companies c
 where c.name !~ '^ZZ'
 order by c.created_at;


-- ============================================================================
-- DRY RUN -- how this file was tried without keeping anything
-- ============================================================================
--   begin;
--   select set_config('fenceflow.r17_apply_decisions', 'yes-i-have-decided', true);  -- omit to see PART 2 do nothing
--   <this whole file>
--   <a before/after comparison of public.companies>
--   rollback;
-- tests/a26-trial-lockout.test.mjs runs exactly that (A26_TRIAL_LIVE=1) and then
-- checks that the helper function does not exist and no company row moved.

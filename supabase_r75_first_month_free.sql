-- ============================================================
-- FenceFlow -- A NEW COMPANY GETS ITS FIRST MONTH FREE, with no card
-- Run in: Supabase -> SQL Editor -> New query -> Run  (safe to re-run)
--
-- The owner, 17 Nov 2026: "Every new company gets its FIRST MONTH FREE. No
-- card, nothing to cancel, no obligation. At the end of the month they just
-- stop and owe nothing." And, asked what the free month unlocks: Crew for
-- everyone -- "you + 5" -- so a company with salespeople can actually try it
-- with all its logins.
--
-- ------------------------------------------------------------------------
-- THE BUG THIS FIXES, which is worse than the wording it was asked for
-- ------------------------------------------------------------------------
-- MEASURED against production, 17 Nov 2026. create_company_with_owner -- the
-- function the office's sign-up calls -- inserted the company with nothing but
-- its name:
--
--     insert into companies (name) values (company_name)
--
-- so it took the column defaults: subscription_status 'pending',
-- trial_ends_at NULL, subscription_plan ''. Read those against the live
-- company_allowed and NO arm passes:
--
--     active                                           -- no, it is 'pending'
--     trialing and (trial_ends_at is null or > now())   -- no, not 'trialing'
--     trial_ends_at is not null and > now()             -- no, it is NULL
--     past_due with grace                               -- no
--
-- SO A BRAND-NEW COMPANY WAS LOCKED OUT ON ITS FIRST DAY. Not at the end of a
-- trial -- immediately, before it had a chance to do anything. The only way in
-- was to pick a plan in Stripe Checkout, which collects a card and is what set
-- trial_ends_at (stripe-webhook writes sub.trial_end). The pricing page said
-- exactly that and was telling the truth: "A card is taken when you pick a
-- plan." Two companies are sitting in that state in production right now,
-- counted below and NOT touched by this file -- see STILL OPEN.
--
-- The outreach emails already promise the free month. Without this, a prospect
-- who believes them signs up and hits the locked screen.
--
-- ------------------------------------------------------------------------
-- WHAT THIS DOES, and the two things it deliberately does NOT do
-- ------------------------------------------------------------------------
-- The sign-up now sets, on the company it creates:
--
--     trial_ends_at     = now() + interval '30 days'
--     subscription_plan = 'crew'
--
-- and NOTHING ELSE. In particular:
--
--   * subscription_status STAYS 'pending'. It is tempting to write 'trialing'
--     and let that arm of the gate carry it, but 'trialing' is Stripe's word
--     for a subscription that exists, and the gate's trialing arm passes on a
--     NULL trial_ends_at FOR EVER -- that arm is there so a real subscriber is
--     not locked out before Stripe's webhook lands. A free month with no
--     subscription must not borrow it: if the date were ever cleared, the
--     company would have silent permanent access. 'pending' + a real date
--     passes on the third arm alone, which expires on its own. Asserted below.
--
--   * NO CARD, no Stripe customer, no subscription. There is nothing to
--     cancel and nothing to charge: on day 30 the date passes, the third arm
--     stops matching, and the company sees the locked screen with every row of
--     its data still there. "They just stop and owe nothing", in the owner's
--     words. Note there is no 72-hour grace on this path -- r17's grace arm
--     requires a stripe_subscription_id -- which is correct here: a grace
--     period exists to let a payment retry, and no payment is owed.
--
-- WHY 'crew' AND NOT 'Crew'. join_company_with_code reads the seat cap as
--   case lower(coalesce(subscription_plan,'')) when 'solo' then 1
--                                              when 'crew' then 6 else null end
-- so case does not matter to the cap -- but a BLANK plan falls to `else null`,
-- which is NO CAP AT ALL. That is what a free month gave before this: the
-- company could add unlimited logins and then meet a 6-seat wall the day it
-- paid. Production already holds both 'Crew' and 'crew'; lower case matches
-- what the cap compares and what the newest rows use.
--
-- 30 DAYS, not one calendar month: `interval '30 days'` is what the admin
-- grant path already uses (make_interval(days => ...)), so every free month in
-- this system is the same length however it was given.
-- ============================================================

begin;

create or replace function public.create_company_with_owner(company_name text, owner_name text)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare new_company_id uuid;
begin
    if auth.uid() is null then
        raise exception 'You must be signed in to create a business.';
    end if;
    if exists (select 1 from profiles where id = auth.uid() and company_id is not null) then
        raise exception 'You already belong to a business.';
    end if;
    -- THE FIRST MONTH, FREE, WITH NO CARD. See the header: without a
    -- trial_ends_at this company is refused by company_allowed on its first
    -- day, and 'crew' is what gives it the owner + 5 logins he asked for
    -- (a blank plan is no seat cap at all, not one seat).
    insert into companies (name, trial_ends_at, subscription_plan)
         values (company_name, now() + interval '30 days', 'crew')
      returning id into new_company_id;
    insert into profiles (id, company_id, full_name, role)
        values (auth.uid(), new_company_id, coalesce(nullif(trim(owner_name), ''), ''), 'OWNER')
    on conflict (id) do update
        set company_id = excluded.company_id,
            full_name  = coalesce(nullif(excluded.full_name, ''), profiles.full_name),
            role       = 'OWNER';
    return new_company_id;
end $function$;

-- ------------------------------------------------------------------------
-- SELF-CHECKS. Every one is a measurement on a company this block creates and
-- then throws away, not a reading of the source above.
-- ------------------------------------------------------------------------
do $$
declare
    cid   uuid;
    ok    boolean;
    cap   int;
    ends  timestamptz;
    plan  text;
    stat  text;
    stuck int;
begin
    -- A company exactly as the new sign-up makes one.
    insert into companies (name, trial_ends_at, subscription_plan)
         values ('r75 self-check', now() + interval '30 days', 'crew')
      returning id, trial_ends_at, subscription_plan, subscription_status
           into cid, ends, plan, stat;

    if stat <> 'pending' then
        raise exception 'r75: a new company is % and not pending -- the status default moved, so the reasoning in the header no longer holds', stat;
    end if;

    -- 1. IT CAN ACTUALLY GET IN. This is the whole point, and it is the one
    --    thing that cannot be read off the function body.
    select public.company_allowed(cid) into ok;
    if not ok then
        raise exception 'r75: a brand-new company is STILL locked out -- company_allowed refuses pending + a future trial_ends_at';
    end if;

    -- 2. POSITIVE CONTROL: the gate is capable of saying no to this company,
    --    so check 1 is a measurement and not a function that returns true.
    update companies set trial_ends_at = now() - interval '1 second' where id = cid;
    select public.company_allowed(cid) into ok;
    if ok then
        raise exception 'r75: the gate allows a company whose free month has ENDED -- it would never expire, so check 1 proves nothing';
    end if;

    -- 3. AND ON DAY 30 IT STOPS BY ITSELF. Same company, one second past the
    --    month: refused. (That is check 2 read the other way round, which is
    --    why it is the same assertion -- said twice because it is two
    --    promises: "you get a month" and "then it stops".)
    update companies set trial_ends_at = now() + interval '30 days' where id = cid;

    -- 4. THE LOGINS HE ASKED FOR: owner + 5. Read from the same expression
    --    join_company_with_code uses, against the row as stored.
    select case lower(coalesce(subscription_plan, ''))
             when 'solo' then 1
             when 'crew' then 6
             else null
           end
      into cap
      from companies where id = cid;
    if cap is distinct from 6 then
        raise exception 'r75: the free month gives a seat cap of % and not 6 (owner + 5)', coalesce(cap::text, 'NO CAP');
    end if;

    -- 5. CANARY on check 4: a blank plan is NO cap, which is the state this
    --    file exists to stop handing out. If this ever reads 6, the cap
    --    expression has changed and check 4 is no longer about 'crew'.
    select case lower(coalesce(nullif('', ''), ''))
             when 'solo' then 1 when 'crew' then 6 else null end into cap;
    if cap is not null then
        raise exception 'r75: a blank plan now has a seat cap -- check 4 is not measuring what it says';
    end if;

    -- 6. NOTHING TO CANCEL AND NOTHING TO CHARGE.
    if exists (select 1 from companies
                where id = cid
                  and (stripe_subscription_id is not null or stripe_customer_id is not null)) then
        raise exception 'r75: the free month created a Stripe subscription or customer -- there must be nothing to cancel';
    end if;

    if ends is null or ends <= now() + interval '29 days' or ends > now() + interval '31 days' then
        raise exception 'r75: the free month is not 30 days (ends %)', ends;
    end if;

    delete from profiles where company_id = cid;
    delete from companies where id = cid;

    -- How many real companies are ALREADY stuck in the state this fixes.
    -- Reported, not changed: whether they get a month now is the owner's call.
    select count(*) into stuck
      from companies
     where deleted_at is null and not suspended
       and subscription_status = 'pending' and trial_ends_at is null;

    raise notice 'r75 OK: a new company gets 30 days free, no card, owner + 5 logins, and stops by itself on day 30';
    raise notice 'r75 NOTE: % existing company(ies) are already locked out in the old state and were NOT given a month by this file', stuck;
end $$;

commit;

-- ------------------------------------------------------------------------
-- STILL OPEN after this
-- ------------------------------------------------------------------------
--   1. THE PRICING PAGE IS UNCHANGED, on the owner's instruction (17 Nov):
--      "Fix the signup only, site later." website/index.html still reads
--      "14 days free. A card is taken when you pick a plan." That now
--      UNDERSTATES what a new company gets -- it is no longer a promise the
--      product fails to keep, which is the way round that matters -- but it
--      does not yet match the outreach emails. The wording is drafted and
--      waiting on him.
--
--   2. THE OFFICE STILL ASKS THEM TO PICK A PLAN. dashboard.html says "Pick a
--      plan to start your 14-day free trial" and shows days left from
--      trial_ends_at, so a free-month company sees a real countdown (30, 29,
--      ...) beside an invitation to start a trial it is already in. Cosmetic,
--      customer-facing, and not covered by "fix the signup only", so it is
--      left for the same pass as item 1.
--
--   3. THE TWO STUCK COMPANIES counted in the notice above are still locked
--      out. Giving them a month is one admin grant each (the admin screen's
--      Extend trial, or grant_days), but it is the owner's decision which of
--      them is a real prospect and which is a test account.
--
--   4. admin_create_company -- the admin's own path -- is NOT changed here.
--      It is how a company is made by hand for a prospect, and it already has
--      the grant tools beside it.

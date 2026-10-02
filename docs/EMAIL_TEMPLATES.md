# Emails to the customer

Written 2 October 2026. One page, so you can decide what you want changed.

You asked to email customers from the app and the website, with a template for
sending the quote and "other templates as well, whatever is needed". This is
what the other templates are, when each one goes out, what you have to have
filled in first, and what I decided **not** to build and why.

The quote-send email itself is a separate piece of work happening alongside
this one. This page is about the rest of the set.

---

## First, two things you need to know before any of this helps

**1. The customer's email address lives on the JOB, not on a customer record.**
The `customers` table in your database has two rows in it, and both belong to a
test company. Every real company has none. So the name, address, phone and
email all sit on the job itself, which is fine — it just means "email the
customer" means "email whatever is in the Email box on that job".

Measured on your live data, read-only, this morning:

| | count |
|---|---|
| Your live jobs | 8 |
| ...with an email address on them | **5** |
| ...with a phone number on them | 5 |

So three of your eight jobs cannot be emailed at all. That is not a bug, it is
a blank box. Every template below refuses with a plain sentence rather than
offering you a Send button that cannot send.

**2. The contract email you already have is not switched on.**
The email that goes to the customer the moment she approves her quote — her
copy of the agreement, the total, the deposit and how to pay it — is written,
tested and sitting in the repo. It is **not deployed**, and the table it writes
its record to does not exist in your database. So right now, when somebody
approves a quote, nobody emails her anything.

Turning that on is two commands and it is the single highest-value thing on
this page. It is at the bottom, under **What you have to run**.

---

## The four templates

Each one belongs to exactly one moment, so there is never a point where two of
them could both be right.

### 1. "Please approve your updated quote" — the drawing changed

**When:** after she has approved, something material changes in the drawing, so
the database withdraws her approval. You see a "Needs approval again" badge; her
quote page already shows a notice telling her to look again, in her own
language.

**Why it has to exist:** nothing tells her to go and look. She has no reason to
open the page again. The job just stops, and the payment link refuses to ask for
any more money until she re-approves. **Three of your live jobs are in exactly
this state right now.**

**What it says:** we updated your drawing (on this date, and the X line changed,
if we know those); your earlier approval was for the old drawing so we need a
new one; here is the link; payments you have already made are not affected.

**What you need filled in:** the customer link, which the job gets as soon as it
reaches the cloud. Nothing else. No date, no run name — if we do not have them
the sentence just does not mention them.

**No figures at all.** This email exists because the price moved. Putting a
number in it would be putting a number in her inbox that is wrong by the time
she reads it.

### 2. "Payment received" — the receipt

**When:** money arrives — Zelle, Cash App, cash in hand, or a card.

**Why it has to exist:** there is no receipt anywhere in this product. Not in
the app, not in the office, not from Stripe or Square. When you take cash, the
only record she has is your word.

**What it says:** we received $X (on this date, if we know it); thank you; what
is left to pay; the page always shows where the money stands.

**What you need filled in:** the amount. That is all. If you have not got a
"left to pay" figure, the line simply is not there — no "Left to pay: " with
nothing after it.

**The figures:** only the payment itself, and the "left to pay" figure, under
exactly the words your quote page uses for it ("Left to pay"). Nothing is worked
out in the email. There is no total and no deposit in it, so it cannot disagree
with the page.

### 3. "Your fence is on the schedule" — the date

**When:** you put a date on the job.

**Why it has to exist:** nothing tells her. And this is the only email in the
set that reaches her **before** the crew is standing in her yard, which makes it
the right place for your own standing rules.

**What it says:** your fence at X is on the schedule for DATE. Then, in your own
words off the walkthrough checklist: we clear leaves and loose debris only —
anything that needs a tool, bushes, planters, sheds, tree limbs, old posts, is
yours to clear before we start or it goes on a change order. Then: move anything
of yours on the fence line; show us or mark sprinklers, septic and irrigation.
Then: if the date does not suit you, tell us as soon as you can.

**What you need filled in:** the date. Nothing else.

**No time of day, no duration, no crew size, and no promise about the weather.**
It says you are on the schedule for a day, and that is all it says.

### 4. "Your fence is finished"

**When:** the work is done and the final walkthrough is behind you.

**Why it has to exist:** nothing closes the loop, and nothing points at what is
still owed.

**What it says:** your fence at X is finished; if anything is not right, reply
or call; what is left to pay; the page is still there.

**What you need filled in:** nothing. The address, the phone and the balance
each drop out of the email if you have not got them.

**No warranty length.** You have never told me one, so none of these emails
states one. See **Things only you can decide** below, because there is a
warranty length printed on your contracts right now that nobody checked with
you.

---

## What I decided NOT to build, and why

| Not built | Because |
|---|---|
| "Here is your quote" | Being built alongside this, as its own piece of work. |
| Quote sent and not opened / opened and not approved / approved with no deposit / new lead not contacted | You already have all four. They are in the follow-up scheduler, with your own timings and quiet hours. See the note on it below. |
| "Thank you for approving" with the contract, the total and the deposit | Already written, in full, in three languages. It is not switched on — that is a deploy, not a new template. |
| "Would you leave a review" | You already have five of these on the phone, and it picks the right one for you depending on whether the job went well, whether she is a repeat customer, and how big it was. A sixth wording sent by email would be a second thing to choose between. |
| "Sign this change order" | Your customer's quote page has no change-order section on it at all. An email asking her to sign one would point at a page that does not show it. Build the page first and this template is worth having. |

---

## Things only you can decide

1. **Warranty.** No email here mentions one. But `PdfExporter.kt` prints
   **"one year"** into the warranty line of your contract PDF, hardcoded, in all
   three languages. If that is not your warranty, it is on paper in a customer's
   hands and needs changing. If it is yours, say so and it can go in the
   finished-fence email too.
2. **The follow-up scheduler is switched on for your company but has never run
   once.** Its log is empty, and nothing in the project is set up to call it on
   a schedule — there is no cron in this database. So the four nudges are armed
   and waiting for a trigger that does not exist. That is a decision (do you
   want automatic nudges going to customers?), not a bug.
3. **Who presses Send.** Everything here is a template you read and send
   yourself. Nothing on this page sends anything automatically. If you want the
   re-approval notice or the receipt to go out on its own, say so — that is a
   different piece of work with different risks.
4. **The crew.** The receipt and the finished-fence email can carry money, so
   they are yours and the office's. The re-approval notice and the schedule
   notice carry no figures at all, so a foreman could send one safely.

---

## What you have to run

**Nothing has been deployed and nothing has been committed.** These are the
commands, for when you want them.

**1. Switch on the contract email that already exists** (the biggest single
win here). There are no migration folders in this project — SQL is applied by
running the file. Table first, then the function, in that order:

```
cd C:/Users/march/AndroidProjects/FenceEstimator
npx --no-install supabase@2.115.0 db query --linked --project-ref newcrgafcptspmapacrx -f supabase_a55_approval_emails.sql
npx --no-install supabase@2.115.0 functions deploy quote-approval-email --project-ref newcrgafcptspmapacrx
```

That SQL file creates `public.quote_approval_emails`, which is the table both
`quote-approval-email` and `quote-view` write to before anything is sent. Until
it exists, every approval fails to email anybody, and the record of the failure
also has nowhere to go.

Order matters: deploy the function first and an approval in the gap between the
two commands fails with no trace of why.

**2. The four templates on this page need no deploy of their own.** They are a
template library, not a sender. The office already has a working email window
that sends through `mail-send` — what is missing is the picker that drops a
template into it, which is a small change to `website/dashboard.html`. That file
is being rewritten by another piece of work right now, so I did not touch it;
the exact change is written down in the hand-off notes rather than half-applied.

---

## Where the words live

Change the wording in ONE place and both copies follow, or the tests go red:

- `supabase/functions/_shared/email-templates.ts`, section 3 — the words.
- `website/js/lib/job-emails.mjs` — the browser's copy, for the office.
- `tests/a73-email-template-set.test.mjs` — proves the two say the same thing,
  character for character, and that no template can print an empty label, an
  invented figure or a term you never agreed to. Run it with:

```
node --test tests/a73-email-template-set.test.mjs
```

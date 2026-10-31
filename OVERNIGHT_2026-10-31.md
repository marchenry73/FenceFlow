# Overnight, 30–31 October 2026

What I did while you were asleep, what needs you, and what I deliberately did
not touch.

---

## FIRST, because it is money: the deposit does not follow a re-price

`supabase_r8_deposit_follows_price.sql` is **half applied**. The function
`deposit_follows_price()` is live. **Its trigger on `public.jobs` is not** — so
nothing calls it, and the rule you decided on 24 September ("deposit must
follow re-price everywhere") has never been in effect. Re-price a draft and the
deposit silently stays at the old figure.

The file's own ten proofs all pass against the live database inside a
rolled-back transaction, canary included: a plain draft follows, an approved or
signed job is frozen, a withdrawn approval follows again, money paid freezes it,
a deposit typed in the same statement is never re-scaled, and the scaled figure
is capped at the price — your $3,963-deposit-on-a-$3,620-job case.

I did not apply it, because it changes money behaviour and the call is yours:

```
npx supabase db query --linked --project-ref newcrgafcptspmapacrx -f supabase_r8_deposit_follows_price.sql
```

---

## Three more migrations that were never applied

I checked all **346** `supabase_*.sql` files in the repo against the live
database — extract every table, view, function and trigger each one creates,
then ask the database which of them exist. 16 came back fully absent (most are
throwaway `pg_temp` probe files) and 11 partly. These are the real ones:

**`supabase_r42_product_key_test_and_real.sql` — this is item E2, already
solved.** Written 24 October, never run. It works the problem out properly:
TEST vs REAL is a property of the **company**, not of the code, so it reuses
`company_setup_codes` and the phone needs no change at all. It adds
`admin_mint_setup_code`, because the admin portal currently cannot issue a key
for a company that already exists — it can only copy the one shown at creation
— plus a deliberately inert company-level sandbox flag. It also records why your
four `ZZ TEST` companies are unreachable: **zero setup codes and zero profiles
each**, so nobody can sign in to see the test data they hold.

I had told you earlier in the night that E2 needed you to define what the
sandbox was. That was wrong. I should have looked for a migration before
concluding — which is precisely the check that found r9 unapplied earlier the
same evening.

**`supabase_r20_seed_new_company_catalog.sql`** — `seed_starting_catalog` and
its trigger. This is *why* `shouldAutoSeedMaterialItems` is `= false` and why a
new company's catalog is empty, which is the same fact behind the prices card I
reworded tonight.

**`supabase_r53_more_than_one_crew_on_a_job.sql`** — the `job_assignments`
table. The other half of the multi-crew feature whose companion
(`supabase_crew_job_scope.sql`) is still waiting on your decision, and which I
proved runnable earlier tonight.

---

## The two things that need you — both one-off, both a minute

**1. Turn the device lock on.** Office → Settings → Product keys → **"Only one
phone per login"**. Issue yourself a key first, because with the lock on moving
a login to a different handset needs one — including your own owner accounts.
The server side is already live; the switch does what it says the moment you
flip it. I left it **off** on purpose: it decides who can work, so it is yours
to turn on, not mine.

**2. Open the app on the phone that showed the $0 sides**, let it sync, then
re-price Marco's job. The catalog restores itself on the first sync now. The
five sides come back with real prices.

## Two values that print on contracts your customers sign

I flagged these rather than guess, because they are facts about your business:

* `license_number` is **`1234567890`**. That is printing as your licence.
* The contract header prints **`marchenry73@gmail.com`**, your personal
  address, not `marc@fenceflowapp.com`. (It reads
  `company_settings -> email`; `companies.email` is the separate
  customer-facing address and is correct.)

## One decision, left open at your instruction

**Markup for a company that types nothing.** The office blanks it to 15%, the
phone to 0%. Both are defensible and nothing in the repo records which you
want, so I left both as they are and stopped pinning the disagreement in the
tests — the check I had written would have gone red the day somebody settled
it, which is a guard that punishes the fix.

---

## What was actually wrong, and is now fixed

### The $0 sides on Marco's job — four fixes, one cause

41 of 47 lines on an ACCEPTED job (agreed $17,692.91) were re-written at $0.00
across five sides, while the one side whose drawing had not moved since
23 October still carried **the same four products** at $9.50 / $2.25 / $3.25 /
$4.75. Your cloud catalog was correct the whole time and had not been edited
since 3 September.

1. **`can_see_pay()` answered a confident "no" to a question it could not
   answer.** It reads `profiles where id = auth.uid()`; an empty result falls
   through its CASE to `false`. Proven against the live database with a real
   OWNER answering `true` in the *same transaction* as the control.
2. The phone is **built** to tell "no" from "cannot say" — three states, and
   `SyncScope.kt` says outright that UNKNOWN must never collapse into DENIED.
   None of it could fire, because nothing threw. The collapse was on the
   server, one step earlier.
3. A first-time DENIED runs `forgetMoney()` →
   `UPDATE material_items SET unitPrice = 0.0`.
4. **And it never came back.** The pull carries a price only when the cloud row
   is *newer*, and the scrub deliberately leaves `lastUpdated` alone — so the
   clocks compared equal and the restoring branch never ran again. Not after
   signing out and in, and not on the promotion pass that exists precisely to
   pull the real prices down. That claim was in a comment and had never been
   tested. It was false.
5. Your next drawing edit then re-priced five sides off the zeroed catalog and
   said nothing — the automatic refresher throws away the engine's own
   "priced at $0" warning and has no screen to show it on.

Fixed at four points: **r59** makes the server raise instead of lying; the pull
now restores a zeroed price whenever the owner door is open, **ignoring the
clock**, so every phone already in this state heals itself on the next sync;
a rebuild can never write $0.00 over a line that already had a figure, at the
one funnel both re-price paths go through; and the silent refresher refuses to
run off a catalog with no prices in it at all.

Only Marco's job was affected — I checked every job.

### "Use this phone only" — four reasons it did nothing

1. `require_device_key` was `null`, so the lock was off.
2. **Nothing anywhere could turn it on.** Not the office, not the app — it had
   only ever been settable by hand in SQL, while a complete "Product keys"
   panel sat beside it. The switch added this session is that missing piece.
3. Even switched on, **OWNER was exempt**, and both your accounts are OWNER.
4. **`supabase_r9_displaced_device_push.sql` had never been applied** — the
   trigger that tells the old phone it lost the login did not exist. Its edge
   function had been deployed and idle for a week.

And the fact that mattered most: the phone you tested on was signed in as your
**second owner account**, which claimed a device at 21:49 that evening. The
lock is per login, so no device rule of any strictness would have refused it.
That same fresh sign-in is almost certainly what scrubbed the catalog, so the
two reports were one event.

**r60** removes the exemption and adds **one owner phone per company**, which
is what you chose. A displaced owner's row is pointed at the claiming handset
rather than nulled — a null reads as "no device claimed", which would have left
the old phone running.

### The home-screen number that climbed

`outstandingTotal` started at **0.0** and the hero drew it at 38sp, so the
first frame was a formatted, confident, wrong figure. On a first sign-in it was
worse than a flicker: the jobs were still arriving, every arrival re-ran the
sum, and a running subtotal was drawn as the answer. Its own documentation, two
lines above that `0.0`, says a figure approximately right about money is worse
than no figure.

It shows a dash until it has an answer, and while a sync is running it says
*"Still loading your jobs — this figure is not final yet."* A real $0.00 still
reads $0.00; that is an answer, and the two were indistinguishable before.

### Cancellation (C1), and the money rule it exposed

Every contract shipped with
`YOUR RIGHT TO CANCEL -- [REPLACE THIS BLOCK BEFORE USING THIS CONTRACT]` and
four lines telling **you** to go and get the wording — printed on the copy the
customer signs.

I wrote the clause straight into the three shipped defaults first. That turned
`tests/a42` red in five places, and its reason changed my mind rather than the
other way round: the block is attorney wording, and legal text shipped as a
silent default lands on every contractor's contracts in every state.

So it is **offered, not imposed**. The default keeps its marker and the warning
keeps firing; beside that warning there is now a button that writes the federal
three-business-day right to cancel into *your* terms when *you* tap it, in all
three languages, with what it is and is not above the button. One tap and the
warning stops.

**r61** settles the contradiction it exposed. Inside those three business days
the federal rule returns every payment and leaves the customer owing nothing,
while r45 charged $1/ft plus the whole material sell from the first minute
after signing. Now nothing is retained inside the window; outside it, r45 is
untouched. Proven on a real signed job: 60 days old keeps **$1,805.68**, one
minute old keeps **$0.00** and refunds everything, unsigned unchanged. Both
halves of the product say *why* it is zero, so three rows of $0.00 are never
read as a broken screen by somebody who then charges the fee anyway.

### Two stores held your business name, and customers got both

* `companies.name` said **Fence solutions**; the settings blob said
  **Legacy solutions**; `companies.phone` was **empty** while the blob had
  8135779310.
* The **phone** sends quotes from the blob, the **server** sends the approval
  confirmation from the column. So the same customer got "Your fence quote from
  Legacy solutions" and then "Your approved fence quote from Fence solutions".
  Three customers got the first version on 24 and 26 October.

You settled it: **Legacy Solutions** — a capital S neither store had. **r62**
writes that to both and installs a mirror so they cannot drift again, whichever
side is written, with a non-blank value never losing to a blank (that is what
filled your empty phone instead of wiping the number). Email is deliberately
**not** mirrored: `companies.email` is the customer-facing address and that
separation is intentional.

**Expect this:** server-sent mail, Stripe payment-link text, HOA letters and
crew invitations have been saying "Fence solutions" and will now say
"Legacy Solutions".

### B2 — signing in on another phone

The retry budget for a first sign-in was **spent once and never refilled**.
Three attempts at 4s/8s/12s, and the counter only reset on a pass that *did*
get an answer — so one bad minute disabled the retry for the rest of the
process, and every later unanswerable pass waited for a heartbeat: 60s with the
app open, **fifteen minutes in a pocket**.

This mattered more as of tonight, not less: r59 means a fresh sign-in now
correctly gets UNKNOWN instead of a wrong DENIED, so **every** first sign-in
comes through this retry path. A path that recovers once is not enough for the
path every sign-in takes. A sign-in now refills the budget. The bound itself is
unchanged — three asks over 24 seconds is right for a connection still coming
up, and the argument for bounding it is good.

---

## Nine owner-list items turned out already built

I checked each against the live system rather than the list. **C2** (pay link on
the customer quote), **C3** (draw-or-type signature with verification, and the
download afterwards), **F2** (the two drawing-change sections, merged on both
halves), **F4** (the customer reply-to — proven from real sent mail: every
customer email carries the inbound address that lands in your office inbox) and
**D5** (the teardown fields explain which footage they charge, in six
variants). D1, D2, D3, E1 and F3 were already marked done on 24 October.

**Genuinely open:** E2 (a test product key and a real one), G1 (finish drawing
versions), and A4 — on which I did a pass tonight: the "a typed zero reads as
unset" class is now clean across every money field in the office and the server
pricing engine.

One finding from the publish gate worth your attention: **there is no overtime
concept anywhere in the app.** `CrewPay` pays hours × rate with no weekly
threshold, while the office's "estimated pay" card can show overtime. So pay is
the one money figure without a single true answer across the two halves. The
office card is labelled an estimate, so this may be deliberate — but payroll in
the app would not be a two-line port.

---

## What shipped

* **App 1.843**, published and verified from the hosted artifact (sha256
  matches the build, manifest reads 843).
* **Office page** live, verified byte-identical to the commit as served.
* **`quote-view` v48** — the approval push is a data message at HIGH priority.
  It was the seventh of seven senders still using the shape a backgrounded app
  cannot draw, so "quote approved" may not have been reaching you.
* **r9, r59, r60, r61, r62** applied to the live database, each verified by
  reading the object back rather than trusting an exit code — which mattered,
  because r60 reported success once without landing.
* Suite **264/264**.

## What I got wrong, and how it was caught

* **r59 as I first applied it was wrong.** I wrote `can_see_employee_pay()` to
  check a permission called `SEE_EMPLOYEE_PAY`, taking the name from a doc
  comment that states it. No role grants a permission by that name — the real
  function asks `SEE_PAY`. For about twenty minutes it answered false for
  everybody, which would have hidden payroll from you, your manager and any
  accountant. `tests/a16` caught it in one line because it has a positive
  control asserting an ACCOUNTANT reads true; my own r59 self-check could not
  have, because it only proved the function *raises* for an unknown caller —
  which a function that answers false for everyone also does. Corrected,
  re-applied, and the missing control added. I also fixed the comment that
  misled me.
* **The publish gate refused my first publish**, correctly: the APK on disk was
  841, built before the commits, and publishing it would have left every phone
  in a permanent update loop.
* Three smaller slips, all the same shape — a check matching its own
  explanatory comment (twice) and backticks inside a JS template literal. Each
  failed loudly rather than shipping a wrong result, but the lesson is that
  "verify" has to mean the code, not the prose around it.

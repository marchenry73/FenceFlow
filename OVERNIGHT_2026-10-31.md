# Overnight, 30–31 October 2026

What I did while you were asleep, what needs you, and what I deliberately did
not touch.

The run is finished — six hours, stopped on time. **Nothing was applied to the
database, nothing deployed, nothing published, and nothing pushed.** Seven
commits are waiting on the branch. The suite is 271 files, all green.

---

## START HERE: the decisions, in the order of what it costs to get them wrong

Everything here is explained further down; this is just the list, because the
sections below are newest-first and that is not the same as most-important.

**1. The deposit does not follow a re-price. It never has.** The function is
live, its trigger was never created, so the money rule you decided on 24
September has not fired once. Its own ten proofs pass against your live
database inside a rolled-back transaction. One command, and it is the first
thing I would run:

```
npx supabase db query --linked --project-ref newcrgafcptspmapacrx -f supabase_r8_deposit_follows_price.sql
```

**2. Two of the seven held commits change what a customer can be sent.** The
first widens which prices count as unconfirmed; the second adds the box that
confirms one from the office. (A third touches that page too, but only a
comment — the four others are tests, a migration file and this log.) The office will
now refuse to send some quotes it used to send — the ones carrying a price
nobody has confirmed. That is the intended behaviour and it is stricter than
yesterday, so it is yours to approve before it goes live. See the first section
below.

**3. Then push, build and publish — in that order, price-job FIRST.** Both
sides carry 2026.09.3; if the office is newer the phone backs off, and if you
ship the phone first it overwrites the office.

**4. Two values print on contracts your customers sign** and both are wrong:
the licence number is still `1234567890`, and the contract header prints
`marchenry73@gmail.com` rather than `marc@fenceflowapp.com`. Minutes to fix,
and they are on paper a customer keeps.

**5. Turn the device lock on** (office → Settings → Product keys → "Only one
phone per login"). Issue a key first or you will lock yourself out. This is
what you asked for when you signed in on the second phone.

**6. Open the app on the phone with the $0 sides**, let it sync, then re-price
Marco's job. The four fixes are in 1.845; the phone still holds the scrubbed
catalog until it pulls.

**7. r42 / E2, the sandbox product key.** I found a real defect in it before it
was applied — the flag would have been writable by the company it describes —
fixed it in the file, and all twenty of its proof rows now read true rolled
back. Still yours to apply.

**8. Three more migrations were never applied:** `r20_seed_new_company_catalog`
(which is why new companies have empty catalogs), `r53_more_than_one_crew_on_a_job`,
and `crew_job_scope`. Each waiting on a decision, none urgent.

**9. One formula question, and it is the only one I would not guess at.** The
drawing measures by the grid's extent and the pricing measures by a flat 20.
They agree at 400 ft and nowhere else. Nothing is wrong today because no job
can reach the bad state, and that is now guarded and measured — but closing
the split properly is a change to both sides of a parity contract that would
reprice every uncalibrated job you have. Your call, not mine.

**10. Two things I left alone on purpose:** the markup for a blank company
(office 15%, phone 0%) because you told me not to pin it, and `anon` holding
table-level INSERT/UPDATE on `companies` — harmless today only because RLS
denies it, which is one layer rather than two. Narrowing a role's privileges is
yours.

---

---

## NEEDS YOUR WORD BEFORE IT GOES OUT: the office will now refuse to send
## some quotes it used to send

Committed, NOT pushed. It makes a gate stricter, and a stricter gate while you
are asleep could stop you sending a quote in the morning.

Two predicates decide whether a catalog row still carries a price nobody here
has checked:

| source_doc | office, before | phone |
|---|---|---|
| `Starting price — verify with your supplier` | flagged | flagged |
| `Placeholder — verify with your supplier` | flagged | flagged |
| `Imported — verify before quoting` | **not flagged** | flagged |
| `Imported — check this one` | **not flagged** | flagged |

The office tested two labels; the phone tests four. Both of the missing ones are
written by **FenceFlow's own importers** — the second by the price-list importer
in `dashboard.html` itself.

It matters because that predicate feeds the office's **send gate**, whose own
comment is: *"The phone refuses to send a quote priced off catalog rows nobody
has checked. The office did not, so the same job could be sent from a desk with
the guard skipped — a gate on one door only."* So the gate written to close that
door was still open for both import labels — and the catalog table showed such a
row as clean while the phone warned about it.

**One row on your database carries `Imported — verify before quoting` today.**

The office's comment also claimed the two rules were the same ("so the phone and
the office cannot disagree about which rows are checked") and justified the
narrowness by calling anything else "a company's own wording". Both halves were
untrue.

Fixed to match the phone exactly, with the labels read out of `SeedData.kt`
rather than retyped — they carry an em dash, and a hand-typed one matches
nothing. `tests/a86-unverified-price-one-rule.test.mjs` re-reads both files and
compares every label and near miss, with a canary proving the old rule
disagreed. `a25` had already pinned this gap as known; that pin now records it
as closed.

**And the remedy is built, in the same commit batch.** There is now a
**"Price confirmed"** box in the office catalog editor, so a flagged row can be
cleared from the web instead of only from the phone. That was `a25`'s last
honest todo, and it was the blocking half of the change above: a stricter
refusal whose only remedy lived on another device is half a fix.

The rule is the phone's, ported rather than reinvented — which matters more here
than usual, because the bug above *was* these two halves disagreeing about this
exact column:

* ticking the box stamps `Confirmed`;
* leaving it alone keeps the flag, so editing a name does **not** quietly
  confirm a price;
* a row carrying a real invoice reference (`FloriFence Invoice 36499…`) keeps it
  while its price is unchanged — that reference is the only record of where the
  price came from, and "Confirmed" would destroy it;
* a **changed** price no longer matches that reference, so it is stamped;
* unticking does not un-confirm. The phone has no way back to unverified and the
  office does not invent one.
* the box only appears for a row that is flagged now, because that is the only
  state where ticking it does anything.

`tests/a87-confirm-a-price-from-the-web.test.mjs` runs both rules over every
branch and fails if they diverge, with three plausible wrong rules as canaries
(stamp-on-every-save, stamp-over-an-invoice-reference, let-unticking-revert) —
each of which must disagree with the phone, or the comparison proves nothing.
Removing the feature from the page turns the file red; I checked.

**a25 now has zero todos**, down from two at the start of the night.

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

## r42 (item E2) had a real defect, found before you applied it

I ran the whole file against the live database inside a **rolled-back**
transaction and read its own twenty proof rows. Nineteen were as intended. The
twentieth was not, and it is the one that matters:

```
is_sandbox is NOT writable by a client, which is the point of it   ->  false
```

**Why.** `public.companies` has 34 columns and **two table-level UPDATE
grants**, to `authenticated` and to `anon`:

```
total columns                34
updatable by authenticated   34
table-level update grants     2
```

A table-level grant extends to every column added later, so
`add column is_sandbox` would have handed write access to it immediately.

**Who could actually have written it.** Not `anon` — RLS denies them, because
both UPDATE policies need an identity (`is_platform_admin()`, or
`id = current_company_id() AND current_user_role() = 'OWNER'`). But that second
policy lets an **owner update their own company row** — so a live company could
have declared *itself* a sandbox. For a flag whose entire purpose is a sandbox a
company cannot set for itself, that is the hole, and r42's own check caught it.

Nothing reads the flag yet — r42 says so, deliberately, "rather than implying a
containment that is not there" — so there was no live exposure. It would have
become one the first time anything read it to suppress real mail or payments.

**Fixed in the file, not applied.** The table-level INSERT/UPDATE are replaced
by per-column grants over every column except `is_sandbox`, generated from the
catalog rather than typed out — a hand-written list of 33 column names is a list
that will be missing one, and the failure mode is the office silently unable to
save a field. The re-grant asserts both halves itself: `is_sandbox` unwritable,
and `companies.name` still updatable so the office can still save. **All twenty
proof rows now read true**, re-run against live and rolled back.

This also exposed an asymmetry worth knowing: `SELECT` on `companies` is
per-column, `UPDATE` was table-level. The per-column SELECT already bit this
project once in the other direction — a new column arrived ungranted and took
every company email down. After this, both behave the same way.

**One thing I deliberately did not change:** `anon` keeps exactly the
privileges it has now. That `anon` holds INSERT/UPDATE on `companies` at all is
a fair question — it is harmless today only because RLS denies it, which is one
layer rather than two — but narrowing a role's privileges is yours to decide,
not something to slip into someone else's migration overnight.

---

## The grid size and the price disagree, except at 400 ft

Your list carries this one as still open: "Office and phone measure an
uncalibrated job differently -- the office assumes 20 px/ft and never reads the
grid size, so they agree only at 400 ft. Unreachable today, but the new grid
sizes raise the possible error from 5x to 25x."

**Half of it is already fixed.** The office page used to hardcode 20 in four
places; `jobDrawingScale()` reads the grid extent now, and nothing on that page
hardcodes 20 any more. The satellite tool was the reason it mattered — it does
not merely display at a scale, it *writes* the points it saves in one, so a
trace added to a job drawn at 100 ft was stored at a quarter of its real length
and priced at a quarter.

**The other half is real, deliberate, and now measured.** Four pieces of code
resolve a drawing's scale, and they split two against two:

| | rule |
|---|---|
| phone drawing screen (`DrawingScale.of`) | extent-aware: 8000 / extent |
| office page (`jobDrawingScale`) | extent-aware: 8000 / extent |
| phone engine (`footageOf`'s fallback) | flat 20 |
| server pricing (`load.ts`) | flat `calibration ?? 20` |

Points are stored in canvas units, so drawing at `8000/extent` and pricing at
20 bills a fence at `real feet x 400 / extent`. Measured against the nine grid
sizes you can actually pick:

```
   25 ft grid  ->  16x     a fence billed SIXTEEN TIMES its length
  400 ft grid  ->   1x     the one size where the two rules coincide
10000 ft grid  ->  1/25    billed at four per cent of its length
```

Your "5x to 25x" is exactly right, and it is the undercharging direction — the
old top grid size of 2000 ft gave 1/5, and 10000 ft gives 1/25. What the note
does not say is that the *other* direction is worse for you: the 25 ft grid
overcharges by 16x, and an overcharged customer is a phone call you cannot
win.

**Why nothing is wrong today.** The split only bites a job with a non-default
grid extent AND no stored calibration, and that job cannot exist. The phone's
`setGridExtent` writes `calibrationPixelsPerFoot` whenever it changes the
scale, and — the part that is invisible and easy to break — **the office never
writes `grid_extent_ft` at all.** It reads the column and offers no control for
it. So a non-default extent can only come from the phone, which always sets a
calibration beside it.

That is a guard made of an absence, which is the kind that disappears without
anyone noticing. The day the office gains a grid-size picker, or `load.ts`
starts reading the extent without the engine following, the server prices a
fence at up to sixteen times its length with every existing test green.

`tests/a91-one-scale-for-pricing.test.mjs` pins all of it: that the two engines
still share one fallback, that 400 ft is the only size where the rules agree
(derived from the constants, not typed in), the divergence factor at each of
the nine sizes, that a calibrated job cannot diverge at all, that the office
still does not write the extent, and that the satellite save still refuses when
there is no scale. Every number is read out of `DrawingScale.kt`,
`SurveyViewModel.kt` and `load.ts` rather than written into the test, so
changing a constant moves the test with it. I planted a `grid_extent_ft` writer
in the office page and watched the guard go red before putting it back.

**I did not close the split**, and I would not without your word: making the
engine extent-aware is a formula change on both sides of a parity contract,
and it would reprice every uncalibrated job in the database. The guard plus the
measurement is the honest position until you decide.

---

## Two entries on your list are already done

While picking tonight's work I checked two of the "Still open" entries and both
have been fixed since the list was written on 25 September:

* **"Office and phone measure an uncalibrated job differently"** — the office
  half is fixed, as above. The remaining split is now guarded and measured.
* **"A false comment in PricingAdapters.kt -- the same lie four deleted parity
  cases were removed for"** — fixed. That comment now says the opposite, in
  detail: "THIS HARNESS CANNOT REACH THAT CASE, and not by oversight... do not
  read a green fixture as covering it", and names where the coverage really
  lives (`PhotoScaleTest.kt` and `tests/a17-photo-uncalibrated-pricing.test.mjs`).
  The four cases were removed on 29 September, four days after your list.

Both are struck from `OWNER_LIST_2026-09-25.md` with a note saying when and
why, rather than deleted — a list that quietly loses entries is worse than one
with stale ones.

---

## A4 (audit every money calculation): the arithmetic is covered, two
## guards were not

A4 asks for every money calculation in the app and the office to be audited and
proved. I went at it from the outside rather than re-reading the engines,
because the night's expensive bugs were all one shape: a fact written down in
two halves with nothing comparing them.

**The shared numbers are clean, and already guarded.** I swept every numeric
constant in all four halves — the phone's Kotlin, the office page, quote-view
and quote.html — and matched them across halves. Four looked like drift and all
four were my own matching being sloppy: the phone deliberately records
quote-view's ceilings *beside* its own lower limits
(`SERVER_MAX_WIRE_CHARS = 1500` against its own `MAX_WIRE_CHARS = 1000`), with
the comment "Nothing here may exceed them". `a38` and `a68` already compare both
against quote-view's real source, `a88` pins overtime, and the downstream
suites pin deposit, balance, posts, concrete, waste, tax and job costing. So
the arithmetic is not where the risk was.

**Where it was: of the office's 49 money-bearing functions, ten are named by no
test at all.** I read the four that touch money a customer pays.
`repriceAtOffice` turned out safe to leave — it does no arithmetic, it asks the
server's `price-job` and shows you the answer. But one of the ten charges a
card.

### `offerCardCharge` — the one place the office takes money with nobody present

It is careful code. It refuses without `card_consent_at` and a card on file,
refuses without `REQUEST_PAYMENT` *and* an OWNER/MANAGER role, mints an
idempotency key per button press so a double-tap is one charge, and — the
subtle one — returns "handled" after `charge_unrecorded` so the office does
**not** answer a maybe-charged card by charging it again.

Every one of those is a line someone could delete in a hurry with no test going
red. `tests/a90-charge-a-saved-card.test.mjs` now runs the real function out of
the page against stubs — not a grep of its source, because a comment mentioning
consent and an `if` enforcing it look identical to grep. 47 checks: the
refusals, the amount in cents to the cent, the word the customer sees matching
what is collected, and a positive control proving an owner who may bill still
can (without it, every refusal check would pass on a function that refuses
everybody, which is how a money door gets quietly welded shut). Four canaries,
each watched failing: delete the consent gate and a card with no agreement is
charged; delete the permission gate and CREW reaches the charge; send dollars
where cents are expected and $1,000 bills as $10; drop the
`charge_unrecorded` branch and the customer gets asked twice.

### A guard that had quietly stopped guarding

`tests/a110-office-next-request.test.mjs` proves the office asks a customer for
the same figure the phone would, across twelve shapes of job. It compares the
office against a hand transcription of `JobMoney.kt` — **and it never opened
JobMoney.kt.** So what it actually proved was "the office agrees with what the
phone's rule said when somebody last typed it out here". Change
`nextRequestAmount` on the phone and all thirty checks stay green while the two
halves diverge.

That figure is what `offerCardCharge` bills to a saved card, and this rule has
already moved once: on 2 October the phone offered to bill $4,154.47 while the
customer's own page asked for $2,500.00 — both deliberate, both tested, side by
side on screen.

Its four siblings all guard against exactly this (`a4-deposit`, `a47`, `a66`
and `downstream-deposit-balance` each fingerprint `JobMoney.kt` so a change
fails the test and forces a re-read). a110 was the only one that did not. It
does now. Before pinning it I re-read all six transcribed helpers against the
live Kotlin function by function — `netPaid`, `stillOwed`, `depositAsked`,
`depositStillDue`, `nextRequestAmount`, `nextRequestLabel`, and the cents
rounding against `EstimateEngine.roundToCents` — so what is pinned is a correct
copy and not a stale one made permanent. Then I changed JobMoney.kt and watched
the new guard fail before restoring it.

**Still uncovered, and not urgent:** the other nine of those ten office
functions (`addJobCost`, `jobBalanceMailCompose`, `renderCosting`,
`tierNeedsRates`, `bizMoneyShort`, and four that only measure feet). None of
them computes a figure a customer is charged; they display or compose. Worth
tests eventually, not worth holding A4 open for.

---

## Two things come OFF the suspect list, and the deposit finding got stronger

Re-running the corrected audit changed the list I gave you:

**`protect_customer_identity` is live after all.** This is the trigger that
stops a crew phone's whole-row push from overwriting the office's corrected
customer name, address and phone with a stale copy — it keeps the office's
version of those columns rather than refusing the write, because crew genuinely
need to write to jobs. It is applied, as `00_protect_customer_identity` on
`public.jobs`, and nothing needs doing. I had it on my own list of
"unexamined candidates that sound like guards"; it was my audit, not your
database.

**`supabase_r16_test_fixture_inventory.sql` is not a gap either.** Its three
missing `%fixture%` functions are missing *by design*: the file's own header
says `STATUS: NOT APPLIED`, its whole body is one transaction ending in
`ROLLBACK`, and it states that which blocks to run "is the owner's decision".
It is an inventory with proposals attached, not a migration that failed to
land. Nothing to apply unless you want those containment functions.

**The deposit trigger is still genuinely missing, and now I can say that
without relying on a name.** Rather than trusting the spelling in the file, I
asked the live database for every trigger whose name contains `deposit` or
`zz`, under any name at all. The answer is none, while the function
`deposit_follows_price()` is live. So the money rule you decided on 24
September has still never fired once, and that finding survives the same
scepticism that cleared the other two. It remains the first item on this list.

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

**CORRECTION — I told you something untrue earlier tonight.** I passed on a
publish-gate finding that "there is no overtime concept anywhere in the app;
`CrewPay` pays hours × rate with no weekly threshold". I relayed it without
checking it. It is false, and checking took five minutes:

| | threshold | multiplier | applied? |
|---|---|---|---|
| Phone (`CrewPay.kt`) | `AFTER_HOURS = 40.0` | `MULTIPLIER = 1.5` | yes — `regular * weightedRate + overtime * weightedRate * multiplier` |
| Office (`dashboard.html`) | `OT_AFTER_HOURS = 40` | `OT_MULTIPLIER = 1.5` | yes |

Both read the same `company_settings` keys (`ot_after_hours` /
`ot_multiplier`) with the same disclosed federal default, and `CrewPay.kt`'s own
header says it mirrors the office's constants. **The two halves agree.** Pay is
not the odd one out.

What is actually missing is a *field*: nothing on either screen edits those
keys, so they only change if somebody writes the row directly.

**Where the false claim came from**, which is the part worth keeping: a stale
comment in `dashboard.html`, three lines above the constants, denied that
overtime was a setting at all. The gate read the comment rather than the code
twenty lines below it. The comment is corrected, and
`tests/a88-overtime-one-rule.test.mjs` now holds the two halves to one rule —
because the real risk was never the reported bug, it was that `40` and `1.5`
are written down in two files and nothing compared them. That is the shape of
both of the night's expensive bugs: the business name in two stores, and the
unverified-price rule in two predicates.

The lesson is mine, not the gate's: a finding handed to me is a claim to test,
not a result to forward.

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

* **My migration audit called a live guard missing.** The audit is the tool
  that decides which of the 346 migration files get put in front of you as
  "never applied", so an error in it is an error in everything it told you. It
  compared the name in the file -- `create trigger protect_customer_identity`
  -- against the live trigger list by exact match. The applied trigger is named
  **`00_protect_customer_identity`**: triggers fire in alphabetical order, so
  the guards were deliberately prefixed. The guard exists and does its job.

  This matters more than one wrong line, because of *where* the blind spot sat.
  Seventeen live triggers carry such a prefix, and they are almost all the
  money and identity guards: `00_hold_line_item_prices`,
  `00_protect_job_money`, `00_hold_quote_gate`, `00_hold_material_price`,
  `00_hold_contract_columns`, `10_reapproval_resolve`,
  `90_mark_change_orders_accepted`. An audit whose false alarms land exactly on
  the guards spends your attention on nothing, and makes the next true finding
  read like the last false one.

  Fixed narrowly, and the narrowness is the point: a live name matches only
  when stripping a leading digits-and-underscore run leaves the declared name
  **exactly**. A loose suffix match would have let `push` count
  `job-change-push` as present and *hidden* a real absence, which is far worse
  than crying wolf. The script now refuses to report at all if the match ever
  becomes loose enough to count `customer_identity` as live, and
  `tests/a89-audit-reads-prefixed-triggers.test.mjs` runs the shipped code
  against both cases — I watched the canary fire on the loose version before
  trusting it on the correct one.


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

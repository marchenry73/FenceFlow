# Overnight plan, 1-2 October 2026

He went to sleep and asked for: a full bug hunt, things that appear and disappear,
calculations that are wrong, deposits that disagree between surfaces, the grid made to work
flawlessly and judged against how a fence is actually planned, the 6 ft and 4 ft materials
arithmetic, the fence connection becoming a CORNER post rather than two end posts, and a sweep
of the whole day for anything missed.

This file is the ledger. Everything below is either DONE, RUNNING, or OPEN, and nothing is
marked done unless it was verified rather than written.

## The rules that do not relax because he is asleep

- APPLY NO SQL to his live database without his word. Read-only probes are fine.
- DEPLOY NOTHING and PUSH NOTHING that he has not seen, EXCEPT the build and publish he
  explicitly asked for tonight.
- NEVER email a real person. Real customers and two real suppliers are in that database.
- No invented prices. A made-up figure that looks researched is worse than a gap, because he
  will quote it.
- Crew never see money. Never weaken RLS, plan gates, quote security, the payment ledger,
  signatures, offline sync.

## DONE today, verified

- Deposit trigger dropped: deposits stop being rescaled behind his back on every re-price.
- Supplier prices loaded, 32 rows, verified twice against the supplier PDFs with a control.
- Post heights set; a 6 ft fence stops being given a 4 ft fence's post (6 ft long, nothing in
  the ground).
- Gate posts billed as gate posts; 10 priced rows that nothing could reach.
- Blank post on a wall gate now billed (+$17.72 on his vinyl) -- never charged before.
- Wall gate latch post corrected back to END_POST, on his own instruction.
- Deposit warning fixed: $3,000 no longer "does not cover" $2,828.48.
- Junk catalog rows removed (raw PDF text imported as item names).
- Catalog editor gained a height field; supplier and price now on every row.
- Satellite: three zoom caps found and fixed, now 2.6 in/pixel.
- Payment methods on the customer link, and in the copy she downloads.
- Approval email: sends, and a failure cannot break the approval.
- Seed tax bug: four panel rows shipped untaxed to every new client.

## RUNNING when he went to sleep

- Build 574 -> Drive -> publish. CORRECTION, 02:00: this line was WRONG. The APK on Drive has the Attach tool compiled out (JOIN_STORAGE_READY is false in the source it was built from). 574 carries the post, gate-post, wall-gate and deposit fixes. It does NOT let him attach two sides.
- Gate hardware by fence type: whether a chain-link gate should be asking for a vinyl econo
  stiffener at all.

## THE OVERNIGHT QUEUE, in the order it matters to him

1. **The corner post.** The join arithmetic exists and is tested; nothing calls it. Two sides
   joined still bill two end posts. This is his oldest open complaint and the one he repeated
   most. WIRE IT TO THE PRICE.
2. **The grid, judged against how a fence is actually planned.** Not a code review -- an
   adversarial walk of what a contractor does in a yard, looking for anything that appears,
   disappears, or quietly changes a number.
3. **Calculations that disagree between surfaces.** App, office, customer link, contract PDF,
   approval email. Any figure that can differ is a figure that will.
4. **The deposit, everywhere.** It has been wrong in three different ways in one day.
5. **6 ft and 4 ft materials arithmetic**, against the suppliers' own quotes.
6. **The sweep of the whole day** -- everything in FIELD_FEEDBACK_2026-10-01.md that is still
   open, and anything said in passing that never got written down.

## STILL OPEN from the day, carried forward

- Nine of eleven jobs hold NO priced line items on the server, including an accepted $19,810
  job and a completed one. Biggest unexplained thing on the list.
- Hinge sets are chosen by price alone and nothing records a hinge's rating. An under-rated
  hinge on a 6 ft gate is a gate that comes off. Needs a catalog field, not an engine change.
- GATE_FRAME_KIT is chosen by width then cheapest and never reads height -- the same bug as
  panels had, still live for wood, chain link, split rail and composite.
- WOOD_PICKET length IS the fence height, and a wood run has no panel to pin it.
- The importer can still write junk into the live catalog from a PDF.
- a38-quote-pay-section asserts the opposite of what he asked for and passes for the wrong
  reason (its scan is broken by line endings and reads to end of file).
- Payment limits per method; payment methods on the phone.
- The deposit purpose sentence ("reserves your place on the schedule and pays for materials").
- House rectangle on the grid; the 6-to-4 diagonal in the 3D quote; the pull sheet.
- Stripe is in test mode: nothing takes real money yet. His call, not a bug.

---

# THE SWEEP OF THE WHOLE DAY

Every request he made today, read back through the conversation. DONE means verified, not
written. Nothing is marked done on a wave's say-so alone.

## DONE and verified

| What he asked | State |
|---|---|
| App crashed on open | Cause found (built across two commits mid-build); rebuilt clean |
| Check-update button gone | The file in Drive WAS the no-update build; two variants now |
| Satellite not clear / like Google Earth | Three zoom caps all at 20, one refusing z21 at the door; now 2.6 in/px |
| Exact total, no round-up to $10 | Both engines |
| Deposit: round to next 100, +100, undisclosed | Both engines, shared vectors |
| Know when I am signed out | Three states; also closed a path where an empty reply could wipe the phone |
| Use Grid must stick | Keeps the photo, remembers the choice per job |
| Crew able to capture a quote | Capture-only, granted per person, no money on the phone |
| Seed tax bug | Four panel rows shipped untaxed to every new client |
| Signing key backup | On Drive with its SHA-256 and a recovery note |
| Suppliers + their prices in the app | Flori + Hartford, 32 rows, verified twice against the PDFs |
| 4 ft materials list and quote | $4,775.26, and my estimate was $908 LOW -- 4 ft costs MORE |
| Payment options on the customer link | Cash App, Zelle, wire, cash; only what he fills in |
| Payment methods in the downloaded copy | Plain text, no dead buttons |
| Email the contract on approval | Sends; a failure cannot break the approval |
| Cancellation clause in the contract | All three languages, no invented numbers |
| Junk rows in the catalog | 3 removed (raw PDF text as item names) |
| Deposit rescaled behind his back | Trigger dropped |
| 6 ft fence given a 4 ft post | Fixed; posts now matched to fence height |
| Gate posts never billed as gate posts | Fixed; 10 priced rows were dead |
| Wall gate's blank post never billed | Fixed, +$17.72 a gate |
| Wall gate latch post is an END post | His correction, applied to both engines |
| Deposit said 3000 does not cover 2828 | Fixed; condition and message now use one value |
| Height field in the catalog editor | Phone and office, with supplier and price per row |
| Join columns + re-approval fingerprint | Applied to the server tonight |

## RUNNING tonight

- Corner post wired to the price (so a join stops billing a post that is not there)
- Gate hardware per fence type (should a chain-link gate want a vinyl stiffener?)
- Grid audit: 4 hunts, every finding then attacked by a skeptic
- Money audit: every figure across phone, office, link, PDF, email; plus 6ft/4ft materials

## NOT DONE -- carried to the morning, with why

**Needs his decision**
- Stripe is in TEST MODE. Nothing takes real money. Everything else about payment is built.
- Hinge sets are chosen by price alone and nothing records a hinge's RATING. An under-rated
  hinge on a 6 ft gate is a gate that comes off its posts. Needs a catalog field.
- Payment LIMITS per method: his deposits exceed personal Zelle and Cash App caps, and the cap
  is set by HER bank. A field he fills in, not a number I invent.
- Whether to show the customer what the deposit is FOR ("reserves your place on the schedule
  and pays for the materials, the balance covers the labour"). Written up, not built.

**Known bugs, not yet fixed**
- Nine of eleven jobs hold NO priced line items on the server, including an ACCEPTED $19,810
  job and a completed one. Biggest unexplained thing on the project.
- GATE_FRAME_KIT chosen by width then cheapest, height never read -- the same bug panels had,
  still live for wood, chain link, split rail and composite.
- WOOD_PICKET length IS the fence height and a wood run has no panel to pin it.
- BRACE, HANDLE and STIFFENER are seeded VINYL-ONLY, so a wood or chain-link gate silently
  drops three hardware lines on a fresh catalog. (A wave is deciding this now.)
- The old importer's label "Imported - check this one" is not one isPlaceholderPrice
  recognises, so those prices skip the unverified-price warning.
- The price-list importer can still write junk into the live catalog from a PDF.
- a38-quote-pay-section asserts the OPPOSITE of what he asked for and passes anyway, because
  its scan is broken by line endings and reads to the end of the file. A guard that passes
  while the thing it guards against happens.
- Office dashboard still caps satellite at zoom 20, so the office sees worse imagery than his
  customers now do.

**Asked for, specced, not built**
- The house as a draggable, rotatable rectangle on the grid.
- The 6-to-4 diagonal drawn on the customer's 3D quote.
- The pull sheet for whoever collects materials (crew-visible, quantities only, no prices).
- A dropdown when he picks 4 ft -- which is really "which 4 ft product", since his suppliers'
  4 ft lines are different products at different prices.
- Payment methods editable on the PHONE as well as the office.
- Per-side pricing, so a neighbour can split one side's cost.
- Customer able to UNAPPROVE a quote.
- PDF upload into the price-list importer (reads the three real PDFs; stopped to protect a build).
- Mid-run gate placement, and showing on the grid what a gate did to the materials.

---

## Gate hardware by fence type -- LANDED

The question was whether the SEED under-provides or the TAKEOFF over-asks. Answer: both, for
different roles, and deciding per role is what made it right.

- **STIFFENER: vinyl only.** Vinyl gates arrive as a hollow extruded leaf that racks, and both
  suppliers quote a 5 inch econo stiffener that fits a 5x5 vinyl post and nothing else. Chain
  link is a welded tube frame. Aluminium and iron arrive as welded factory panels. Wood, split
  rail and composite are built on a GATE_FRAME_KIT the takeoff already asks for -- and the
  seeded wood kit is "Steel-Reinforced", which IS the member keeping the leaf square.
- **BRACE: vinyl only**, and the seeded row IS a vinyl part: a bevelled white 8 ft extrusion.
  A wood gate does need bracing -- which is exactly why BRACE is not asked for there, because
  its bracing comes in the frame kit and asking twice bills the same function twice.
- **HANDLE: all seven.** The one genuinely mis-filed row. A 7 inch stainless pull bolts through
  any leaf. Moved from vinylItems() to universalItems() in all three catalog copies.

**His price does not move by a cent on any job.** Proven rather than argued: all 11 live jobs
priced through this tree and through a copy with only the takeoff edits undone, comparing the
WHOLE engine output. 11 of 11 byte-identical.

**One thing for him in the morning, and it is his data not the seed's:** his own three HANDLE
rows are filed VINYL. The seed never rewrites an existing catalog, so if he ever quotes a
wood or chain-link gate, he still gets no handle -- it shows as an unmatched role. One row
re-filed UNIVERSAL fixes it. NOT done without his word: changing a row's fence type changes
which jobs can reach it, and he is asleep.

A new company's first non-vinyl gated quote goes UP by exactly one $5.00 handle plus their tax.

---

# 02:00 -- two more waves landed. Read THIS section first.

## 1. The biggest unexplained thing is explained, and it is not a missing feature

"Nine of eleven jobs hold no priced line items" was the wrong description. **The lines
exist. They were soft-deleted.** 64 line items across 6 jobs, deleted between
21:26:40 and 21:26:59 UTC on 1 Oct -- **19 seconds, 5:26 pm your time** -- with
`deleted_by` blank. In the 32 seconds after, an authenticated actor changed
`deposit_amount` on 5 jobs and `unit_price` on 5 line items.

None of the day's SQL touches `estimate_line_items` (a44, a45, a47, a52 all grepped).
So this was **an app or office session, not a script.** Read-only queries, positive
controls, no customer names read.

The deletes are SOFT, so they are reversible. **Nothing was restored.** Restoring is
not obviously right on an accepted job, and that is your call, not mine.

**Do not re-run Suggest on those jobs until you know what you were doing at 5:26 pm.**
If that was you clearing out a bad price, the data is correct and the "bug" is only the
way it reads. If it was not you, something deletes priced lines in bursts.

## 2. The corner post is wired to the price, on BOTH engines

The arithmetic existed and was tested all along; nothing called it. Now both call it.

Your 198 ft job, three sides, priced through the real engine on your own catalog:

| | Three separate sides | Joined at two corners |
|---|---|---|
| Posts | 30 line + 0 corner + 6 end + 2 gate = **38** | 30 line + 2 corner + 2 end + 2 gate = **36** |
| Caps | 38 | 36 |
| Concrete | 39 bags | 37 bags |
| **Grand total** | **$4,595.26** | **$4,548.07** |

Two posts, two caps, two bags: **$47.19 off.** Footage, panels, labour and the gate's
two posts do not move at all -- which is the proof it only took away the post that is
not there.

It also changes the ROW, not just the count: END_POST falls by 2 and CORNER_POST rises
by 1. On your catalog both are $16.56 today so the money is in the count -- but the day
you price a corner post differently, it is already right.

Chain link gets it too (one fewer terminal post means fewer tension bands, brace bands
and rail ends). Ten bad-input cases each price exactly as if the joint were blank, and
always toward the dearer answer.

## 3. The flags, honestly

The server columns are live. The engines both price a join. **The phone's Attach tool
is still hidden** (`JOIN_STORAGE_READY = false`) and the phone still strips the joint
on push (`EntitySync.JOIN_COLUMNS_LIVE = false`). Those two want ONE build to flip
together, and I did not have the allowance to build and verify it -- an unverified flip
is how you get a tool that attaches on the phone and prices on the office only.

So: **joining is built and priced, not yet reachable.** One build turns it on.

## 4. The grid audit: 67 findings, 20 survived the skeptics

Worst five, all money or data:

1. **"Next: Draw This Fence" opens the job's FIRST run, not the one you came from.**
   Runs made with "+" on the drawing screen all get sortOrder 0, so they sort by random
   UUID and reshuffle. You name side 2, tap through, and your corners land on side 1 --
   wrong footage, wrong materials, and side 1's fence looks like it moved.
2. **A NaN or Infinity in a gate width or a point makes the office commit DELETE the
   panel, line-post, cap and concrete lines and null the contract total.** The gate
   width dialog accepts zero, negative, NaN and Infinity.
3. **A stored calibration of zero or below prices the whole fence at $0** and the send
   button is not blocked.
4. **Clearing the panel-width box wipes panels and line posts out of a vinyl quote,**
   and every keystroke is saved as you type.
5. **A change order's feet are priced twice in the live total and once in the price
   that stands.** Two numbers, one of them wrong, both on screen.

Plus: the "N ft total" headline is the ACTIVE run only and vanishes whenever the
selected run has fewer than two points -- so adding a side makes your footage appear to
go 180 -> blank -> 40. It also counts the teardown run and ignores typed lengths, so
the grid's job total legitimately disagrees with the estimate. That is your
"footage changes when I add a side", and it is labelling, not arithmetic.

A closed perimeter on a two-point run measures the line twice, **and it is on a signed
job.** Closing a fence by tapping the start point again bills two END posts at one spot.

Full detail, all 20, with file and line:
`C:\Users\march\AppData\Local\Temp\claude\C--Users-march-OneDrive-Desktop-Claude\1efd664f-6d97-4c6b-86ea-0ee58b04bfdb\tasks\wqcnwc8yt.output`

## 5. What is left, in order

1. **One build.** Flip the two phone join flags together, regenerate fixtures
   (engine 2026.10.8, manifest still 2026.10.6), build, verify from the artifact,
   Drive, publish. Nothing to decide; about an hour of machine time.
2. Fix the run-selection bug (item 4.1). It is cheap -- pass the run id and give
   drawing-screen runs max+1 -- and it is the one that puts a fence on the wrong side.
3. Guard the money inputs (4.2, 4.3, 4.4). Reject non-finite and non-positive before
   they reach a commit.
4. The 5:26 pm delete burst. Your answer, then act.

---

# 03:00 -- CORRECTION. The 5:26 pm deletion was not you. It was the app.

Two hours ago this file told you to work out what you were doing at 5:26 pm.
**Ignore that.** You did nothing. The app deleted its own priced lines, and I can
now show the mechanism and the fingerprint.

## The fingerprint, read live with controls

| Probe | Answer |
|---|---|
| Rows tombstoned in that one minute | **64** |
| Distinct deleters | 1 |
| That deleter, verbatim | **the empty string** |
| Every other deleter in the table (56 rows) | `marchenry73@gmail.com` |
| Roles deleted | PANEL, LINE_POST, POST_CAP, CONCRETE_BAG, END_POST, CORNER_POST, GATE_PANEL, HINGE_SET, LATCH, HANDLE, BRACE, STIFFENER, HOLE_PLUG, TRIM |
| Rows with role NONE (your hand-typed extras) | **0 deleted** |
| Rows that named a fence run in the cloud | **64 of 64** |

Three things each rule you out on their own:

1. **Your deletes carry your email.** All 56 of them. These 64 carry an empty
   string, which only the PHONE writes (`EntitySync.kt:386`). The office and the
   website write your address.
2. **Not one hand-typed line was touched.** 64 role-bearing lines gone, every
   role-NONE line untouched. That is a `WHERE role != 'NONE'` clause, not a
   person tapping.
3. **64 rows across 6 jobs in 19 seconds.** Nobody taps that fast.

## The mechanism, confirmed in the source

`Daos.kt:288` -- `SELECT * FROM estimate_line_items WHERE fenceRunId IS NULL AND role != 'NONE'`

That is the reaper's whole definition of an orphan: **"my copy has no run."** And
`Repository.deleteOrphanedGeneratedLineItems` does not just delete locally -- it
queues a PendingDeletion, which kills the **cloud** row for every device and the
office.

Now the race. `EntitySync.kt:2474` and `:2480` launch `pullFenceRuns` and
`pullJobChildren` as **concurrent async blocks in the same pass.** No barrier, no
ordering. Inside `pullJobChildren`, a line the phone is seeing for the FIRST time
resolves its run as:

    fenceRunId = row.fenceRunSyncId?.let { runIdBySyncId[it] }

No fallback. If the runs have not landed yet, that is **null** -- and the line is
inserted as an orphan. The UPDATE path two lines below *does* have a fallback
(`?: existing.fenceRunId`), so a line already on the phone is safe. A line arriving
for the first time is not.

Next pass, the reaper kills it in the cloud.

All 64 cloud rows **did** name a fence run. The orphaning happened on a phone,
and the phone then deleted rows that were perfectly good on the server.

The file states the correct doctrine in its own comment, one screen above the bug:
*"a child whose job is not on this device yet is skipped rather than orphaned -- the
next pass picks it up once the job itself has come down."* That is applied to the
job. It is not applied to the run.

## What it cost you

Five jobs now hold a price computed from labour and gates only -- no materials:

| Job | You signed | Server says now | Short by |
|---|---|---|---|
| D | $15,540.00 | $5,853.81 | $9,686.19 |
| H | $35,240.00 | $13,266.87 | $21,973.13 |
| I | $870.00 | $200.00 | $670.00 |

**Those customers' links have been opened.** On D and H, `quote_viewed_at` is set.
The quote page would let her press Approve and record 38 percent of the agreed
price as the accepted price. On I it is 23 percent.

The deposit trigger -- the one dropped last night -- rescaled two deposits in the
same second, and those figures **still stand**: about $5,896.82 down to $2,158.45,
and about $22,157.13 down to $8,101.68.

It also explains two things you noticed: the office job sheet shows no deposit or
balance on 7 of 8 jobs (it only draws that block when lines exist), and the phone
refuses to send the estimate or invoice on five jobs saying the price moved and it
needs a new signature -- it is comparing your signed total against the collapsed one.

## What is being done about it right now

- The code path is being fixed and adversarially attacked: a line naming a run this
  phone does not have must be **skipped**, not orphaned, and a local absence must
  never be grounds to tombstone a cloud row.
- The restore is being **prepared, not applied.** The lines are soft-deleted, so
  they are recoverable. The dangerous part is not the restore -- it is whether a
  later Suggest pass already regenerated replacements, because restoring on top of
  those would DOUBLE the price. That is being proved per job before any SQL exists.
- The restore will also push three signed jobs' prices back UP, which can trip the
  re-approval fingerprint and ask a customer who already signed to sign again.
  **That is your decision, not mine.** It is written up in
  `docs/LINE_ITEM_LOSS_2026-10-01.md`.

## Also found, and it is why the office and the phone disagree

The deployed office `price-job` is **v12 from 5 September**, engine 2026.09.1. It
still rounds the total up to the next $10 (you had that removed), has no fence-height
rule, and has no wall-gate blank post. Press "re-price" in the office and you get a
different number from your phone on every single job -- $35,220.00 against
$36,196.21 on one of them.

And a real source bug underneath the staleness: `price-job/index.ts` **never selects
`height_ft`**. So even after a redeploy, the office would price a 4 ft fence exactly
like a 6 ft one -- the same height-blind bug that was fixed on the phone last night.
A test in the repo has been carrying that as a TODO. Being fixed in source now;
the deploy is yours to press.

---

# 04:00 -- three things I checked myself, because an audit can be wrong too

Two of the findings I passed on to you were wrong, and a third was pointing at
the wrong thing. All three read-only, with a control and a canary in every probe.

## REFUTED: "the catalog warning misses imported prices"

The claim was that the label "Imported — check this one" is not one the
unverified-price warning recognises, so those prices slip through.

`SeedData.kt:97` matches it explicitly: `sourceDoc.startsWith(IMPORTED_CHECK_FILING)`,
and line 68 defines that constant as exactly that string. And it does not matter
anyway, because your live catalog carries no such row:

| Your 123 live catalog rows say | Count | Warned? |
|---|---|---|
| Placeholder — verify with your supplier | 76 | yes |
| Confirmed | 32 | no, correctly |
| FloriFence Invoice 36499 / Estimate 17407 (real prices) | 14 | no, correctly |
| Imported — verify before quoting | 1 | yes |

Rows carrying the bare word "Imported": **zero.** Rows with a blank source and a
price: **zero.** The warning is doing its job.

## REFUTED: "a38-quote-pay-section asserts the opposite of what you asked"

It does not. It asserts the quote page must not tell your customer a card fee is
added, *because none is* -- `create-payment-link` hardcodes the fee to zero and
the 3%-capped formula has no caller. And its first assertion is a TRIPWIRE, not a
pin: the moment that stops being true the test fails and tells whoever broke it to
state the real figure. It also has its own has-teeth test, in three languages,
compared by key and never by display text. It is one of the better guards in the
repo.

**The real question underneath is a decision nobody has asked you:** Stripe
charges YOU a fee when a customer pays by card, and you are not passing it on.
If you want to, the formula already exists unused. If you do not, nothing needs
doing. Your call.

## SHARPENED: you are NOT quoting below cost -- but only because of what you sell

The claim was that cheapest-wins picks a starting-list guess that undercuts both
suppliers, putting your quote below Flori's own price. I tested it on your real
catalog. On vinyl it is **not happening**:

| Role | Cheapest row the engine would pick | Is it a guess? |
|---|---|---|
| LINE_POST | $13.18 | no, confirmed |
| PANEL | $52.35 | no, confirmed |

Those are the only two vinyl roles where you hold both a guess and a real price,
and in both the real price is already the cheaper one. Everything else in vinyl is
fully confirmed: corner post, end post, gate post, gate panel, hinge, latch, cap.

**Here is the finding that is real, and it is bigger.** Your 76 remaining guesses
are almost all fence types you do not quote yet:

    CHAIN_LINK 18   ALUMINUM 14   ORNAMENTAL_IRON 11
    COMPOSITE 10    WOOD 10       SPLIT_RAIL 8      VINYL 5

So vinyl is on real numbers and safe. But the day you quote a chain-link or an
aluminium fence, **every single price in it is FenceFlow's guess, not a supplier's.**
That is not a code bug and I will not invent prices to paper over it. It is one
phone call to each supplier per fence type, and the catalog editor now has the
height and supplier fields to hold the answers.

One small thing worth your eye: your cheapest confirmed vinyl panel is $52.35,
while Flori quoted $54.99 yesterday. If $52.35 is an old price you ticked as
confirmed, it is now low by $2.64 a panel -- about $90 on a 198 ft job.

---

# 05:00 -- READ THIS BEFORE YOU OPEN THE APP

Three of your customers can, with one tap, replace the price they agreed with a
much smaller one. Nothing has been lost yet. I traced it to the exact line.

## What is true right now

I numbered your eleven jobs by age. No names.

| Job | Live priced lines | Deleted lines | Server price | She signed | Anchor holds | Link opened | Flag |
|---|---|---|---|---|---|---|---|
| 2 | 0 | 14 | $19,810.00 | $19,810.00 | $19,810.00 | yes | agrees |
| 3 | 0 | 13 | $200.00 | $200.00 | $200.00 | yes | agrees |
| **4** | **0** | **20** | **$5,853.81** | **$15,540.00** | **$15,540.00** | **yes** | **RE-APPROVAL PENDING** |
| 5 | 0 | 14 | $700.00 | never signed | - | yes | draft |
| **8** | **0** | **14** | **$13,266.87** | **$35,240.00** | **$35,240.00** | **yes** | **RE-APPROVAL PENDING** |
| **9** | **0** | **10** | **$200.00** | **$870.00** | **$870.00** | no | **RE-APPROVAL PENDING** |
| 7 | 6 | 0 | **$0.00** | $7,740.00 | - | no | contract total is ZERO |
| 11 | 23 | 2 | $4,654.47 | never signed | - | yes | recovered |

**The good news first: the agreed prices are still safe.** `accepted_total` on jobs
4, 8 and 9 still holds $15,540, $35,240 and $870 -- the real figures. The
re-approval rule noticed the price moved and flagged all three. The system caught
it.

## The bad news, and it is one line of code

`supabase/functions/_shared/quote-deposit.ts:133`

    if (acceptedTotal == null || accepted <= 0.005 || acceptedAt <= 0
        || input.reapprovalRequiredAt) {
      return live;
    }

When re-approval is pending, the page deliberately shows the **new** price, because
the whole point of re-approval is that she must agree to the change. That is right
in general. It is wrong here, because the "new price" is the wreckage of the
deletion bug.

So her page today says:

- Job 4: she signed **$15,540**. Her page shows **$5,853.81** and asks her to
  re-approve. The fence is already BUILT -- that job is marked COMPLETED.
- Job 8: she signed **$35,240**. Her page shows **$13,266.87**.
- Job 9: she signed **$870**. Her page shows **$200.00**.

And `quote-view/index.ts:825`:

    write(canRecordAcceptance ? { ...approval, accepted_total: figures.total } : approval)

`canRecordAcceptance` is true, and all three rows still have `quote_approved_at`
NULL -- so the write would land. **One tap replaces the correct anchor with the
collapsed figure.** Two of those three links have already been opened.

It is recoverable if it happens: `signed_contract_total` keeps the real number in a
separate column. But she would have formally agreed to the wrong price, on a fence
that in one case is already in the ground.

## What you can do in the next five minutes

**The cheapest safe move is to stop the links working.** You own those links; you
can send a new one later. I have not touched them -- that is a write to your live
data and it is yours to make.

I cannot fix this tonight without either applying SQL or deploying a function, and
both of those are things you told me never to do without your word. So the guard is
being written into the source now -- a refusal to record an accepted price far below
a signed one -- and it will be waiting for you with the deploy command.

## Also, and it makes the "contract total is 0" finding real

Job 7 has `contract_total` of **$0.00** with a **$7,740** signature and 6 live
priced lines. Last night's audit called that case latent and said no real job had
it. It does. On that job the page prints one total and derives the balance and the
pay buttons from another, so it would show $7,740 and refuse to collect it.

---

# 05:40 -- I nearly told you to do the wrong thing. Here is the correction.

I had written a prepared fix whose recommended option was "clear the re-approval
flag on those three jobs" -- on the assumption the flag was raised BY the
deletion. **It was not.** I checked instead of assuming, and the flag is dated

    2026-09-28 16:50:37.805269

on all three, to the same microsecond. **Four days before the deletion.** And
`reapproval_reason` says what it was for:

| Job | Reason on file | Short by |
|---|---|---|
| 9 | sales tax worked out on part of the materials instead of all of them | **$20.31** |
| 4 | same | **$456.38** |
| 8 | same (third time asked) | **$1,045.53** |

That is the seed tax bug -- the four panel rows that shipped untaxed. The
re-approval was raised **correctly**, to get a **higher** figure agreed. Clearing
that flag would have cancelled a legitimate request to collect **$1,522.22** and
left you short, quietly.

**So the right order is the opposite of what I first wrote:**

1. **Restore the deleted line items first.** That makes the live price correct
   again, tax correction included.
2. The re-approval flag then does exactly what it was built for: it shows her the
   corrected higher figure and asks her to agree. **Nothing needs clearing.** The
   flag was never the problem -- the wrecked price behind it was.
3. Only if you want to close the window before step 1, kill the three links.
   That is a holding action, not a fix, and two of the three have already been
   opened so it needs a phone call.

`supabase_a70_protect_exposed_quote_links.sql` now says all of this at the top,
with the wrong option struck out and the reasoning left in place. Both writes are
still commented out, so running the file does nothing but print the current
state -- which I did, and the guard passes.

**The lesson, written down because it keeps happening:** a flag that looks like
damage can be the system working. I had a rule that was right in form and wrong
in its reason, and the only thing that caught it was reading the reason off the
live row instead of inferring it from the timestamp I expected.

---

# 06:20 -- it is not 64, and it did not start yesterday

I kept pulling on the thread. The 1 October burst was the biggest instance, not
the only one.

| Deleted by | Rows | When |
|---|---|---|
| **the empty string (the phone)** | **77** | 22, 23, 25 and 29 Aug, then 64 of them on 1 Oct |
| `marchenry73@gmail.com` (you, on purpose) | 15 | 11 Sep (13), 1 Oct (2) |
| anything else | **0** | - |

No nulls, no third value. So `deleted_by = ''` is an **exact** fingerprint: 77
rows the app destroyed, 15 you removed yourself. Nothing is ambiguous.

The 13 August ones came in seven separate passes, and three of them landed inside
three minutes on 29 August -- 13:47, 13:48, 13:49. That is the thrash the code's
own comments describe: the reaper deletes, the resurrection list brings the row
back, the reaper deletes it again. The comment in `Repository.kt` even says *"that
is why the stray items kept reappearing -- and why they multiplied, since every
device did this independently."* Whoever wrote that was looking straight at this
and treating it as a nuisance rather than as destruction.

**So the orphan reaper has been quietly eating your priced line items for six
weeks.** It explains the long-standing "most jobs have no priced lines" condition
far better than any one event.

## The restore is SAFE, and I can now say that with a number

The one real danger was duplication: if a later Suggest pass had regenerated
replacement lines, restoring on top of them would double the price. I checked
every dead line against every live one, matching on job, role and fence run:

**Dead lines already covered by a live line: ZERO.** Restoring cannot duplicate
anything on any job.

Current state, per job:

    job 2:  0 live, 14 dead      job 8:  0 live, 14 dead
    job 3:  0 live, 13 dead      job 9:  0 live, 10 dead
    job 4:  0 live, 20 dead      job 10: 0 live,  5 dead
    job 5:  0 live, 14 dead      job 11: 23 live, 2 dead
    job 7:  6 live,  0 dead

Job 11 is the one that recovered on the night: 23 live lines, 2 dead. Even there,
neither dead line overlaps a live one.

## The one thing the repair must get right

**Restore the 77, not all 92.** The other 15 carry your email -- you deleted those
on purpose and bringing them back would undo your own work. The discriminator is
`deleted_by = ''`, not the date, because the bug ran on seven different days.

That constraint is now written into the prepared repair, and I will check the
file the agent produced against these numbers rather than taking its word for it.

---

# 06:45 -- the deposit trigger took $17,793.82 off two jobs, and it still stands

From `audit_log`, read-only with a control and a canary. The deposit trigger
fired at 21:27:00, one second after the line items were destroyed, and rescaled
the deposits to match the wreckage:

| Job | Deposit before | Deposit after | You are not asking for |
|---|---|---|---|
| 4 | $5,896.82 | **$2,158.45** | **$3,738.37** |
| 8 | $22,157.13 | **$8,101.68** | **$14,055.45** |
| | | | **$17,793.82** |

**Both still stand.** I checked the stored rows, not just the audit trail:
job 4 holds $2,158.45 today and job 8 holds $8,101.68.

It also explains exactly what you complained about yesterday. On job 11 the
deposit went, in 33 minutes:

    1690.00 -> 588.93 -> 1383.33 -> 1638.08 -> 1640.73 -> 1673.13 -> 3000.00

That is the trigger rescaling it under you while you typed, which is why it
"did not update until I went to the home page of the job". The trigger is dropped
now, so that fight is over -- but the two leftover figures above are still wrong.

## Every deposit you hold today

| Job | Deposit | Price on the server | Paid |
|---|---|---|---|
| 1 | $0.00 | not priced | - |
| 2 | **$0.00** | $19,810.00 | - |
| 3 | $160.00 | $200.00 | - |
| 4 | **$2,158.45** (trigger leftover) | $5,853.81 | - |
| 5 | **$0.00** | $700.00 | - |
| 6 | $840.00 | $4,200.00 | - |
| 7 | $7,170.00 | **$0.00** | **$7,170.00** |
| 8 | **$8,101.68** (trigger leftover) | $13,266.87 | - |
| 9 | **$0.00** | $200.00 | - |
| 10 | **$0.00** | $400.00 | - |
| 11 | $3,000.00 | $4,654.47 | - |

Two things in there besides the trigger:

- **Five jobs ask for no deposit at all**, including the accepted $19,810 one.
  That is materials bought with your own money.
- **Job 7 is fully paid $7,170 against a contract total of $0.00.** She signed at
  $7,740, so on the real figure you are $570 short, and because the stored total
  is zero no surface can tell you that. This is the same job I flagged at 05:00.

I have not changed any of it. Correcting a deposit is a write to live money data
and it is yours to make. The right order is still: restore the line items first,
let the engine recompute the materials cost, then set the deposits from the real
number rather than from the wreckage.

---

# 07:05 -- job 7: you are owed $570 and nothing in the app will tell you

The one job that still holds its priced lines, and it is the strangest row in the
database. All read-only, control and canary clean.

Its six live lines:

| | qty | each | value |
|---|---|---|---|
| PANEL | 106 | $52.35 | $5,549.10 |
| LINE_POST | 92 | $16.56 | $1,523.52 |
| CORNER_POST | 3 | $16.56 | $49.68 |
| END_POST | 2 | $16.56 | $33.12 |
| POST_CAP | 97 | $0.74 | $71.78 |
| CONCRETE_BAG | 107 | $4.75 | $508.25 |
| | | | **$7,735.45** |

She signed at **$7,740.00**, and that $4.55 is not a mystery: `ceil(7735.45/10)*10`
is exactly 7,740.00. **That job was signed under the old round-up-to-$10 engine**,
which you had removed. Confirmed arithmetically, not guessed.

**She has paid $7,170.00. You are owed $570.00.**

And nothing will tell you, because `contract_total` on that job is **$0.00** while
the lines sum to $7,735.45. It was priced by the app on 17 Sep under engine
2026.09.1 and the stored total was zeroed afterwards. With a zero total, every
balance calculation on every surface returns zero or nonsense -- which is the
"contract total is 0" case last night's audit called latent.

Its status is still **DRAFT**, on a signed job that is 93 percent paid.

## One last trace of the tax bug, and it is harmless today

Exactly **one** live line item in your whole database is still marked
not-taxable: job 7's PANEL line, $5,549.10. Job 7 is set to 0 percent tax, so it
costs nothing right now. But if you ever put 7 percent on that job, the biggest
line on it escapes, and that is **$388.44**.

Everything else is clean: your catalog has zero non-taxable rows, for any role,
across every company in the database. The seed fix held. This is one stored row
that predates it.

Your tax rates, for the record: jobs 1, 6 and 7 are at 0 percent; the other eight
are at 7 percent. I do not know whether job 7 at zero is deliberate, so I have
not touched it.

---

# 07:20 -- it is only you, and it has fired on ten separate days

Checked across every company in the database, read-only.

| | |
|---|---|
| Companies in the database | 10 |
| Generated line-item tombstones, all companies | 118 |
| Of those, carrying the phone fingerprint (`deleted_by` empty) | **100** |
| How many distinct companies those belong to | **1 -- yours** |
| How many separate days they fired on | **10** |
| Latest | 1 October |

**No other FenceFlow company has lost a line item to this.** That is worth
knowing before you worry about your customers. The honest caveat is that the
other nine companies are barely used -- there are only 38 live generated line
items in the entire database -- so this says "it has not bitten anyone else yet",
not "it cannot".

**Reconciling the two numbers I have given you**, so it does not look like they
are drifting: **100** is every phone-fingerprint tombstone; **77** is the subset
sitting on jobs that still exist. The other 23 belong to jobs you have since
deleted, so they do not matter to the repair. The repair targets the 77.

Ten days, from 22 August to 1 October. Roughly weekly. The 1 October burst was
the biggest by a long way but it was never the only one, and anyone reading only
that day would have called it a one-off.

---

# 07:45 -- THE BIGGEST FINDING OF THE NIGHT. Not one job shows a correct materials list.

Verified myself, read-only, control and canary clean.

| | |
|---|---|
| Your jobs priced at the CURRENT engine (2026.10.8) | **ZERO** |
| Never priced at all | 2 |
| Priced at engine 2026.09.1 | 3 |
| Priced at engine 2026.10.2 | 6 |
| Live BLANK_POST line items anywhere in the database | **ZERO** |

Every fix made for you this week lives in the engine, and **nothing re-priced your
jobs.** So every stored takeoff predates:

- the post-height fix (a 6 ft fence was being given a 4 ft fence's post)
- the gate-post fix (gate posts were never billed as gate posts)
- the wall-gate blank post (+$17.72 a gate -- and there are zero of these in your
  whole database, so that fix has reached no job at all)
- the corner-post fix from last night

The two jobs that still hold line items:

- **Job 7** -- engine **2026.09.1**, priced 17 September. That is the engine that
  rounded up to the next $10. Pre-everything.
- **Job 11** -- engine **2026.10.2**, priced 1 October 23:50. After the deletion,
  before all four post fixes.

Measured on one of your own jobs: the stored takeoff says **37 posts**, the current
engine says **38**. The missing one is the wall-gate blank post. And two stored
lines name a product the engine no longer picks -- a line post naming the 4 ft
product on a 6 ft run, an end post naming the 8.5 ft product on a 4 ft run.

**So: nine of your jobs have no materials list because the app deleted it, and the
two that have one were worked out by an engine with four known bugs in it.** Not
one job in the app currently shows a materials list you could buy against.

This is fixable and it is not more code. It is a re-run.

## The order to do it in, once the build is installed

1. **Install the new APK.** The engine fixes only exist in it.
2. **Restore the deleted line items** -- `supabase_a64_restore_tombstoned_line_items.sql`.
   Provably cannot duplicate anything; I checked every dead line against every
   live one.
3. **Re-run the takeoff on each job** (the Suggest button). That brings all eleven
   to engine 2026.10.8 and puts the right posts, the right heights and the blank
   post on them.
4. **Expect the prices to move UP** on most jobs. That is the four fixes arriving,
   not a new bug. The posts were wrong in your favour's opposite direction -- you
   were under-billing.
5. **Then handle re-approval** on the three signed jobs. By then the figure she is
   asked to agree to is the correct one, including the $1,522.22 of sales tax,
   instead of the wreckage.
6. **Set the deposits last**, from the real materials cost -- including undoing
   the trigger's $17,793.82.

Doing these out of order is how you ask a customer to re-approve a number that is
still wrong.

---

# 08:30 -- you are quoting at Flori's OLD prices. $1,146.84 across eight jobs.

This is a DATA fix, not a code change, and you can do it yourself in the catalog
editor. Measured by pricing all eight of your real jobs through the real engine
twice -- once as-is, once with three rows retired -- with a positive control
proving the choice actually moved.

When the engine picks a product it takes the CHEAPEST matching row. Three of your
rows are your own earlier Flori prices, labelled *"FloriFence Invoice 36499 /
Estimate 17407 (real prices)"*, and Flori's 30 September estimate 17827 superseded
them. The old row is cheaper, so the engine picks the old row:

| | you quote at | Flori's price now | per unit |
|---|---|---|---|
| PANEL 6'H x 6'W White | $52.35 | $54.15 | **−$1.80** |
| POST_CAP White | $0.74 | $0.78 | −$0.04 |
| BRACE 8' | $6.50 | $6.90 | −$0.40 |

| Job | materials understated | quote understated |
|---|---|---|
| 1 | $243.84 | $300.05 |
| 2 | $84.64 | $90.56 |
| 3 | $219.88 | $235.28 |
| 4 | $23.00 | $24.61 |
| 5 | **$511.00** | **$546.77** |
| 6 | $0.96 | $1.03 |
| 7 | $16.60 | $17.76 |
| 8 | $46.92 | $50.21 |
| | **$1,146.84** | **$1,266.27** |

**Your markup is 0% on seven of those eight jobs.** Nothing is absorbing it -- it
comes straight off your margin. Job 5 is 277 panels and $511, which is a day of a
man's labour on a job with no markup in it.

**It was NOT the starting-list guesses.** I told you earlier your cheapest panel
was $52.35 against a Flori quote of $54.99 and guessed about $90 on a 198 ft job.
The direction was right; the mechanism and the size were not. It is $54.15, not
$54.99, and it is a superseded invoice of your own, not a FenceFlow guess. None
of the 76 placeholder rows wins a single vinyl line.

## What to do, and the trade-off is real

**Retire the three stale rows** -- untick active in the catalog editor. Recovers
the $1,146.84, needs no code and no deploy.

**Do NOT set Flori as your preferred supplier** to fix it. I measured that too:
it fixes 6 ft, but it costs you **$59.36 more per 100 ft at 4 ft**, because you
lose Hartford's 4 ft Clearwater gate at $113.75 against Flori's $170.00. There,
cheapest-wins is doing exactly the right thing.

**And this will happen again.** Prices only go up, and every rise you record as a
NEW row leaves the old one active and cheaper -- so the engine will always quote
at the oldest price in your catalog. Nothing on screen tells you a line is priced
off a superseded invoice. That is worth a rule of its own: when you add a new
price for something you already have, retire the old row rather than leaving both.

Flori's terms close the door behind it: 60% to place the order, the quote honoured
72 hours, **all sales final, 15% restocking if they accept a return at all.** Once
the order is in you cannot go back to the customer.

---

# 09:15 -- the three rows are retired. It is live on your account now.

Applied `supabase_a74_retire_superseded_flori_rows.sql` on your word. Reversible --
it sets `is_active = false` and deletes nothing. Verified afterwards:

| Role | was reaching | now reaches |
|---|---|---|
| PANEL 6'H x 6'W White | $52.35 (old invoice) | **$54.15 [Flori Fence]** |
| POST_CAP 5" Pyramid White | $0.74 (old invoice) | **$0.78 [Flori Fence]** |
| BRACE Gate Support 8' | $6.50 (old invoice) | **$6.90 [Flori Fence]** |

**This nearly went wrong and it is worth knowing why.** My first query asked
"which old rows undercut another row" and returned **eleven**. Retiring those
would have done real damage: your old line post at $16.56 only undercuts
*Hartford's* $19.00, and Flori's own current line post is **also $16.56** -- so
retiring it would have pushed every line post to $19.00 and raised your quotes for
nothing.

The honest test was supplier identity: is the next-cheapest row the **same product
from the same supplier** at a newer, higher price? Only three pass it. I checked
each of the three has a dearer Flori-attributed twin before writing, and the guard
in the file refuses if any of that stops being true.

Controls after the change: line post still $16.56, and Flori still beats Hartford
everywhere it should. Nothing moved that should not have.

**It takes effect immediately in the office.** Your phone picks it up on its next
sync. It applies to new quotes and anything re-priced -- it cannot change the
stored line items on your existing jobs, because those were never re-priced at all
(see the 07:45 section).

## The signing key, checked while preparing the build

`git ls-files | grep keystore` returns nothing, so I checked properly rather than
assuming the worst. It is fine:

- The key lives at `C:/Users/march/keys/fenceflow-release.jks`, outside the repo.
- It is backed up on Drive at `Projects/Signing Keys/fenceflow-release.jks`, and
  I compared SHA-256 on both: **identical**. There is a README beside it.
- `app/build.gradle.kts:156` already refuses an `assembleLink` build outright if
  the key is missing, with a message saying why. That guard is the right one and
  it is already there.

So the thing that bit Ledger -- a signing key existing on exactly one machine --
does not apply here. Good.

---

# 10:30 -- the email feature had three ways to hurt you. All three fixed.

You asked for email templates this morning. They got built, then attacked, and
the skeptic found real security holes. I fixed these three myself rather than
queue them, because they ship the moment anything is built.

Good news first: **nothing was ever sent.** Both skeptics grepped for it
specifically. Every address used in testing is on a reserved TLD. No mail
reached a server and no real customer was touched.

## 1. A stranger could get a clickable link into mail from YOUR domain

`supabase/functions/_shared/email-templates.ts` had two builders printing the
same two fields. One sanitised them. The other, 450 lines down in the same file,
did not:

    line 343  const name = typedByStranger(facts.customerName, NAME_MAX)   <- safe
    line 806  const name = oneLine(facts.customerName, NAME_MAX)           <- was not

`lead-intake` runs with no login required, so anyone filling in your website
form writes `customer_name` and `address` onto a job. The mail builder then
turns a bare `https://` in the text into a real clickable link -- in a message
that arrives from your address. Four templates print those fields.

So: a stranger types `Jane Smith https://evil-site/pay` into your contact form,
and FenceFlow emails your customer a clickable attacker link, signed off with
your company name.

**Fixed.** Both fields now go through the same guard. `tests/a75` asserts it
structurally, so a new template that forgets cannot pass, and I proved the test
has teeth by reverting the fix and watching it go red, then restoring the file
byte-identically.

Your own business name and phone deliberately stay unfiltered -- you type those,
and stripping a link out of them would mangle what you asked to be shown.

## 2. The phone could address a draft to TWO people

`lead-intake`'s only check on an address was that it contained an `@`. So
`her@example.com, attacker@example.com` is a value your app can be holding. The
phone put that whole string into Android's recipient field, which takes a LIST --
and the quote email carries the quote link, which is a **bearer token that can
approve and sign on her behalf.** The only thing between that and a real leak
was you noticing the To line before tapping send.

**Fixed at the funnel, not at the five call sites.** `IntentHelpers.openEmailDraft`
now refuses anything that is not a single plausible address, and returns false
without opening -- which the callers already treat as "did not send", because
that was already the right behaviour for a phone with no mail app. Gating the
five callers one at a time never converges; the sixth one written next month
would arrive unguarded.

## 3. And the door that let the value in

`lead-intake` now refuses a list outright and stores an empty column rather than
a string it has judged unusable -- because `send-follow-ups` selects on
`email <> ''` and **mails automatically, with figures in it, with no further tap
from you.** A half-valid address stored is worse than none.

`tests/a76` holds both ends to the same clauses, so if one is ever relaxed
without the other the test says so.

**This one needs a deploy to take effect** -- it is an edge function. The phone
half needs the build. The template fix needs the deploy too.

## Still open on email, and why I did not fix it

**The office sends to an address it never saves.** When you fix a typo'd address
in the field and hit Email the quote, it sends to the corrected one -- and never
writes it back. `jobs.email` keeps the old address, and `send-follow-ups` then
mails the OLD one automatically, with money in it. That fix is in
`website/dashboard.html`, which another wave is editing right now; two agents
writing one file loses an edit. It is one line: save the email alongside
`quote_sent_at`.

Two smaller ones, same file or Kotlin: a job with a zero contract total can still
be emailed a quote that promises "the page shows the price", and the French
templates say "devis de Acme" where French needs "devis d'Acme" before a vowel.

---

# 11:45 -- the sync fix is VERIFIED. And it corrected three of my numbers.

A skeptic went at the fix for the bug that destroyed your line items, with no
knowledge of who wrote it. Verdict: **CONFIRMED WORKING.** All three layers it
needed are present, and it checked them by reading the code, not the comments.

| Layer | State |
|---|---|
| The pulls are ordered | present, and using the file's own `join()`-outside-`withPermit`-inside idiom, byte-for-byte the shape the catalog pull already used |
| A line naming a run this phone lacks is SKIPPED | present -- the no-fallback resolve now survives in exactly one place, the update branch that always had a fallback |
| A local absence can never tombstone a CLOUD row | present -- the whole function body is now read, delete-locally, forget; no `PendingDeletion` anywhere in it |

**The thing I was most worried about is impossible.** I flagged that a barrier
could deadlock and leave your phone silently not syncing, which would be worse
than the bug. It traced the semaphore: `netGate` is `Semaphore(4)`, there are
exactly nine permit sites, **none nested**, and both joins happen strictly
*before* a permit is taken — so a waiter holds zero permits and every holder is
runnable. Worst case is latency, never a hang. (It also notes the test does not
pin that, and at `Semaphore(2)` the same shape *would* hang. Worth a test.)

**On a fresh install the lines now land in pass one**, not two. Jobs sync first,
then runs, then children — so there is no longer a pass where an orphan exists
to be reaped. And if the fence-run pull fails on a dead spot, the job shows an
empty estimate until the next pass rather than a silently wrong one. That is the
right trade but it is not free, and you should know it is the behaviour.

## Three numbers I gave you were wrong

| I said | Actually |
|---|---|
| it started 22 August | **18 August** |
| the thrash was 29 August (3 deletes in 3 minutes) | **8 September.** 29 August had 7 rows spread over 2h50m |
| 77 rows destroyed | **100**, of which 77 sit on jobs that still exist -- both figures were right, I just used them loosely |

And one it established that I had not: **not one of the 100 was ever genuinely an
orphan.** Every single one named a fence run that is still live in the cloud
(`phone_named_no_run = 0`). So nothing was deleted because the data was bad —
all 100 were good rows destroyed by a phone that had not finished loading.

That also makes the restore safer than I said: there is no risk of resurrecting a
line whose run has gone, because every one of them still has its run.

## One latent hazard it found that nobody had named

A cloud line naming a run that is *tombstoned* in the cloud would be skipped on
every pass for ever, with nothing to clean it — reachable if a delete's tombstone
never pushes (offline, then reinstall). Measured live right now: **zero** such
rows, 2 tombstoned runs, positive control 41 live lines. A hazard in the design,
not a present loss. Written down rather than fixed, because fixing it blind is
how you get a reaper that deletes something it should not.

The row count in the code comment said 66; it is now 100, with a note that 66 was
the earlier undercount.

# Field feedback, 1 October 2026

Captured verbatim-in-substance from March while he was working, so none of it is lost.
Grouped by what it touches. **Two items contradict how the app prices today** and are
marked CONFLICT — those need his word before anything is built, because getting them
wrong moves every price.

Nothing here is built yet unless it says so.

---

## A. Money and pricing

**A1. CONFLICT — the total must be EXACT, not rounded up.**
> "I don't want the [total] to be rounded up I want it to be exact."

Today both engines end with `grandTotal = ceil(max(afterDiscount, minimumJobCharge) / 10) * 10`
— every total is rounded UP to the next $10. That is deliberate and long-standing, and the
whole parity fixture set records it. Removing it:
- changes the price of essentially every job,
- is a formula change, so it needs the engine version bumped on BOTH sides and all 85
  fixtures regenerated in the same commit,
- interacts with the minimum job charge, which is applied before the rounding.

Needs confirming before it is touched, because it moves real money on live jobs.

**A2. Deposit rounded UP to the next 100, then plus another 100.**
> "the deposit also should be rounded up to 100 + $100 in order for us to do go to schedule
> the job and to do transportation but don't tell the customer that I want that in the app."

So: deposit → round up to next $100 → add $100. The extra $100 covers scheduling and
transport and is NOT to be disclosed to the customer as a line item. Note this sits
*alongside* A1: he wants the TOTAL exact and the DEPOSIT rounded. Those are different rules
in the same calculation, which is fine but must not be conflated.
Also unresolved: what the deposit is a percentage OF, since A4 says it is currently wrong.

**A3. The right price from the materials actually on the job.**
> "I also want to be able to get the right price based on the materials that I put on there."

Reads as: the quote should price from the specific catalog items on the job, at their real
supplier prices. Overlaps the price-list upload (B1).

**A4. BUG — the deposit is wrong on the estimate after a run.**
> "after I do the run the deposit is not accurate on the estimate, it showed zero for the new
> job that I just created but the materials are a lot more."

Deposit showed **0** on a new job whose materials are substantial. A real bug and the most
concrete one in this batch — it has a reproducible case. Likely in the suggested-deposit
path, which was touched this session.

**A5. Price for EACH SIDE.**
> "I talked to my neighbor and she wanted to split the cost with another neighbor so she
> wanted to know the price of one side so she can split it with her neighbor."

A per-side (per-run, and possibly per-segment) price breakdown, so a customer can split a
cost with a neighbour. Real customer-facing need with a concrete story behind it.

---

## B. Manufacturer and catalog

**B1. Upload a document to set a manufacturer's prices — including a full PDF.**
> "how to be able to add a full PDF or document to add the full price of the manufacturer."

IN FLIGHT. The office already has a CSV-only price-list import that matches on item name
alone, not per manufacturer. Being extended now to target a chosen manufacturer and accept
more formats. PDF is the open question — a silently mis-read price from a PDF table is worse
than a refused file, because every later quote is wrong and nothing looks broken.

**B2. Small 4ft fences missing from the options.**
> "I also want to add small [4ft?] fences in the options because I do not have that and I
> want it for every client that I will be providing this app to."

NEEDS CLARIFICATION — "forfeit" in the transcript is most likely "four feet", which fits C3
below. Whatever it is, he wants it in the DEFAULT catalog every new client receives, not just
his own — so it belongs in the 92-row starting list, not a one-off row.

---

## C. The drawing grid

**C1. BUG — adding a side changes the footage.**
> "Sometimes on the grid when I add a side, the footage changes."

Existing sides' measured length shifts when a new one is added. Suspects: the rescale that
runs when the grid extent changes, point snapping, or a shared scale being recomputed.
Serious, because footage is what the job is priced on.

**C2. Join sides together; connect the whole fence without closing the perimeter.**
> "I want to be able to connect the sides together and I want to connect the whole fence
> together not necessarily close perimeter I still want that option to be available."

Snap/join run endpoints into one continuous fence, with closing the loop kept as an option
rather than the only way to connect. Affects post counts at joins — two runs meeting at a
corner should share a post, not bill two.

**C3. A 4ft fence should show its exact type.**
> "on the fence when I put the 4ft high, it should show the exact type of fence also."

Height alone is shown where the specific fence type should be too.

**C4. Reference photos to match materials.**
> "take pictures of what the fence would look like from a neighbor or something like that
> that way I can get the right material."

Attach reference photos — a neighbour's existing fence — to a job so the right material can
be matched. Distinct from the survey photo used for measuring.

---

## D. The customer's quote link

**D1. CONFLICT (legal) — the link signature should BE the contract signature.**
> "if I send a call to the customer in the customer signs do I really need them to sign at the
> job site? Okay then just sign on the link that I sent for the quote."
> "I want the sign to accept to be directly connected to the customer signing on the link."

Today these are deliberately TWO different things, and the separation was built on purpose
this session: `signature_storage_path` means the in-person signed contract — write-once,
pinned against tampering, read by the office as proof a contract was signed — while the new
`quote_approved_signature_path` is the remote approval on the link. Merging them means a
remote click carries the same weight as a signature taken in person.

That may be exactly what he wants, and plenty of contractors work that way. But it changes
what "signed" means on every job, so it needs his explicit yes, not an inference.

**D2. Customer can UNAPPROVE a quote.**
> "I want the customer to be able to unapprove a quote."

Interacts with the re-approval machinery already there, and with `accepted_total` anchoring —
if a customer unapproves, does the anchored price drop away? That must be answered before it
is built.

**D3. On approval, email the customer the contract, the total and the deposit required.**
> "also they approved the code I want them to receive an email of the contract and the total
> price and the deposit that is required to start."

**D4. The link must show total, deposit, and where to pay — with the payment options named.**
> "I want the customer to see the total and also the deposit and where to pay. Inform the
> customer that there is a fee to pay online but also you can decide to pay through cash app
> [Zelle?] or wire or cash."

So: state plainly that paying online carries a fee, and offer the alternatives — Cash App,
Zelle (probably — "for sale" in the transcript), wire, cash. Note the card fee function in
this repo is currently dead code and every link carries a $0 fee, so "there is a fee" is not
true today unless that is wired up.

---

## Already in flight when this arrived

- The link-distributed build regaining its update button (his report that the check-update
  button vanished and auto-update stopped). Cause found: one build flag.
- Letting a nominated crew member CAPTURE a neighbour's enquiry for the office to price —
  he chose capture-only, granted per person, so no money reaches a crew phone.
- The manufacturer price-list upload (B1).

## Needs his word before building

1. **A1** — remove the $10 round-up from every total? It moves live prices.
2. **D1** — should a signature on the link count as the signed contract?
3. **B2** — what "small [forfeit] fences" means.
4. **D2** — when a customer unapproves, what happens to the price they had agreed?

---

## C5. BUG, DIAGNOSED — "Use Grid" does not stick, and can leave a job pricing zero

> "I said use grid only, and when I got out and I came back to the page, it brought back
> the survey picture."

**Cause, read from the code.** `SurveyViewModel.clearSurveyImage()` is what "Use Grid" calls.
It sets `surveyImagePath = null` and never touches `surveyStoragePath`. Those are two
different fields and only the second one TRAVELS -- it syncs to the office and to any other
phone. So the device-local path is cleared, the travelling one survives, and the next time the
screen loads the job it sees a photo still attached and renders it. The choice was never
persisted in the field that matters.

**The part that costs money.** The same function sets the calibration like this: if there is
no travelling photo path it seeds the correct grid calibration, and OTHERWISE it sets the
calibration to NULL. A photo that has synced takes the null branch. So on such a job, pressing
"Use Grid" leaves BOTH the photo attached AND no calibration -- and an uncalibrated photo job
now prices NOTHING, deliberately, since guessing a scale was judged worse than refusing. He
can therefore press "Use Grid" and end up with the picture back and a quote of zero.

**Age.** The half-clear is NOT new; the function always left the travelling path alone, and
always wrote a null calibration when a photo was present. What is new is the consequence: the
engine used to guess a grid scale for an uncalibrated photo, so the job still priced. Now it
refuses. So an old bug acquired a money symptom this session.

**The fix is two things, and the second is the subtle one.** Clearing the grid choice must
clear the travelling path too, in the same write, or the choice does not persist. And the
calibration branch has it backwards for this case: if he has just said "use grid only", the
job IS a grid job and should get the grid calibration -- the null branch exists to avoid
inventing a scale for a photo, but after this action there is no photo to invent one for.

Related: the survey track running now is already asked to establish which field is written
when and whether anything is lost, so it may reach this independently. Recorded here so it
cannot be lost either way.

---

## C6. A run that steps 6ft down to 4ft with a raked section between

> "the customer wants the 6ft high fence to go from 6ft to 4ft, for it to be slanted
> diagonally to the 4 ft and then continue on."

**What the code says today.** Height is `height_ft`, and it sits on the RUN -- it is in the
pricing contract and the row loader, one value per run. So a run cannot change height along
its length, and no amount of UI will make it, because the price is computed from a single
height per run.

**So this is the SAME feature as his earlier "connect the sides together" request**, and that
is the useful finding. A 6ft section, a raked transition, then a 4ft section is three runs
joined end to end -- not one run with a varying height. Build the joining and this becomes
expressible; build a per-segment height instead and it duplicates what joining already gives,
while making every price depend on a field the server has never carried.

**What is genuinely new, and is a materials question rather than a drawing one:** a raked or
stepped transition panel is its own product. A vinyl run that drops 2ft over one bay needs a
transition panel (or a stepped panel plus a cut post), and none of that is in the catalog --
the 92-row starting list has no transition item at any height. So this needs a catalog
addition before it can be priced at all, and that is worth asking the suppliers about on the
same call as the 4ft prices: ask what they stock for a 6-to-4 transition and whether it is a
rake, a step, or a cut-down panel.

**Also worth deciding, and only he can:** is the transition charged as one bay of the taller
fence, one of the shorter, or its own item? That is a pricing policy, not a bug.

## C7. A gate mid-run should readjust the materials, and be visible on the grid

> "if I want to add a gate in the middle of the fence, it has to readjust the materials...
> if it is a 5ft gate, then it should remove 5ft from the footage and add the materials
> needed for the gate, like 2 end post and concrete, econo stiffener and the others, and I
> want to be able to see that in the grid."

**MOST OF THE ARITHMETIC ALREADY EXISTS -- verified by reading it, not assumed.** The post
rule in takeoff.ts computes bays from `netFt`, which already EXCLUDES gate widths, and then:

    gatePosts   = 2 per gate, or 3 for a LINE_TO_WALL gate
    bays        = ceil(netFt / postSpacingFt)
    estimate    = bays + 1 - gateCount        (for a run with two ends)
    totalPosts  = linePosts + corners + ends + gatePosts

So a 5ft gate already removes 5ft from the billed fence, already removes a bay, and already
adds two posts. `GateMounting` already distinguishes WALL (bolted through a blank post, no
concrete, needs plugs), LINE (set in concrete like any other post) and LINE_TO_WALL -- and
those differences are described in the enum's own comments, including the econo stiffener.
A gate in the middle of a run IS the LINE mounting.

**So what is actually missing is narrower than it sounds, and should be established before
building anything:**
  1. Can he PLACE a gate mid-run on the grid today, or only at an end? That is the first
     thing to check and it decides whether this is a drawing job or a display job.
  2. Does the concrete count actually change per mounting? The WALL comment says no concrete
     is needed, so the two should differ -- confirm from the concrete arithmetic rather than
     from the comment, because a comment describing the intent is not proof of the code.
  3. HE WANTS TO SEE IT. That is the real request, and nothing in it exists: the grid does
     not show what a gate did to the materials. A panel that says "this 5ft gate: -5ft
     fence, -1 bay, +2 posts, +1 stiffener, +2 bags" is the deliverable, and it is also the
     honest way to prove to him that the maths he is asking for is already happening.

**Do not rebuild the arithmetic.** If it turns out correct, the work is placement plus a
readout. Rewriting a working takeoff to make it visible is how a correct calculation gets
broken.

---

## C8. CORRECTION — independent sides and the add-run control ALREADY EXIST

He said it plainly: *"The whole goal was to be able to draw one side and to draw another
one in the same drawing without connecting them together... I want to have the option to
either continue or start another side."*

**That is already the model, and I described it wrongly earlier.** Read from the source:

- A job holds a LIST of runs (`observeFenceRuns(jobId)`), not one. `selectedRunId` decides
  which one the finger is drawing on, and `addRun()` makes another.
- The draw screen already has the control -- a button when the job is empty and an
  "add run" dropdown once it is not, offering a fence run or a teardown run.
- So two sides that do not touch are two runs, which is exactly what he asked for. If he
  has not found the control, that is a LABELLING problem, not a missing feature. Check what
  that menu is called on the phone before building anything.

**Snapping across runs also already exists.** `snapTargets()` gathers vertices from EVERY
run on the job so a newly placed point can land exactly on one, and its own comment gives
the reason: *a back fence and a side fence that meet share one corner post; if the two runs
each keep their own corner a few inches apart, the takeoff sets two posts and the crew
arrives with a spare.*

## C9. THE REAL GAP — a junction bills two end posts where one corner post belongs

This is the thing he worked out himself without seeing the code: *"it would not be a corner
post if I drew it on the other side until I connect it to that one."*

**He is right, and the app never makes it a corner post at all.** The arithmetic is per run:

    cornerPosts = geometry.cornerCount   // bends WITHIN one run's own polyline
    endPosts    = geometry.endCount      // that run's own free ends
    totalPosts  = linePosts + cornerPosts + endPosts + gatePosts

`VertexKind.CORNER` is a bend inside a single run. So:

| What he draws | What he is billed | Right? |
|---|---|---|
| One side with a bend in it | 1 corner post | yes |
| Two separate sides, not touching | 2 + 2 end posts | yes -- his case |
| Two separate sides SNAPPED to the same point | still 2 + 2 end posts | **no** |

Snapping makes the two runs coincide geometrically. It does not merge the post. So the
junction stands one post in the ground and bills two, of the wrong type -- and the types
are separate catalog rows at separate prices (`CORNER_POST` "5x5 Co-Ex Corner Post, White"
is its own item). The spare post the snapping comment was written to prevent is still
bought.

**So the model needs an explicit CONNECTED fact, not coordinate proximity.** His sentence is
the specification: a post is a corner only once he says the two sides are joined. Two
points at identical coordinates are not evidence of a connection -- he may be drawing a
neighbour's fence that merely meets his. That settles the design question the running
analysis was weighing, and it settles it the safer way: an explicit link cannot be created
or destroyed by dragging a point a pixel.

## C10. A pickup / materials-check page for whoever collects the materials

> "When picking up materials, I want to have the whole process too for the person picking
> up... I want them to have a whole page to check if we have everything according to the
> job. Also... it would show the grid and the drawing and how many posts there needs and
> what type of post, and what type of materials would be there, I want to be able to check
> with the drawing etc, but put it somewhere convenient."

A pull sheet per job: the drawing beside the material list, with the counts BY TYPE (line /
corner / end / gate posts are four different items, which is the whole point of C9), so the
person at the counter can tick off what is loaded and catch a missing item before driving
back.

**Two things to settle before building it:**
1. **Who sees it.** He has said crew must never see money. A pull sheet is quantities and
   item names, not prices -- so it is the first screen that could legitimately go to a crew
   phone, PROVIDED no unit price, extended price or total appears anywhere on it. That has
   to be enforced where the data is selected, not by leaving a column out of the layout.
2. **Does ticking it off persist?** A checklist that forgets what was ticked when the screen
   rotates is worse than a printed list. If it persists it is a new table and it must join
   `TABLES` in `backup.ts`-equivalent for this app, or backup silently misses it.

The counts themselves already exist -- the takeoff emits `linePosts`, `cornerPosts`,
`endPosts`, `gatePosts` and the material lines. So this is a READOUT of existing numbers,
which is also what C7 asked for (seeing what a gate did to the materials). **Build them as
one screen, not two.**

---

## DECIDED 1 October 2026 — joining, the transition, and who sees the pull sheet

Asked and answered, so these are no longer open:

**1. Joining two sides swaps the post AUTOMATICALLY.** The moment he joins them, the two end
posts become one corner post and the materials readout shows the change. Unjoining puts the
two ends back. So the implementation must:
  - carry an EXPLICIT connection between two runs, not coordinate proximity (see C9) --
    dragging a point must not create or destroy a join,
  - subtract one END_POST from each side and add one CORNER_POST, which is a different catalog
    row at a different price, not a relabelling,
  - and subtract the POST_CAP and the CONCRETE that followed the post that no longer exists.
    Missing either of those two is an overcharge on every corner, and `POST_CAP` is priced off
    `totalPosts`, so it follows automatically only if `totalPosts` is what changes.
  - The readout is the proof. He asked to SEE it (C7, C10), and a join that silently changes
    the price is exactly what he should not have to take on trust.

**2. The 6-to-4 transition is dropped onto an existing side and the app splits it.** He taps a
spot on the 6 ft side and says drop to 4 ft here. The app produces a 6 ft part, the raked bay,
and a 4 ft part, joined by the same explicit joins as above, and adds the transition item.
  - This means the split is a WRITE of three runs where one was, so it must be undoable in one
    step -- the drawing already has an undo history and this has to land in it as one entry,
    not three.
  - It also means the transition's length is the app's choice, not his. One bay is the obvious
    default. Say so where he can see it, because it is the number that decides how steep the
    rake looks on the ground.
  - He did NOT pick "set heights and let the app insert a rake", and the reason he gave for
    joining applies here too: he does not want materials changing without him asking.

**3. The pickup/pull sheet goes to crew phones, quantities only, never prices.** Counts by post
type, the material list, the drawing, a tick box per line. No unit price, no extended price, no
total, nothing about money anywhere on it.
  - ENFORCE IT WHERE THE DATA IS SELECTED, not by omitting a column from the layout. A crew
    phone that can fetch the row can read the price off it whatever the screen draws. This is
    the same rule the rest of the app already follows and the reason crew currently read zero
    job rows.
  - He chose crew-wide rather than assigned-jobs-only, so the restriction is on the COLUMNS,
    not the row set. Worth a canary test that must fail: a crew-role read of the pull sheet
    payload asserting that no price field is present at all.

---

## DECIDED 1 October 2026 — the transition is a 6 ft panel he cuts himself

> "The transition only needs a 6ft high, I will cut it myself, or the client will cut it into
> the 4ft high. So just price it as 6ft."

This closes the pricing-policy question in C6 and it closes it the cheap way. A 6-to-4 fence
needs **no transition product**: the raked bay is a standard 6 ft panel, cut on site. It is one
bay of the taller fence at the 6 ft panel price, which is already what happens if that bay
simply belongs to the 6 ft run.

Consequences, all good:
- No catalog item, no new role, no engine rule for the transition.
- The transition row a track added under the old assumption (role NONE, 100.00 placeholder) and
  its one-company SQL are being **retracted**.
- The split is now TWO runs, not three: a 6 ft side (whose last bay is the rake) joined to a
  4 ft side. The diagonal is how it is DRAWN, not a thing that is priced.

## C11. SHIPPED BUG — panel choice ignores height, so a 6 ft iron fence is billed with the 4 ft panel

Found while defending the transition row, and worth far more than the row was. **Proved by
running the real engine, not by reading it.**

    The engine picks a PANEL by nearest coversFt, then by CHEAPEST, and never reads height.

In the shipped starting catalog, "Ornamental Steel Panel 4'H x 6'W, Black" (135.00) and
"Ornamental Steel Panel 6'H x 6'W, Black" (175.00) are both `coversFt = 6`. So a run spec'd 6 ft
wide ties on width and the **cheaper one wins whatever height the run says**. The 6 ft high panel
ships, and is never chosen. A 100 ft fence is 17 bays, so that is 17 x 40.00 = **680.00
undercharged on every 6 ft ornamental-iron job**, out of his own pocket, silently.

**This is also exactly why the 4 ft fences he asked for (B2) could not be added.** A
4'H x 6'W vinyl panel priced under the 6'H one would take over every 6 ft white vinyl quote the
same way. A test already demonstrates it. So B2 was never a catalog task -- it was blocked on
this bug, and nobody knew.

**The fix is the same fix for three separate requests:** the shipped iron mispricing, the 4 ft
fences, and the transition. Make panel choice height-aware and all three come right.

**What makes it non-trivial, and must be settled before it is built:**
1. **Where does a row's height come from?** If the only place it appears is inside the product
   NAME as text, then pricing would depend on parsing a product name -- fragile, and this
   project has a standing rule against comparing against display text, which nearly
   mis-coloured two charts once already. The clean answer is a real height column on the
   catalog row, and that is a schema change.
2. **What happens to a catalog with no matching height?** A company holding only 6 ft panels
   must not suddenly price a 4 ft fence at zero. The fallback decides whether this fix breaks
   an existing customer's live quote.
3. **It changes a price that is wrong today**, so it is a formula change: engine version bumped
   on BOTH sides and all 85 parity fixtures regenerated in the same commit.
4. **Check POSTS, not just panels.** If the same width-then-cheapest selection picks posts, a
   4 ft post could be chosen for a 6 ft fence -- that is a fence that falls over, not a pricing
   error. Being checked now.

## Known-red right now, and why — 1 October 2026

Three things are failing. None is a mystery and none is lost:

1. **The parity gate is RED.** Both engines read `PRICING_ENGINE_VERSION = 2026.10.1` after the
   exact-total change, while `fixtures/pricing/manifest.json` still says `2026.09.3` with 85
   cases. `ParityFixtureCheck` asserts those match, so it cannot pass. The fix is to regenerate:
   `FENCEFLOW_PARITY_OUT=$(pwd)/fixtures/pricing ./gradlew testDebugUnitTest --tests "*ParityFixtureWriter*"`
   -- which needs Gradle, which must not run while other waves are editing Kotlin. **Queued, not
   forgotten.** Note the regeneration has to happen AFTER a clean test compile, because
   `PRICING_ENGINE_VERSION` is a Kotlin compile-time constant and is inlined into the fixture
   writer itself.
2. **`tests/a30-use-grid-persists.test.mjs` is RED ON PURPOSE.** It pins the Use Grid bug
   (C5) until `SurveyViewModel.clearSurveyImage()` is fixed; the survey wave owns that file.
3. **Node suite flakes** from several Supabase CLI calls running at once -- they pass alone.
   Not a code failure, and must not be counted as one.

---

## C12. SHIPPED MONEY BUG — the old importer's label is not one the warning recognises

Found by the gate on the update-button wave, pre-existing and not introduced by it.

The app warns before a contract goes out if any price on it is unverified. That warning
decides by the row's `sourceDoc` label, and it recognises a fixed set of them
(`isPlaceholderPrice` in SeedData.kt). **The older price importer stamps
"Imported -- check this one", which is NOT in that set.** So every price brought in by that
importer passes the gate built to catch exactly it, silently.

The whole point of that warning is to stop a guessed price reaching a customer. An importer
whose own label is invisible to it is worse than no warning, because the screen says nothing
is wrong.

Two ways to fix it and they are not equivalent: add the importer's label to the recognised
set, or change the importer to stamp a recognised one. The first fixes rows ALREADY in the
database; the second only fixes rows imported from now on. **It needs the first**, and
possibly both.

BLOCKED: `SeedData.kt` is held by the running retract wave. Queued, not forgotten.

## The update button — FIXED, and the cause was the file in Drive

The symptom was real and the diagnosis is worth recording. `fenceflow.apk` in Drive was the
**Play-shaped** build: self-update off, install permission stripped. Byte-for-byte the
no-update build. So any phone installed from that file had no button AND could not fetch its
own fix -- the bug was unable to repair itself by design.

There are now two release build types:
- `assembleLink` -> `app/build/outputs/apk/link/app-link.apk`, self-updates, keeps
  REQUEST_INSTALL_PACKAGES. **This is the one that goes to Drive and to the link.**
- `assembleRelease` -> Play-shaped, self-update off, permission stripped.

Both signed with the same real key (`7b107795...2d42e2`), same application id, so either
installs over the other and keeps the data.

**`assembleRelease` is no longer the command to build what he hands out.** Three docs still
say it does: `DEV_ENVIRONMENT.md:226`, `RELEASE_SETUP.md:71`, `AUDIT_2026-09-17.md:24`.

**He must install once by hand.** A phone on the old Play-shaped build cannot update itself to
the new one -- that is the whole bug. After that one manual install it updates itself.

**Drive currently holds 1.562 while the repo has moved to 564+**, because other tracks
committed during that build. The publish script compares the two and will refuse, which is
correct. A fresh `assembleLink` is needed at whatever commit is meant to ship -- and with
nothing committing in between.

---

## C13. CORRECTED — the height transition is a DIAGONAL, it sits AT THE CORNER, and he chooses it

Three readings of this, and only the third is his. Recording all three so nobody re-derives a
wrong one from the earlier notes:

1. First reading: a raked bay somewhere along a run, needing its own catalog product. WRONG --
   he then said "the transition only needs a 6ft high, I will cut it myself... just price it
   as 6ft", so there is no product.
2. Second reading, from his photo: a STEP at a post, because the photo shows a tall privacy
   section meeting a shorter picket section at a post. ALSO WRONG -- that is a different part
   of the fence.
3. HIS WORDS: *"The transition is a diagonal all the way in the corner, I want to choose it
   when it's time."*

So the model is:

- **It is a diagonal**, not a step. The panel rakes from 6 ft down to 4 ft.
- **It sits at the CORNER** -- the point where two sides meet, which is exactly the junction
  the join work is building. So the transition is a property OF A JOIN, not of a run and not
  of a bay somewhere in the middle of one.
- **He chooses it.** Not inferred from two sides having different heights. Same principle he
  already set for the corner post itself: *"it would not be a corner post if I drew it on the
  other side until I connect it to that one."* He makes the fact; the app does not guess it.

**This lands the transition squarely on the join, which is already being built.** A join
between two runs of different heights gets an option -- step or diagonal -- and he picks per
corner. That is a field on the join record, not new geometry on a run, and it is the natural
place for it: the join already knows both runs and therefore both heights.

**What it means for pricing, with his rule applied:** the diagonal bay is a 6 ft panel he cuts
on site, so it bills as one bay of the TALLER side. No catalog item. The join still removes one
post, one cap and that post's concrete, exactly as a plain corner does -- a diagonal corner is
still one post in the ground.

**What it means for the 3D view:** the quote page already renders each run at its own height
(`const heightFt = Math.max(2, Number(run.heightFt)||6)` in website/quote.html), so two joined
runs already draw at different heights. What is NOT drawn is the diagonal between them -- today
the two heights would meet as an abrupt step. The rake is a geometry addition at the join, and
it is cosmetic only: it changes no quantity, because the bay is already billed as a 6 ft panel.

**Still unanswered, and only he can say:** over what distance does the diagonal fall? One bay
is the obvious default, and his own photo suggests the drop happens across a single panel. Ask
before building, because it decides how steep the rake looks on the ground.

---

## C14. Put the house on the grid, so the fence has something to be located against

> "I want to be able to add the house, or where the house is so the fence can be located and
> we know where it should be on the grid."

On a photo survey the house is visible, so the drawing has something to sit against. On the
GRID there is nothing -- just lines in space. So a grid drawing cannot answer "is this the
left side or the right side", and the crew cannot tell from it where the fence actually goes.

The job already carries `site_lat` / `site_lon` from geocoding the address, so the app knows
where the house IS in the world. What it has no notion of is the house's FOOTPRINT or its
ORIENTATION on the drawing.

Worth settling before building, in this order:
1. **What does he want to place -- a rectangle, or a marker?** A rough rectangle he can drag,
   size and rotate is the useful version: it tells the crew which side is which. A single pin
   says less but is one tap.
2. **Does it travel?** The office and a second phone both need to see it, so it is a job
   field, not a device setting -- unlike the Use Grid choice, which deliberately stayed local.
3. **It must not become a fence.** Whatever shape is placed cannot enter the takeoff: it has
   no height, no panels and no posts. The safest shape is a separate entity, NOT a FenceRun
   with a flag, because a flag is one missed `if` away from pricing the house.

## C15. BUG, seen in his own screenshot -- the 3D quote page overlaps its own labels

From the photo he sent of the live quote page on his phone, at 390px wide:

- **"YOUR FENCE..." is painted underneath "TURN THE FENCE TO MATCH".** Two overlays are drawn
  in the same place at the top-left of the stage; the first is unreadable.
- **The drag hint ("Drag to look around - two fingers to move - pinch to zoom") collides with
  the imagery attribution block**, which is itself three lines long on a narrow screen. The
  two sit on top of each other at the bottom of the stage.

This is a customer-facing page -- it is what a homeowner sees when he sends a quote. Neither
is subtle and both only appear at phone width, which is the width every customer uses.

**Check it at 390px, not on a desktop.** The attribution is three lines on a phone and one on
a desktop, which is exactly why this was not noticed.

Related but separate: the ground in that same screenshot is washed out and speckled, which is
NOT the imagery -- the raw tiles are sharp (see the comparison built on 1 Oct). Suspects, in
the order they are worth checking: the canvas filter `contrast(1.1) saturate(1.12)
brightness(1.03)` tuned for softer imagery and now amplifying compression noise; the ground
being a lit MeshStandardMaterial over imagery that already contains its own baked sunlight;
and texture filtering at the grazing angle the camera actually uses.

**DECIDED (1 Oct): a rectangle he can drag and rotate**, not a pin. So the house carries a
position, a width, a depth and a rotation -- four things, and rotation is the one that makes
it useful, because it is what tells the crew which side of the house a run is on.

Consequences to build to:
- It TRAVELS (it is for the office and the crew), so it is a job-level record, not a device
  setting. Unlike the Use Grid choice, which is deliberately local to the phone.
- It is NOT a FenceRun with a flag. Its own entity. A flag on a run is one missed `if` away
  from the house being priced as fence, and the takeoff walks runs.
- It must be excluded from everything that measures: total footage, the extent used to fit
  the drawing, post counts, and the parity fixtures. Each of those is a separate place that
  reads geometry, so each needs checking rather than assuming one guard covers them all.
- Rotation means it cannot be stored as a plain bounding box. Centre point, width, depth and
  an angle is the honest shape.
- On the GRID it is the only landmark, so it should be drawn plainly and clearly behind the
  fence lines -- never on top of them, and never something that can be confused for a run.

---

## Building from a clean worktree needs TWO untracked files

Recorded because it cost a 6-minute failed build on 1 Oct, and the next person doing this will
hit it too.

Building in a fresh `git worktree` is the right way to produce an APK while agents are editing
the main checkout -- the worktree is a pristine copy at a commit, so nothing half-written can
reach the artifact. That is the fix for the crashing 1.562 build, which was compiled across
commits that landed at 10:24 and 10:27 WHILE it was running.

But a worktree contains only TRACKED files, and two the build needs are gitignored:

    cp local.properties      <worktree>/local.properties        # sdk.dir, supabase, keystore
    cp app/google-services.json <worktree>/app/google-services.json

Without the second, `processLinkGoogleServices` fails six minutes in with a clear message, so
it is cheap to diagnose -- but six minutes is six minutes. Copy both immediately after
`git worktree add`.

Note the failure mode is worth telling apart from the memory one. This build printed a proper
`FAILURE:` block with `What went wrong`. A memory death does NOT: the log simply stops
mid-task with no error block at all. If you see a truncated log, check free RAM before reading
a single line of code.

Also: `git rev-list --count HEAD` in the worktree is what sets versionCode, so the worktree
must be at the commit you intend to ship. A build from an older commit produces an APK Android
will REFUSE to install over a newer one already on the phone -- which is the position the
owner was left in by 1.562 crashing: 560 and 557 both existed and neither could be installed
over it without uninstalling and losing the job data.

---

## DECIDED 1 October 2026 — diagonal length, and catalog write permission

**1. The diagonal falls over ONE PANEL.** So the rake is a single bay wide: 6 ft down to 4 ft
across one panel at the corner. No setting, no prompt for a distance -- one bay is the rule.
That also means the drop is steep (2 ft over a 6 ft or 8 ft panel) and that is intended; it
matches what he builds. Draw it that way in the 3D view and on the grid.

**2. SALES and ACCOUNTANT ARE ALLOWED to change the catalog. DO NOT tighten the policy.**

> "yeah sales and accountant can change catalogs."

This closes C12's second half with NO CODE CHANGE. The policy on material_items checks company
membership rather than role, and that turns out to be the intended behaviour, not an oversight.

Two things follow and both matter:
- **The hidden button is now the bug, not the policy.** The price-list upload button is shown
  only to OWNER/MANAGER while the database lets SALES and ACCOUNTANT write. The UI and the
  rule disagree, and the rule is the one he just confirmed. So the fix is to SHOW the button
  to the roles that can actually use it, not to lock the database down. A control hidden from
  someone who is permitted to act is a different defect from a control shown to someone who
  is not -- this is the first.
- **Record what he accepted**, so nobody "fixes" it later: anyone with money access can change
  catalog prices, including through the API directly. That is deliberate. It is NOT a crew
  exposure -- crew have no money access and still see nothing.

The FIRST half of C12 still stands and is still a real bug: the old importer stamps
"Imported - check this one", which `isPlaceholderPrice` does not recognise, so imported prices
silently pass the unverified-price warning. Permission has nothing to do with it.

**3. Stripe stays in test mode for now**, by his choice -- "will work on Stripe later". So no
real money can move through a quote link until he switches it. Not a blocker to building
anything else; it is a blocker to USING the payment half on a real job.

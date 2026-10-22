# FenceFlow Field Check — 22 October 2026

Every item you raised in the field on 1 October (`FIELD_FEEDBACK_2026-10-01.md`),
three weeks on, with **what happened to it** and **how to check it yourself**.

Status was read from the code and from the live database today, not from
memory: where it says a number, that number was queried.

| | |
|---|---|
| **DONE** | built, shipped, and there is a way to check it below |
| **PART** | some of it is in; the rest is named |
| **OPEN** | not started |
| **YOURS** | waiting on a decision only you can make |

**22 of the 31 items are DONE.** The ones left are listed at the bottom with
nothing hidden among the finished ones.

---

## Money

**A1 — the total must be exact, not rounded up. DONE.**
Both engines end on the exact cent. It was `ceil(total / 10) * 10` until 1
October; the round-up is gone and the engine version was bumped on both sides
so an old phone cannot overwrite a new price.
> **Check:** price any job. The total should end in something other than 0 —
> `$7,735.45`, not `$7,740.00`.

**A2 — deposit rounded up to the next $100, then plus $100. DONE, and not disclosed.**
The extra hundred for scheduling and transport is in the deposit and appears
nowhere the customer can see. No itemisation, no second figure.
> **Check:** a job whose deposit works out at $1,230 should ask for **$1,400**
> ($1,300 rounded up, plus $100). The customer's page shows one number and no
> breakdown.

**A3 — price from the materials actually on the job. PART.**
Quotes price from your catalog rows at your prices, and the price-list import
(B1) is in. What is *not* there is pinning a specific catalog item to a run by
hand — the engine still chooses the row by role, width and now height.

**A4 — deposit showed zero on a new job. CHECK THIS ONE.**
The deposit path was rebuilt and is now tested both ways (capped at the
contract, reduced by what has been paid, never negative). I could not
reproduce your original job, so this one needs your eyes.
> **Check:** make a new job with real materials and look at the deposit on the
> estimate before anything is paid. If it reads 0, send me the job name.

**A5 — a price for EACH SIDE, so a neighbour can split it. OPEN.**
Nothing built. Everything needed is there — each run already carries its own
footage, posts and panels — so this is a readout, not a calculation.

---

## Catalog

**B1 — upload a document to set a manufacturer's prices, including a PDF. DONE.**
The office imports a CSV; the phone imports a **PDF** (Catalog → the round
button, bottom right).
> **Check:** Catalog on the phone → the + button → pick a supplier PDF. It
> should show you what it read and let you choose rows before anything is
> saved.

**B2 — 4 ft fences in the default catalog. PART, and here is exactly what is missing.**
The blocker is gone (see C11) and the starting catalog now has **4'H ornamental
steel** panels and gates. It still has **no 4 ft vinyl panel** — and vinyl is
what you actually sell. Your suppliers quoted the two 4 ft products in
`SUPPLIER_QUOTES_2026-10-01.md` (Flori Melrose flat-top $61.74, Hartford
Clearwater picket $71.50), so the rows can be added as soon as you say which
of the two is the default.
> **Yours:** which 4 ft vinyl panel goes in the catalog every new client gets?

---

## The drawing grid

**C1 — adding a side changed the footage. DONE.**
Fixed and pinned by a test that measures existing sides before and after a new
one is added (15 checks, green today).
> **Check:** draw a side, note the footage, draw a second side. The first
> number must not move.

**C2 / C8 / C9 / C16 / C22 — joining sides, and the corner post. DONE, all four links.**
This was the thing you asked for four times in one day. All of it is in:
- the join record, syncing to the office and to a second phone;
- the shared-post arithmetic (two runs, three in a line, a closed chain, a T);
- **wired to the price** — a join really does change the money now;
- the gesture: start the new side by tapping the end of an existing one.
> **Check:** draw a side. Start the next one by tapping the **end** of the
> first. The joint should draw differently from a free end, and the materials
> should drop by one post, one cap and that post's concrete, with the two end
> posts becoming one **corner** post.
>
> One thing I changed today while checking it: when two runs of different
> heights meet, the shared post is billed to the **taller** run. Both engines
> had it backwards — they billed the shorter one. On your live jobs nothing
> moves: all 12 joins on 8 joints are between runs of the same height.

**C3 — a 4 ft fence should show its exact type. DONE.**
The run editor carries a fence-type dropdown beside the height.

**C4 — reference photos, to match materials. DONE.**
Job photos are a separate thing from the survey photo used for measuring.

**C5 — "Use Grid" did not stick and could leave a job pricing zero. DONE.**
Both halves: the travelling path is cleared in the same write, and the grid
calibration is seeded instead of nulled. Its test is green today.
> **Check:** on a job with a survey photo, press **Use Grid**, leave the job,
> come back. The photo must stay gone, and the job must still price.

**C6 / C13 — the 6-to-4 transition. DECIDED, no product needed.**
Your call: it is a 6 ft panel you cut yourself, so it bills as one bay of the
taller side. No catalog item, no new rule. The rake falls over **one panel**.

**C7 — a gate mid-run readjusts the materials, and you can see it. PART.**
The arithmetic was already right and still is: a 5 ft gate removes 5 ft of
fence, removes a bay, and adds two posts. What is still **OPEN** is the
readout — the panel that says in words *"this 5 ft gate: −5 ft fence, −1 bay,
+2 posts, +1 stiffener, +2 bags"*. That is the half you actually asked for.

**C10 — a pickup / materials-check page. DONE.**
Built, quantities only, no prices anywhere — and the no-prices rule is enforced
where the data is selected, not by leaving a column off the screen.
> **Check:** open a job's plan view on a crew phone. Counts by post type and
> the drawing, and **no money anywhere**. If you see a price, tell me at once.

**C11 — panel choice ignored height, so a 6 ft iron fence billed the 4 ft panel. DONE.**
This was the $680-a-job silent undercharge. Catalog rows carry a real height
column now; nothing is read out of a product's name.
> **Verified in your live database today:** all 23 panels declare a height —
> the ornamental 4'H reads 4 and the 6'H reads 6, so a 6 ft iron run takes the
> $175 panel, not the $135 one.
>
> Posts: your **vinyl** posts all declare a height (17 rows), which is the only
> place it can bite, because vinyl is the only type where you hold more than
> one post per role. Every other fence type has exactly one post per role, so
> there is nothing to choose wrongly. No action needed.

**C12 — the importer's label was invisible to the unverified-price warning. DONE.**
"Imported — check this one" is recognised now, so rows already in the database
are caught, not just new ones.

**C14 — put the house on the grid. DONE, as you decided it.**
A rectangle with a position, a width, a depth and a **rotation**, its own
record, travelling to the office and to the other phone, and excluded from
everything that measures.
> **Check:** on a grid drawing, place the house and rotate it. The footage and
> the post count must not move by a single foot.

**C17 — show the 6-to-4 diagonal on the customer's 3D quote. OPEN.**
The quote page already draws each side at its own height, so a 6 ft side joined
to a 4 ft one already steps down. The **rake** between them is not drawn — the
two heights still meet as an abrupt step. Cosmetic only; it changes no price.

**C18 — a dropdown when you pick 4 ft. OPEN.**
Height is still a number you type. What you actually want is "**which** 4 ft
product", with the supplier's name beside each, because you now hold two at
different prices. Depends on B2 above.

**C19 — payment methods editable on the phone as well as the office. DONE.**
Same key, same path, same gate — not a second store.

**C20 — payment limits. DONE.**
A limit field per method that you fill in, blank by default, nothing invented.
> **Once, and I will not raise it again:** taking business payments through a
> personal Cash App or Zelle is against both services' terms and carries no
> seller protection. Your call; I would rather you heard it from me.

**C21 — tell the customer what the deposit is for. DONE, in all three places.**
"Your deposit reserves your place on the schedule and pays for the materials.
The rest covers the labor." On the quote page, in the approval email, and in
the copy she downloads. The purpose, never the breakdown.

---

## The customer's quote link

**D1 — should signing on the link BE the contract signature? YOURS.**
Still two different things on purpose: the in-person signature is write-once
and pinned against tampering; the link approval is its own record. Merging them
makes a remote click weigh the same as a signature taken at the kitchen table.
Plenty of contractors work that way. It changes what "signed" means on every
job, so I will not infer it.

**D2 — let the customer unapprove a quote. OPEN, and it needs your word first.**
One question decides the build: when she unapproves, does the price she had
agreed fall away, or does she stay held to it? Those are different products.

**D3 — email the contract, the total and the deposit on approval. DONE.**

**D4 — the link shows total, deposit, where to pay, and names the fee. DONE.**
The card fee is real now — 2.9% + 30¢ grossed up, capped at 3% — so saying
"there is a fee to pay online" is true. Cash App, Zelle, wire and cash appear
beside it, and any method you have not filled in is simply not shown.
> **Check:** open one of your own quote links on your phone. Total, deposit,
> the fee sentence, and only the payment methods you filled in.

**C15 — the 3D quote page overlapped its own labels at phone width. UNVERIFIED.**
I have not looked at this one at 390 px and will not claim it. It is on the
list below.

---

## What is left

**Open, in the order I would build them:**

1. **C7 readout** — what a gate did to the materials, in words. The arithmetic
   is already right; this is showing it. Same screen as the pull sheet.
2. **A5 per-side price** — a readout of numbers each run already carries.
3. **C15** — look at your own quote link at phone width and fix what overlaps.
4. **C17 rake** — draw the diagonal in the 3D view. Cosmetic.
5. **B2 + C18** — the 4 ft vinyl panel and the "which 4 ft product" dropdown,
   once you pick the default.
6. **A3** — pinning a specific catalog item to a run by hand.

**Waiting on you, and nothing moves until you answer:**

- **B2** — which 4 ft vinyl panel is the default for every new client?
- **D1** — does a signature on the link count as the signed contract?
- **D2** — when a customer unapproves, does the agreed price fall away?
- **A4** — make one new job and tell me whether the deposit still reads zero.

---

## Raised today, 22 October

| | Status |
|---|---|
| Admin console shows "permission denied for table mail_platform_settings" | **DONE**, needs a publish |
| That error printed your access token on screen | **DONE**, needs a publish — and sign out and back in once |
| The console must answer your email only | **DONE**, live |
| Contract terms opens itself and is too long to scroll past | **DONE**, needs a publish |
| Payment methods you can receive, flexible | **OPEN** — my proposal is in `CHECK_LIST_2026-10-22.md` §6 |
| More ways to edit the logo than crop and wide | **OPEN** |
| The phone's Admin portal should have everything the web console has | **OPEN** — needs a pass through the eight screens with you |

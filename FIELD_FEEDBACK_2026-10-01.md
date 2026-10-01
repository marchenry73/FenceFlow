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

# Overnight, 19/20 November 2026

Written as I go. March asked for ~6 hours while he slept, starting 22:40.

**Limits I held to, in his absence:** no APK published, nothing a customer or
crew member sees changed, no money logic changed, no SQL that writes data, no
email sent. Anything in those categories is written up here instead of done.

---

## A4 — audit every money calculation, and prove it

This is the item he picked out as "highest priority, he gave figures". Three
auditors read three surfaces in parallel: the office web app, the Android app
outside the pricing engine, and the server (edge functions + money SQL).

**24 claims came back. None was treated as a bug on an agent's word.** Every
one was reasoned from source by an agent that ran nothing, and this project's
rule is that a finding nobody reproduced is not a finding.

**Where verification stands: 10 CONFIRMED in source, 1 DOWNGRADED to "not a
defect", the rest still claims.** Three of the confirmations corrected the
agent that raised them — #9's stated reason was wrong (the real mechanism is
narrower), #11 was nearly a much larger error and is not, and #13's worked
example needs a device to stand up while a simpler case does not. That is why
they get read rather than filed.

CONFIRMED means I followed it through the source myself and the wrong outcome
follows. It does NOT yet mean it has happened in his data: a read-only check
for that is queued behind the test suite, because concurrent database calls
are what make this suite report phantom timeouts.

### FIRST, THE THING THAT CHANGES HOW URGENT THE REST IS

**None of the payment bugs below has ever fired, because no real card payment
has ever completed through this system.** Checked read-only against
production:

- `job_payments` holds 29 rows. Every single `paid` row — all 7 — is
  `livemode = false`. There is not one `livemode = true` paid row, ever.
  (A first pass flagged "7 paid rows with no ledger row" and I nearly wrote
  that up as evidence of the lost-payment bug. It is not: test payments are
  *designed* never to touch the books, and the webhook says so in its own
  comment. Splitting by `livemode` is what showed it.)
- `payment_records` holds 3 live rows: two CARD rows totalling $19,204 dated
  **November and December 2025**, with a blank `recorded_by` — historical,
  predating this machinery — and one CASH row he recorded himself in
  September 2026.
- Square dispute reinstatements with no matching debit: 0. Links paid twice: 0.

So nothing has been lost and there is nothing to reconcile. **What these are
is latent: the first real customer who pays by card runs through code with
these four holes in it.** That matters this week, because the campaign starts
Tuesday and the point of it is customers.

That is also the honest limit of tonight's work: these are proved from source
and proved NOT to have happened, not proved to happen in production — nobody
has run a live card through the path to see.

### The four worth waking up for

These are the ones where the money leaves, or arrives and is not recorded.

1. **A second payment on the same Stripe link is taken but never booked.**
   **CONFIRMED IN SOURCE** (data check pending). Verified three things myself
   rather than taking the agent's word:
   - `create-payment-link/index.ts` contains no `restrictions`,
     `completed_sessions` or `max_sessions` anywhere — the link is reusable;
   - the only deactivation (`:449`, `active: "false"`) is on the REPLACEMENT
     path, and `stripe-webhook/index.ts` never calls it — grepping the webhook
     for "deactivate" returns nothing, so a paid link stays live;
   - `stripe-webhook/index.ts:444` guards on `pending.status !== "paid"`, so
     the second `checkout.session.completed` falls straight through, Stripe
     gets its 200, and no ledger row is written and nothing alerts.
   Effect: the customer pays a $2,000 deposit, reopens the emailed link and
   pays again. Stripe holds $4,000; the books say $2,000; nobody is told.
   This one harms the CUSTOMER, which is why it leads the list.

2. **A write failure on "mark paid" makes Stripe's retry skip the money.**
   **CONFIRMED IN SOURCE** (data check pending). `creditPaymentLink`
   (`stripe-webhook/index.ts:444-456`) sets `status="paid"` first, does not
   check that update's result, and only then calls `applyPaymentToJob`. I
   checked the half the agent did not: the top-level handler's `catch`
   (`:1314-1316`) returns **500**, so a throw does make Stripe retry — and the
   retry meets `status !== "paid"` and skips. The money is taken and never
   booked. `payment_intent.succeeded` has the same ordering (`:988`).
   The file's own comment says retrying is safe; it is safe only if the status
   flip comes last, and it comes first.

   *Not this:* the "$57,240 against a $10,595 contract" comment at `:195` is a
   different, already-fixed incident (test and live payments summed together),
   scoped by `livemode` since. I checked, because a historical overpayment
   note sitting next to this code invites exactly the wrong conclusion.

3. **The off-session balance charge can lose a race with its own webhook.**
   `create-payment-link/index.ts:1363` confirms the PaymentIntent and only then
   (`:1398`) inserts the pending row. `stripe-webhook/index.ts:984` does
   `if (!owed) break;` — a 200 with no retry. Claimed effect: an $8,000 balance
   charged and never booked.

4. **Square dispute WON books a credit that was never debited.**
   **CONFIRMED IN SOURCE.** Read the whole branch rather than the two lines
   quoted to me. At dispute OPEN the handler deliberately does not touch
   `amount_paid` ("most of these states haven't moved any money yet"); only
   LOST or ACCEPTED call `recordRefund` and write the negative row; and the
   WON branch upserts `+Math.abs(amount)` as a "chargeback reversed in your
   favour" payment record **with no check that a debit was ever recorded**
   (`square-webhook/index.ts:355-390`).
   So a dispute that goes OPEN → WON — the good outcome, the one where he
   keeps the money — writes a credit with no matching debit. A $5,000 payment
   disputed and won reads as $10,000 collected.
   Stripe does this correctly for comparison: it reinstates only after it has
   seen `funds_withdrawn`.
   The customer is not harmed (their balance floors at zero); his own
   collected-cash and profit figures are overstated.

### Also claimed, same audit — a figure a human reads is wrong

5. **Payment status walks backwards.** **CONFIRMED IN SOURCE.** Two writers,
   one column, different rules: `stripe-webhook/index.ts:265` writes
   `payment_status: "DEPOSIT_PAID"` unconditionally, while the shared recorder
   Square uses (`_shared/record-payment.ts:185-192`) computes a rank
   (UNPAID 0, DEPOSIT_PAID 1, PAID_IN_FULL 2) and only ever raises it.
   So a $50 Stripe payment on a job already PAID_IN_FULL steps it back to
   DEPOSIT_PAID, and a final Stripe balance payment leaves a settled job
   reading DEPOSIT_PAID.
   PARTIAL MITIGATION, in the webhook's own comment: "The app promotes this to
   PAID_IN_FULL once the amount actually covers the total." So the phone may
   correct it — which fixes the understated half and not the walked-backwards
   half, and leaves the office and quote page reading whatever is in the column
   until a phone gets to it. The shared recorder exists precisely to stop this;
   the Stripe path simply does not use it.
6. **An approval with no server price freezes a partial price.**
   **CONFIRMED IN SOURCE, with one mitigation that does not cover it.**
   - `quote-view/index.ts:643`: when the server has not priced the job
     (`money.total` 0) the page total falls back to `roundToCents(subtotal + tax)`
     — the material lines and tax, with no labour, gates, markup or discount.
   - Nothing refuses that approval. The "a price that collapsed must not become
     the agreed price" guard below it only refuses a figure BELOW one the
     customer has already agreed to, so it cannot fire on a FIRST approval, and
     `pricedLines` is used only inside that refusal's message.
   - `billableTotal` (`_shared/quote-deposit.ts:133-143`) then returns
     `accepted + extra` and never looks at the live `contractTotal` again.
   So: materials and tax come to $4,280, the real price with labour is ~$8,000,
   the customer approves $4,280, and the balance link bills $4,280 for ever.
   **THE MITIGATION, and its hole:** `reapproval_on_drawing_change` fires on
   INSERT/UPDATE/DELETE of `fence_runs` — so if he prices the job by drawing or
   changing a run, re-approval is raised and the anchor is released. It does
   NOT fire when a job that already has its runs is simply priced for the first
   time (that writes line items and `contract_total`, not runs). That is
   exactly the path this finding describes.
7. **`deposit_amount` is not frozen at approval** the way `accepted_total` is.
   **CONFIRMED IN SOURCE.** `supabase_r67_deposit_follows_the_materials.sql`
   computes `customer_is_in_it` (approved or signed with no re-approval
   pending, or money already paid) and, when true, `return new` — which stops
   the AUTOMATIC rule from recomputing the deposit and does nothing at all
   about a typed one. No trigger pins the column the way the quote-gate
   columns are pinned, and `depositFigures` caps the figure only at the total.
   So a customer who approved a $2,000 deposit can be asked for $6,000 by an
   edit in the office, with no new approval and nothing saying it changed.
   Most likely to bite as a typo rather than as intent.
8. **A change order is worth a different amount depending on when it was
   signed.** The engine marks change orders up (inside `preMarkup`); the
   anchored total adds them raw after acceptance. Same $1,000 order is $1,100
   before acceptance and $1,000 after.
9. **Two "paid" sources disagree.** **CONFIRMED, but the audit's reason for it
   was wrong and the real one is narrower.** I was told the aging list "does
   not floor"; it does — `outstandingFromLedger` (`dashboard.html:19327`) is
   `Math.max(0, contract - paid)`, same as `stillOwed`. The divergence is one
   level down, in what "paid" means:
   - `netPaid` (`:11748`) is `max(0, amount_paid - refunded_amount)` — the PAID
     figure itself is floored at zero;
   - the ledger's is `b.paid += a` over `payment_records` with refunds stored
     as negative rows (`ledgerByJob`, `:19287-19293`) — not floored, so it can
     go below zero.
   With $200 paid and $300 refunded: netPaid is 0, so the tile says the whole
   contract is owed; the ledger is −$100, so the aging row says contract plus
   $100. They differ by $100 on the same job.
   Reachable mainly where a chargeback or an over-refund exceeds what was
   taken. Worth recording less for its size than for its shape: two routes to
   one figure, which is the family most of tonight's confirmed findings belong
   to.
10. **Reports profit mixes cash and job-date bases** — payments counted when
    received, costs counted when the job is dated — so a deposit for next
    quarter's job reads as ~100% margin this quarter.
11. **Reports material cost omits tax and change-order materials; Reports
    labour has no overtime.** **CONFIRMED, after ruling out something worse.**
    I first suspected the material figure was the SELL price rather than cost,
    which would have been a far bigger error. It is not:
    `lineTotal = quantity * (supplierUnitPrice ?: unitPrice)`
    (`Entities.kt:1039-1041`), and the catalog price is his cost basis with
    markup applied above it — which is why the quote page deliberately hides
    the subtotal. So it is a cost figure, correctly preferring the real
    supplier invoice price when one exists.
    What stands: `materialsByJob` (`ReportsViewModel.kt:285`) sums `lineTotal`
    only — no tax, and no change-order materials — while `JobMoney` elsewhere
    treats materials tax as spend. Two definitions of what a job cost.
    And `laborCost = payableHours * hourlyRate` (`Entities.kt:1510`) has no
    overtime multiplier, while the crew pay screen applies 1.5x after 40 hours
    in a week. 50 hours at $20 is $1,000 on Reports and $1,100 on crew pay.
    Both push reported profit the same way: too high.
12. **Bulk catalog price change rounds to whole dollars.** **DOWNGRADED after
    checking it myself — I do not think this is a defect.** The arithmetic is
    as reported (`catBulkNewPrice`, `dashboard.html:18122`: `Math.round(raw)`,
    so +10% on a $0.60 item is $1.00, a 67% rise). But two things the audit did
    not mention: dollar rounding is a mode HE CHOOSES in a dropdown, and
    `catBulkBuildPlan` builds a preview of every from→to row with a separate
    Apply button, so nothing changes until he has looked at the list. It also
    already skips unpriced rows and anything that would round to zero.
    Worth knowing that cheap parts move a long way in percentage terms when he
    picks that mode. Not a bug, and I am not proposing a change.
13. **Money inputs that save $0 instead of refusing.** **CONFIRMED, with the
    claim narrowed.** `AddExpenseDialog` (`JobDetailScreen.kt:3976`) has a
    Button with no `enabled` guard at all and takes
    `amountText.toDoubleOrNull() ?: 0.0`; the change-order dialog is the same.
    The refund dialog three hundred lines away has
    `enabled = amount > 0.0 && !tooMuch` — so the app already knows how to do
    this, inconsistently.
    What is CERTAIN: leaving the amount blank and pressing Add saves a $0
    expense, silently. What I would NOT claim without a device: the audit's
    "1,250.00 saves as $0" example — the field sets
    `keyboardType = KeyboardType.Decimal`, so whether a comma can be typed at
    all depends on the keyboard and locale. The empty-field case needs no
    comma and is enough on its own.
    A $0 expense makes a job look more profitable than it was.
14. **No overpayment guard** when recording a payment by hand, and **no sign or
    finite guard** on custom line items (a quantity of -5 lowers the total).

### The fixes I would make, written out and NOT applied

His instruction was that money behaviour waits for him. These are ready to
apply on a yes; each is small, and each has the test I would write with it.

**#2, the lost payment on retry — fix first, it is the smallest and the
safest.** Move the status flip to AFTER the booking, and check that it wrote:

```
await applyPaymentToJob(admin, pending);          // book it first
await mustWrite("mark the payment paid",          // then flip, and check
  admin.from("job_payments").update({ status: "paid", ... }).eq("id", pending.id));
```

Then a retry that arrives after a half-done attempt re-books (the ledger upsert
is keyed on the processor's id, so re-booking is a no-op rather than a double
credit — which is what makes this ordering safe). Same change at `:988` for
`payment_intent.succeeded`. Test: call the handler twice with the booking
failing the first time, and assert the ledger holds exactly one row of the
right amount.

**#1, the reusable link.** Two independent halves, and I would do both:
`restrictions: { completed_sessions: { limit: 1 } }` when creating the Payment
Link, so Stripe itself refuses the second checkout; and, in the webhook, when a
`checkout.session.completed` arrives for a link already `paid`, stop returning
a silent 200 — record it as an unexpected second payment and notify, so the
money is visible even if the first half ever fails. Test: a second completed
session on a paid link produces a visible record, not silence.

**#4, the Square phantom credit.** Only reinstate what was actually taken away:

```
if (state === "WON") {
  // only if a dispute debit for THIS dispute exists
  const prior = await admin.from("payment_records")
    .select("sync_id").eq("sync_id", "dispute-" + disputeId).maybeSingle();
  if (prior.data) { ...write the reinstating row... }
}
```

That mirrors what Stripe already does (it reinstates only after it has seen
`funds_withdrawn`). Test: OPEN → WON writes nothing; OPEN → LOST → WON nets to
zero.

**#5, the status that walks backwards.** Delete the flat
`payment_status: "DEPOSIT_PAID"` from the Stripe path and route it through
`_shared/record-payment.ts`, which already has the ladder and is what Square
uses. This is a deletion plus a call, not new logic. Test: a $50 payment on a
PAID_IN_FULL job leaves it PAID_IN_FULL.

**#6 and #7 are decisions, not fixes.** #6 (approving a job the server has not
priced) could refuse the approval outright, or could release the anchor when
the job is later priced — the first is safer for him, the second is kinder to
the customer, and which one he wants is his call. #7 (the deposit changing
after approval) is the same shape: pin the column, or allow the edit and tell
the customer it changed. I have not chosen either on his behalf.

### What the audits found CLEAN

Worth recording, because an audit that only lists faults tells you nothing
about coverage:

- Cents vs dollars is handled correctly everywhere the server audit looked,
  including both Stripe and Square paths.
- Refund and dispute rows are keyed on the processor's own ids.
- The `accepted_total` stamp trigger and the "first approval wins" guard
  (`.is("quote_approved_at", null)`) hold up.
- No `==`/`===` float comparisons on money in the office; thresholds use a
  half-cent epsilon.
- No `toFixed()` followed by further arithmetic; it is output-only.
- Phone and server deposit figures agree.
- Payment-link rounding is correct on the phone.

---

## Fixed tonight

### a110 went red, and the red was mine

`e55e554` (the trial-extend fix, pushed before he slept) replaced the two fixed
"+1 day"/"+14 days" actions with one dialog. `tests/a110-admin-company-actions`
pinned the old literals and a region running "from the first OutlinedButton to
`pending?.let`", so it broke.

**The properties it guards are all still true** — verified in the source as it
stands: the extension re-reads the list from the server and surfaces failures,
and no button that acts on an existing company calls the repository without
asking.

Two wrong fixes were tried first, and both are recorded in the file because
they are the interesting part:

- Ending the region at the first `?.let` lands on an inline `actionError?.let`
  inside the add-company form — BEFORE the per-company buttons. The check then
  passed while reading a region with none of the buttons it names. **A green
  that checked nothing**, which is worse than the red it replaced.
- Asserting "no button may call the repository" forbids the add-company button,
  which correctly calls `createCompany` from its own onClick. That version
  reported correct code as broken.

The fix abandons file-position slicing: each `OutlinedButton` is examined as
its own window, bounded by the next button or the next dialog, and only the
three actions that reach into an existing company are forbidden. A floor on the
number of buttons found stops it going quiet. 6/6, and its sabotage canary
bites.

**Process note for March:** I pushed `e55e554` after running the Kotlin suite,
but a110 is a *website-suite* test that greps Kotlin source — so it never ran.
A Kotlin UI change can break the website suite. Both suites, every time.

**Second process note, this one a mistake I made twice in an hour.** I started
a second full website suite while the first was still running. Both then
reported a TIMEOUT, and *different files each time* —
`shift-answer-and-followup-settings` in one, `a165-cancellation-figure-is-frozen`
in the other, which had passed in 93s earlier the same night. That is
contention, not a defect; the suite has a 180s per-file limit and this project
has been fooled by exactly this before. Neither run counts, and the figures in
them should not be quoted. The rule is in CLAUDE-adjacent memory already and I
broke it anyway: **one suite at a time, nothing else running.**

---

## Needs March

0. **The four payment fixes, before the first real card payment.** They are
   written out above and not applied. Nothing has been lost so far only
   because no live card has ever gone through — and the campaign that starts
   Tuesday is for getting customers who will. #2 is the one I would do first:
   it is a two-line reordering, it is the one that silently loses money that
   was actually taken, and it needs no decision from him.

1. **The FenceFlow name, before Tuesday.** fenceflow.com is a live FenceFlow
   LLC in fencing; 62 emails carry the name from Tue 24 Nov, 11:30am.
2. **Tan corner post and trim prices** from Noelle. Until they exist, a tan
   fence honestly cannot be fully dressed — and as of 1.895 the app says so to
   whoever picks Tan.
3. **Summit Landscapes** (signed up 27 Oct, locked out, never came back). The
   new "Give time" dialog can grant them a month in two taps.
4. **The four payment findings above**, once I have confirmed or killed them.
   Anything that changes money behaviour waits for him by his own instruction.
5. **B1's last hop**: sign in on a second phone and check the first drops to
   the signed-in-elsewhere screen WITHOUT being reopened. Everything behind
   that hop is verified on production; only FCM-to-a-real-handset is not.

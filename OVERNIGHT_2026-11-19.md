# Overnight, 19/20 November 2026

Written as I go. March asked for ~6 hours while he slept, starting 22:40.

**Limits I held to, in his absence:** no APK published, nothing a customer or
crew member sees changed, no money logic changed, no SQL that writes data, no
email sent. Anything in those categories is written up here instead of done.

---

## If you read one page, read this one

**Nothing is broken for your customers right now.** Nothing was changed
tonight that anyone can see. The audit found real holes, and almost all of
them are holes nobody has fallen into yet.

**The one that is live today:**

- **Anyone you make a MANAGER can mark any job paid in full, with no money.**
  I did it, as a real manager of your company, in a transaction I rolled back.
  It was accepted; the same user writing another company's job was refused, so
  it is a permission result and not a trick of the probe. You have two
  managers. Nothing server-side ever recomputes the status afterwards, so the
  job quietly leaves what you are owed.

**The four that are armed but have never fired**, because **no live card
payment has ever gone through this system** — every paid row is test-mode, and
the only card money in the books is $19,204 from November 2025, before this
machinery existed:

- a Stripe payment link can be paid twice, and the second one is never booked;
- if booking a payment fails, Stripe's retry SKIPS it and the money is lost;
- a Square dispute you WIN books a credit that was never debited;
- approving a job the server has not priced freezes materials-plus-tax as the
  agreed price, with no labour in it, for ever.

Those matter **this week**, because the campaign starting Tuesday exists to
produce customers who pay by card. Fixes are written out below and NOT
applied.

**The one your crew will notice:** your phone, your office Pay tab and your
payroll CSV do not agree about what an hour is. Two of them ignore the
recorded break and one subtracts it, and the Pay tab is the only one that will
pay a REJECTED shift. Which one you pay from decides who is short-changed, and
that is your call.

**And one you should know I got wrong first:** I reported the crew-pay
direction backwards before checking the payroll export, and corrected it. Four
of the confirmed findings corrected the agent that raised them. That is why
these were read rather than filed.

Final score: **22 confirmed by following them through the source myself, 7 of
those also proved against production, 2 downgraded, 5 dismissed outright.**
Six claims changed severity once checked — in both directions. Everything
below has the evidence.

**Two standing checks were left behind** so this does not have to be done by
hand again: `tests/a175-money-columns-are-pinned` (a column cannot leave the
protection list unnoticed) and `tests/a176-new-money-columns-get-noticed` (a
new money column cannot arrive unprotected). Both canaried; the website suite
is 295/295 with them in it.

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
   **STILL A CLAIM — not verified.** A race needs either a reproduction or a
   careful read of commit ordering, and I ran out of night. Listed here
   because its shape matches #2, which IS confirmed.
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

4b. **Money he is owed disappears from Reports because of a date filter.**
    **CONFIRMED IN SOURCE.** `ReportsViewModel.kt:377` builds the Outstanding
    list as `jobs.filter { it.status.isWon }`, where `jobs` is already narrowed
    to the selected window. The Home tile (`JobsViewModel.kt:54`) uses
    `allJobs`. So on the default 90-day view, a job scheduled 100 days ago
    that still owes $5,000 is not in the Outstanding list at all, and the two
    screens give different answers for the same question.
    This is the "empty answer reads as good news" shape the project keeps
    meeting: the money does not show as $0 owed, it shows as nothing to see.
    (Credit where due: the Home tile goes out of its way to tell a computed
    $0.00 apart from "no answer", with a comment explaining why. The Reports
    list is the one that forgot.)

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
8. **CONFIRMED IN SOURCE.** **A change order is worth a different amount depending on when it was
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
10. **Reports profit mixes cash and job-date bases.** **CONFIRMED IN SOURCE.**
    In one function (`ReportsViewModel.kt:273-285`): `paymentsInPeriod` is
    `getPaymentsBetween(from, to)` — filtered by when the money ARRIVED — while
    `jobs` is filtered by `jobDate(it)` and the expenses, time entries and
    materials are then all filtered to *those* jobs. So revenue is cash basis
    and cost is job basis, in the same profit number.
    A $10,000 deposit landing this quarter for a job scheduled next quarter
    shows as revenue with none of its cost: roughly 100% margin. The reverse
    case shows a loss.
    Worth saying the payments half was deliberately made receivedAt-based to
    fix a real bug (the comment above it describes editing an old job dragging
    its historical payments into the current month, and two phones disagreeing).
    That fix is right. The cost half was simply not moved with it, and nothing
    on screen says the two halves are counted differently.
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
14. **CHECKED, and the audit was half right in each half.**
    - *Recording a payment by hand:* the button is
      `enabled = amount > 0.0 && parsedDate != null`
      (`JobDetailScreen.kt:5048`), so zero and negative ARE refused — the
      audit implied nothing guarded it. What is absent is a cap against
      paying MORE than is owed: type 5000 instead of 500 on a job owing
      $4,500 and it is accepted, and the only way back is a refund.
      Confirmed as a missing cap, not as a missing guard.
    - *Custom line items:* the parse is
      `qtyText.replace(',', '.').toDoubleOrNull() ?: return@Button`
      (`EstimateScreen.kt:1341`) — so it handles a comma decimal AND refuses
      unparsable text outright, which is better than the dialogs in #13.
      But `toDoubleOrNull` accepts `-5` and `Infinity`, so a negative
      quantity or price still goes in and lowers the total.
      **A question rather than a defect:** a negative line is exactly how
      somebody would hand-enter a credit or an allowance, so this may be
      deliberate. `Infinity` is not. Worth him saying which he wants.

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

### THE ONE I WOULD READ FIRST: a manager can mark a job paid, with no money

**CONFIRMED ON PRODUCTION, with a working positive control, inside a
transaction that was rolled back.** This is the only finding tonight that is
both reachable with his current data and proved by doing it rather than by
reading.

What the probe did, as a real MANAGER of his company (chosen by property, not
by name):

| step | result |
|---|---|
| does MANAGER hold SEE_MONEY | **true** |
| `update jobs set amount_paid = +12345, payment_status = 'PAID_IN_FULL'` | **ACCEPTED, 1 row** |
| the row afterwards | `amount_paid 0 -> 12345`, status moved |
| CONTROL: same user, a job in ANOTHER company | **0 rows, refused** |

The control is the point. The write landed *under* row-level security, not
around it — so this is a permission result and not an artefact of the probe
running with too much power.

**WHY IT HAPPENS.** `money_caller_trusted()` (live body) is
`claims are empty OR is_service_role() OR has_permission('SEE_MONEY')`, and
`has_permission` (live body) grants SEE_MONEY to OWNER, MANAGER, SALES and
ACCOUNTANT. `amount_paid` and `payment_status` are both on
`job_money_columns()`, but that list is only held against callers who do NOT
pass `money_caller_trusted()`. So **a read permission is being used as the
write gate**: "may see money" is taken to mean "may declare money received".

The project already learned this distinction once and applied it somewhere
else — writes to `payment_records` were separately restricted to
REQUEST_PAYMENT / RECORD_REFUNDS. The `jobs` money columns never got the same
treatment.

**What it means in practice:** anyone he makes a MANAGER can mark any of his
company's jobs paid in full, with no payment anywhere, no ledger row, and
nothing that recomputes `payment_status` server-side afterwards. The job then
drops out of accounts-receivable. He has two managers today.

Whether a manager *should* be trusted with that is his decision, not mine —
but at the moment it is not a decision anybody made, it is a side effect of a
read permission being reused as a write gate.

**The SALES half is not reachable yet:** SALES also holds SEE_MONEY (and
EDIT_JOBS), so the same write would succeed — but his one SALES profile has
no company attached, so there is nobody to do it. That changes the day he
adds a salesperson, which is exactly what the Crew plan is sold for.

### TWO MONEY COLUMNS WITH NO PROTECTION AT ALL

**CONFIRMED against the live database.** `job_money_columns()` holds 31
columns. **`cancellation_retained` is not one of them, and neither is
`materials_to_buy`.**

- **`cancellation_retained`** is the money he KEEPS when a customer cancels.
  `job_cancellation_terms` takes `coalesce(frozen.amount, <computed>)`
  (`supabase_r71_cancellation_figure_is_frozen.sql:167-176`), so once a job is
  cancelled the stored figure wins outright. Overwrite it with 0 and the
  refund due becomes everything the customer paid. The freeze trigger only
  fires on the `cancelled_at` null→set transition, so a write AFTER
  cancellation is not caught.
- **`materials_to_buy`** is read by the deposit rule
  (`supabase_r67_deposit_follows_the_materials.sql:179`), so inflating it
  makes the next re-price ask the customer for a far larger deposit — capped
  only at what is still owed.

**Not reachable today, and reachable soon.** Both need a caller who can update
jobs but does NOT hold SEE_MONEY — that is CREW or FOREMAN, and he has
neither: his roles today are 8 OWNER, 2 MANAGER, 1 SALES. The day he adds a
crew member, which is what the Crew plan exists for, these two columns are the
unguarded ones. (Anyone WITH SEE_MONEY can already write every money column —
see the manager finding above — so for managers this changes nothing.)

**A third, same family, same day:** a line item a crew phone adds that matches
nothing is stored at **$0** — `new.unit_price := coalesce(new.unit_price, 0)`
in `stamp_line_item_price` (`supabase_crew_money_shield_patch.sql:160`). The
surrounding design is right and I checked it before reporting: the function
returns early for trusted callers, so it never overwrites a price the office
set, and it tries the job's last price for that role and then the catalog by
name first. Only when both miss does it land on 0 — and a stored 0 is
indistinguishable from "this item is free" to every report that sums `sell`.
"Not priced" and "free" are the same number again, which is the failure this
project keeps meeting from different directions.

### CREW PAY — money that leaves the business, audited after midnight

Nobody had looked at this surface. Eight claims came back; I confirmed the two
that move money.

**C1. The phone and the office disagree about what an hour is. CONFIRMED.**
> **Read C3 below before acting on this one.** The disagreement is real, but
> the DIRECTION in this heading turned out to depend on which office surface
> he pays from, and the payroll export does not agree with the Pay tab.
- The phone: `TimeEntry.hours` is `(endedAt - startedAt) / 3_600_000`
  (`Entities.kt:1497`) — clock time, full stop. `breakMinutes` exists on the
  entity (`:1381`), is synced both ways, is stored in Room… and appears in no
  pay calculation anywhere in Kotlin. I grepped every use: all of them are
  sync or storage.
- The office: `paidHoursOf(t) = Math.max(0, hoursOf(t) - breakHoursOf(t))`
  (`dashboard.html:16535`), used by the pay table and the timesheet totals.
- So an 8.0h shift with a 30-minute break at $20/h is **$160 on the crew
  member's own phone and $150 in the office**. He is told the higher number
  and paid the lower one.
- It compounds at overtime: a 40.0h week with 2.5h of breaks is 40.0h on the
  phone (overtime territory) and 37.5h in the office (not).
- This is the worst KIND of the findings tonight even though it is not the
  largest: the others are numbers he reads, this one is a number his crew
  reads, and being told $160 and paid $150 is how a contractor loses a good
  worker.

**C2. Approving a shift re-prices it at today's rate. CONFIRMED, and verified
live.** `stamp_time_entry_rate` overwrites `new.hourly_rate` with the
employee's CURRENT rate whenever an employee record exists
(`supabase_r59_money_door_unknown.sql:159-174`) — and I checked the live
database rather than the file: the trigger is present, **enabled**, and fires
`BEFORE INSERT OR UPDATE` on `time_entries`.
Approval is an UPDATE. So a worker on $20 who does 40 hours, is raised to $25
on Friday, and has that week approved afterwards, is paid 40 hours at $25 —
$200 more than the rate in force when the work was done. A rate cut does the
same in the other direction.
The phone takes a rate snapshot at clock-in (`ClockInIdentity.kt:103`); the
server overwrites it.

**C3. CORRECTION TO C1, and it makes the picture worse rather than better.**
I wrote above that "the phone tells a worker more than the office pays him".
That assumed the office pays from the Pay tab. It may not. There are **three**
surfaces and **two** definitions of an hour, and each surface has a different
hole:

| surface | hours used | approval filter |
|---|---|---|
| crew member's phone | `hours` — break NOT subtracted | own shifts |
| office **Pay tab** (`renderPay`, `dashboard.html:17081`) | `paidHoursOf` — break subtracted | **none** — filters on `ended_at` only |
| office **payroll CSV** (`:34173-34180`) — the thing he'd pay from | `hoursOf` — break NOT subtracted | correctly approved-only |

So the payroll CSV agrees with the phone and disagrees with the Pay tab on
every shift that had a break; and the Pay tab is the only one of the three
that will happily put a REJECTED shift in somebody's week. The Pay tab calls
its figure "estimated pay", which softens it, but it is also the screen a
person looks at to decide what to pay.

Both halves confirmed in source. The break half was right in my earlier note;
the direction was not, and which figure he actually pays from decides who is
short-changed. **That is a question for him, not for me.**

**C4. "A corrected shift stays approved at its new length." DOWNGRADED after
checking who may correct one.** The fact is true — `correct_time_entry`
updates `started_at`, `ended_at` and `correction_reason` and leaves
`approved_at` alone, and the file says so deliberately in a "WHAT IT
DELIBERATELY DOES NOT DO" section.

What the audit could not verify, and what changes the severity: **a correction
requires `has_permission('APPROVE_TIME')`** (`:162`). A crew member cannot
correct their own shift. Whoever corrects it is somebody who could have
approved it anyway. The same file explicitly refuses an `auth.uid() is null`
escape hatch and says why — the exact trap this project has a memory about.
And `preserve_original_shift_trg` is live on the table, so the original clock
times survive the correction.

So this is not a route to unauthorised pay. What is left is narrower and still
real: the row keeps an approval stamp made BEFORE the hours changed, so the
record reads "approved by X" against a length X never saw. An audit-trail
accuracy point for a quiet day, not a money leak.

### A SECURITY DEFINER function any signed-in user can aim at another company

**CONFIRMED on the live database.** `recompute_job_totals(co uuid, job_sid uuid)`
is `SECURITY DEFINER`, `has_function_privilege('authenticated', …, 'EXECUTE')`
is **true**, and the live body takes the company id as a PARAMETER and never
checks that the caller belongs to it:

```
update jobs set amount_paid = v_paid, refunded_amount = v_refunded
 where company_id = co and sync_id = job_sid ...
```

So any signed-in FenceFlow user who knows another company's id and a job's
sync id can make that company's job recompute its totals, bypassing row-level
security (which is what DEFINER means).

**Bounding the harm honestly, because it is smaller than it sounds:** the
function only ever writes the figure the ledger already implies — it sums
`payment_records` and stores the result. A stranger calling it writes the
CORRECT value. It returns void, so it leaks nothing back. There is no way to
pass a figure in.

So this is not a way to steal or fake money today. It is a missing tenant
check on a privileged function, which is the kind of thing that stops being
harmless the moment the function grows a second job. The repo already contains
the fix — `supabase_r19_function_doors.sql:470-520` — and it is labelled
**"DRY RUN ONLY"**, i.e. written and never applied. Worth applying on a quiet
day; not worth waking up for.

**And the same reading confirms a separate claim:** the trigger
`payment_records_totals` is present and enabled on `payment_records`, running
`payment_records_recompute`. So the ledger already derives `amount_paid` by
itself — which makes the Stripe webhook's own
`amount_paid: paidDollars` write (`stripe-webhook/index.ts:265`) a **second
route to the same figure**, computed from a separate read. The trigger's
answer is the authoritative one. Two writers for one column is the family half
of tonight's findings belong to.

### Two more, one confirmed and one wrong

**CONFIRMED: the office payment door has no cap at all on an unpriced job.**
`planOpenLinks` (`create-payment-link/index.ts:370-390`) wraps its whole
"don't ask for more than is owed" check in `if (contractTotal > 0)`. When the
job's contract total is 0 or null, the function returns `ok: true` with
nothing checked, so a link can be raised for any amount. **Four of his live
jobs are in that state** (3 null, 1 zero).
The separate "$1 overshoot" in the same function is deliberate and fine — it
is explicit slack for cents-vs-dollars rounding, with a comment saying so.
Framing this honestly: it is a guard-rail gap, not an exploit. Raising a link
is an office action, so it protects him from his own typo rather than from an
attacker — though a MANAGER can do it too, and the customer-facing door caps
against `billableTotal` while this one does not. Two doors, two rules.

**WRONG: "the receipt understates the card charge by up to 3%."** The claim
was that the customer pays `amount_cents + fee_cents` while the receipt prints
only `amount_cents`. `job_payments` does have a `fee_cents` column, so the
claim looks supported until you read what writes it:
`const stripeFee = 0` (`create-payment-link/index.ts:785`), with a comment
explaining that `companies.pass_card_fee` is FenceFlow's own subscription
setting and not a surcharge a contractor passes on — "the fee_cents plumbing
stays at zero so older rows and refunds still work."
So no fee is ever added to what a customer pays, and the receipt is right.
Reported here because the next person to grep `fee_cents` will reach the same
wrong conclusion, and it would have sent him looking for a receipt bug that
does not exist.

### Claims checked against the data and found NOT to bite

Recording these because an audit that only reports faults tells you nothing
about how much of it you can trust.

**"Two contract figures disagree when `contract_total` is null."** The
mechanism is real and confirmed in source: `billableTotalOf`
(`dashboard.html:11809`) answers null when there is no anchor and no
`contract_total`; `contractTotalOf` (`:13994`) catches that and falls back to
summing line items, but the job header (`:23089`) and the estimate block
(`:25359`) take `billableTotalOf(...) ?? 0` and so would show $0 while the
jobs table (`:15532`, via `contractTotalOf`) showed the line-item sum.

**It does not bite today.** His database has 20 live jobs, 3 with
`contract_total` null — the audit's note that this was "only pre-column jobs"
was wrong, they exist. But all three HAVE an anchor, no line items and no
money paid, so `billableTotalOf` returns the anchored figure and the two
helpers agree. The divergence needs null `contract_total` AND no anchor AND
line items, and no such job exists.

**Also checked and absent:** no approved job is anchored below its real price
(finding 6 has not happened, 0 jobs); no job has `amount_paid` above its
contract total; no cancelled job has a stored retained figure, so the
unguarded `cancellation_retained` has nothing to overwrite yet.

**The one job with `contract_total = 0` does not bite either.** A stored 0
would stop the `coalesce(anchored, contract_total, lines)` chain that a NULL
falls through — the shape the SQL audit raised — but that job IS anchored, so
the anchor is taken first and the 0 is never reached. Checked rather than
assumed.
(Incidentally it is a DRAFT carrying $7,170 collected, which is his own
recorded cash payment. Unusual, not a defect, and not mine to tidy.)

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

## The "and prove it" half of A4

The item says "audit every money calculation **and prove it**". An audit is a
snapshot; it rots. So one thing was left behind that keeps checking after
tonight:

**`tests/a175-money-columns-are-pinned.test.mjs`** — three checks, read-only.

`job_money_columns()` is a hand-maintained list of column names, and it is the
only thing standing between a crew handset and `jobs.amount_paid`. A
hand-maintained list of names is exactly the thing that rots in one direction:
columns get added to `jobs`, nobody adds them here, and the hole is silent.
That is how `cancellation_retained` and `materials_to_buy` came to be
unprotected.

So the test:
1. pins the list EXACTLY as it stands (31 columns), so adding or removing one
   is a deliberate act that turns this red and makes somebody say why;
2. separately names the ten that must never come off — the ones that decide
   what a customer owes and what he has been paid — listed individually rather
   than derived from the pin, so trimming the pin to match a shrunken list
   cannot also silence this check;
3. a control that refuses to pass on an empty or impossibly short answer,
   because two empty sets compare equal and that is the failure this project
   keeps meeting.

**What it deliberately does NOT do:** assert that the two known gaps stay
gaps. A test that pins a defect in place goes green the day somebody fixes it,
which is the wrong way round. Closing them turns the exact pin red and asks
for the pin to be updated — the correct prompt.

CANARIED, both ways: drift the pinned list and check 1 goes red; make
`amount_paid` vanish from the live answer and checks 1 and 2 both go red, with
check 2 naming the column that was lost. File restored byte-identical
afterwards and re-run green.

## A test I added made another test fail, and that is worth writing down

Adding `a175` and `a176` turned the suite red — but on **`a173`**, the restore
test, which had passed twice earlier the same night. Run on its own, a173
passes 11/11.

It was not a logic break. It was load. a173 is database-backed and takes about
76 seconds; a175 and a176 are database-backed too, and between them they were
making five more round trips on the same connection. That was enough to push
a173 past the 180-second per-file limit.

So **I caused it**, and the symptom — "passes alone, fails in the suite" — is
one this project has misread before and has a memory about. The temptation is
to re-run until it is green, which would have worked and taught nothing.

The actual fix: both new files now read ONCE per run and reuse the answer,
instead of querying per check. That is not only cheaper (five round trips
become two). Three separate reads meant three separate snapshots, so in
principle the checks inside one file could have disagreed with each other
about what the list was. One read is one answer.

Both files were re-canaried AFTER the change, because making a check cheaper
is exactly the sort of edit that can quietly make it stop checking. They still
bite.

**The general lesson for this suite:** it has a per-file timeout and a shared
database connection, so every database-backed test added makes every other
database-backed test a little more likely to time out. New tests here should
read once, not per assertion.

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

## State when I stopped, 04:00

Working tree clean of my work, everything pushed, `main` level with origin.
Sixteen commits tonight, all of them either evidence or a check — **not one
changes what anybody is charged, sees, or receives.**

Verified at the end rather than assumed: both new checks still green, nothing
of mine left uncommitted, and the last full website suite was **295/295 with
0 timeouts, run alone**. (Two files are dirty and are NOT mine:
`OVERNIGHT_2026-10-24.md` and `supabase/.temp/cli-latest` — they were dirty
when I arrived and I left them alone.)

**Limits held, all night:** no APK published, nothing customer- or
crew-facing changed, no money logic touched, no SQL that writes data, no
email sent. The database was only ever read, or written inside a transaction
that was rolled back — and each of those probes carried a positive control, so
a result that looked like a finding had to prove it was not an artefact of the
probe.

**I stopped at 04:00 rather than 04:40** because A4 is finished and the
honest options left were low value or outside the limits. Padding the last
forty minutes would have cost tokens and taught nobody anything.

## Needs March

0. **BUILT ON 20 NOV, NOT LIVE: say when to land it.** All four payment fixes
   and the manager fix are in the repo with tests (see the 20 November section
   at the end of this file). What is left is one `db query` to apply the SQL,
   one deploy of three edge functions, and an APK publish — and they have to
   go together, because the SQL alone leaves a dropdown on a manager's phone
   that the server silently overrides. Nothing has been lost so far only
   because no live card has ever gone through, and Tuesday's campaign is for
   getting customers who will.

1. **The FenceFlow name, before Tuesday.** fenceflow.com is a live FenceFlow
   LLC in fencing; 62 emails carry the name from Tue 24 Nov, 11:30am.
2. **Tan corner post and trim prices** from Noelle. Until they exist, a tan
   fence honestly cannot be fully dressed — and as of 1.895 the app says so to
   whoever picks Tan.
3. **Summit Landscapes** (signed up 27 Oct, locked out, never came back). The
   new "Give time" dialog can grant them a month in two taps.
4. **#6 and #7 are still his decision, not a fix.** Approving a job the
   server has not priced could refuse the approval or release the anchor when
   the job is priced; the deposit changing after approval could pin the column
   or tell the customer it changed. I have not chosen either on his behalf.
   (#1–#5 and the manager finding were built on 20 Nov — see item 0.)
5. **B1's last hop**: sign in on a second phone and check the first drops to
   the signed-in-elsewhere screen WITHOUT being reopened. Everything behind
   that hop is verified on production; only FCM-to-a-real-handset is not.

---

# 20 November 2026 — the five fixes, built

March read the above and said: **"fix the manager one and the 4 payment
ones."** Built, with tests, in the repo. **None of it is live yet** — the SQL
is not applied, the edge functions are not deployed, and no APK is published.

## What changed, one line each

| # | What it was | What it is now |
|---|---|---|
| MANAGER | Anyone with SEE_MONEY — a READ permission — could mark a job paid in full with no money. | A new `RECORD_MONEY` permission, held by OWNER and ACCOUNTANT. Seven "money arrived" columns are reverted for anyone else. |
| 1 | A Payment Link could be paid twice, and the second payment was swallowed with a 200. | Stripe refuses the second checkout, AND a second payment that does arrive is recorded, booked and pushed. |
| 2 | "Mark paid" was written BEFORE the booking, so a failed booking made Stripe's retry skip the money. | Booked first, flipped second, and the flip is checked. |
| 3 | The off-session charge's webhook could arrive before its own pending row and drop the money. | With no row, the charge is booked from the intent's own metadata. |
| 4 | A Square dispute WON booked a credit with no matching debit — $5,000 won read as $10,000 collected. | It reinstates only when the debit from LOST/ACCEPTED is actually on the books. |
| 5 | The Stripe path wrote a flat `DEPOSIT_PAID`, stepping settled jobs backwards. | One shared ladder, `nextPaymentStatus`, used by all three callers. |

#3 was not on the list of four. It is the same hole as #2 in a different
doorway, and leaving it open beside three closed ones made no sense. Say so if
you would rather it came out.

## The manager fix, and what it does NOT do

`RECORD_MONEY` gates exactly seven columns on `jobs`: `amount_paid`,
`payment_status`, `refunded_amount`, `refunded_at`, `refund_reason`,
`tip_amount`, `payments_from_processor`.

**Your managers keep everything else.** Pricing a job — `contract_total`, the
rates, markup, tax, discount, the deposit — is untouched. So is asking a
customer for money.

**A manager can still record a cash or check payment** in the Payments list,
and the figure still moves, because the ledger trigger recomputes it from the
ledger. That is deliberate: a ledger row says who took the money and when.
What is refused is declaring a job paid with *nothing behind it*.

**You are not affected.** All eight of your own logins are OWNER.

**If you want a particular manager to have it**, it is one line —
`+RECORD_MONEY` in their permission overrides, from the Team access screen.
The probe below proves that escape hatch works.

### Proved against production, and rolled back

The fix's function bodies were created inside a transaction, the probe ran
against them, and the transaction was rolled back. DDL is transactional, so
production is as it was. Checked afterwards: `has_permission` does not mention
RECORD_MONEY, `record_money_trusted` does not exist, no profile carries the
override.

| step | measured | verdict |
|---|---|---|
| MANAGER holds SEE_MONEY | true | unchanged — they must still see money |
| MANAGER holds RECORD_MONEY | false | correct |
| `update amount_paid +12345, status PAID_IN_FULL` | `0 -> 0`, `DEPOSIT_PAID -> DEPOSIT_PAID` | **HELD** |
| CONTROL: manager writes a PRICE column | `4200 -> 4207` | accepted — pricing still works |
| CONTROL: manager writes an ordinary column | changed | accepted — the connection really works |
| CONTROL: same manager, ANOTHER company's job | 0 rows | refused — so this ran under RLS |
| CONTROL: the OWNER writes `amount_paid` | `0 -> 99` | accepted — you are not locked out |
| CONTROL: manager with `+RECORD_MONEY` | `99 -> 104` | accepted — the escape hatch works |

Five controls, because a refusal only means something if something comparable
is accepted in the same breath. The cross-company refusal is the one that
proves the probe ran under row-level security rather than around it.

Re-run it with `supabase_a4_record_money_probe.sql`.

## THE ORDER THIS HAS TO LAND IN, and why it is not optional

There are THREE copies of the role table in this project — the SQL, the
Android app, and `supabase/functions/_shared/job-push.ts` — and I only knew
about two of them. The third turned up because `tests/notify-job-change.test.mjs`
went red: it reads whichever SQL file last defines `has_permission` in
apply-order, which was now mine, and compared it to `job-push.ts`. Updating
that third copy is part of this change.

(It also checks the table against the LIVE function, and that half stayed
green — because it only tests permissions that appear in a live policy, and
`RECORD_MONEY` appears in none yet. So the suite does not currently notice
that the SQL is unapplied. Worth knowing: it is not a second pair of eyes on
whether this has landed.)

The app's half of the manager fix — hiding the payment-status dropdown
from someone without `RECORD_MONEY` — only reaches a phone when an APK is
published. **If the SQL is applied and no APK follows, a manager's phone still
shows the dropdown and the server quietly puts their choice back**: a control
that does nothing, which this project has been bitten by before.

So the order is: apply the SQL, deploy the two webhooks and
create-payment-link, publish an APK. All three, or none.

## Tests

Four new files, 38 checks, every one green, each defect with a canary watched
failing.

- `tests/a177-stripe-payment-holes.test.mjs` — 17 checks. Drives the REAL
  stripe-webhook file: TypeScript stripped with Node's own stripper, a fake
  Supabase client, the REAL shared record-payment module, and real signed HTTP
  requests through the real door. Four canaries plant the old code back — the
  old flip-first order loses the money on the retry, the old guard swallows
  the second payment, the old fallback-less branch drops the raced charge, the
  old flat write walks a settled job backwards.
- `tests/a178-square-dispute-won-needs-a-debit.test.mjs` — 7 checks. OPEN→WON
  books nothing; OPEN→LOST→WON nets to zero; a redelivered WON credits once; a
  failed lookup is NOT an absent debit (500, so Square retries); the dispute is
  still recorded on the job even when nothing is booked. Canary: the guard
  removed books $10,000 against $5,000 collected.
- `tests/a179-payment-link-is-single-use.test.mjs` — 5 checks. The restriction
  is really on the request Stripe receives; a charge the webhook booked first
  is not reported to the office as unrecorded; a REAL insert failure still is.
- `tests/a180-record-money-permission.test.mjs` — 9 checks. The app's role
  table and the server's are parsed and compared; RECORD_MONEY is on
  ACCOUNTANT and no other non-owner role; no permission name contains another
  (overrides are matched by substring, and SEE_MONEY / RECORD_MONEY is the
  near miss); every received-money column is also on `job_money_columns()`;
  the deposit field is NOT behind the new gate.

Two canaries paid for themselves. a180's first Kotlin parser used a lazy regex
and silently skipped `UserRole.CREW`, whose set fits on one line — a parse
that dropped a role and still looked like it had read the table. And
`recordUnexpectedStripePayment` started as an upsert: Postgres will not infer
a PARTIAL unique index from a bare `ON CONFLICT` column list, so it would have
thrown every time it was reached.

## What I did NOT do, and why

**`amount_paid` is already derived.** `recompute_job_totals` rebuilds it from
`payment_records` on every ledger change. A direct write to it is therefore a
second route to a number that already has an owner — the same pattern behind
half this audit's findings. The clean end state is to make those columns
derived-only, writable by nothing but the recompute. I did not do it: it
reaches the app's sync path, and the week of a campaign is the wrong week.
Worth doing after.

**#6 and #7 are still decisions, not fixes** — approving a job the server has
not priced, and the deposit changing after approval. Both need you to choose,
and I have not chosen on your behalf.

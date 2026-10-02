# After she presses Approve

Written 2 Oct 2026. Established by running the REAL `quote-view` handler and the
REAL `buildQuoteDocument` out of `website/quote.html` against constructed rows
and against his eleven live jobs (read-only, positive control and canary in
every probe). Jobs are lettered as `docs/MONEY_AUDIT_SURFACES.md` letters them.
No customer name, address, phone or email is in this file.

Proof: `tests/a69-after-approval.test.mjs` (12 tests, `node --test`).

---

## What she can do and see today

| | Today |
|---|---|
| Download the contract | **Yes** — a "Download a copy" button appears once `approvedAt` is set. A standalone HTML file, no network needed, built from the rows that were on screen. |
| What is in it | Company name and contact, her name and address, the scope, the agreed total, the deposit, what is left to pay, how to pay it, "Approved by <name> on <date>", and (as of tonight) what happens next. |
| Her signature in it | Only if she **drew** one — and she cannot, live: `jobs.quote_approved_signature_path` does not exist in the database, so `signatureCaptureReady` is false and the drawing pad is hidden. Today every approval is a typed name, and the file records it as "Approved by <name> on <date>". |
| Cancellation clause | **No. Nowhere.** See question 1. |
| Contract terms | **No. Nowhere a customer can reach.** See question 1. |
| Email with the contract | **No. Nothing is sent today.** The sender is written and tested, but the table it claims each send on (`quote_approval_emails`) does not exist live — `supabase_a55_approval_emails.sql` has not been applied — and the deployed `quote-view` (v32) does not call it. Measured: the live query for that table failed with `42P01 relation does not exist`. |
| Does she know what happens next | Partly. The page and the saved copy say "once your deposit is received, the contractor will be in touch to schedule the work." She is **not** told a date. See question 2. |
| Re-open the link later | Yes, and the price she agreed to is anchored: `accepted_total` is what every surface shows, not the live `contract_total`. Proved on a job re-priced after approval. **Except** while a re-approval is pending, when the anchor is deliberately off — which is the hole the guard below now covers. |
| Unapprove | **No.** `quote-view` takes one action, `approve`; anything else is `400 Unknown action.` See question 4. |

## What was fixed tonight

**A price that has collapsed below a figure she already agreed to can no longer
be recorded as the accepted price.** `quote-view` now refuses the approval,
writes nothing, leaves her earlier agreement untouched, tells the page in
advance so the button is not a trap, and pushes the office. Measured against
his real rows with the real handler:

| Job | Signed | Page shows | Would have recorded | Short by | Her link |
|---|---|---|---|---|---|
| D | 15,540.00 | 5,853.81 | 5,853.81 (37.7%) | 9,686.19 | **opened** |
| H | 35,240.00 | 13,266.87 | 13,266.87 (37.7%) | 21,973.13 | **opened** |
| I | 870.00 | 200.00 | 200.00 (23.0%) | 670.00 | not opened |

All three now answer `409 price_below_agreed` and write nothing. Every other
live job (A, B, C, E, F, G, J, K) still approves exactly as before.

**THIS NEEDS A DEPLOY YOU PRESS.** Nothing is live until `quote-view` is
deployed. Until then the three links above can still be approved at 23–38% of
the signed price. `supabase_a70_protect_exposed_quote_links.sql` OPTION B
(rotate the three tokens) is the holding action that needs no deploy, and
`supabase_a64_restore_tombstoned_line_items.sql` is the actual fix — restoring
the lines makes the live price correct again and the re-approval then does what
it was built for.

---

# Questions for you

## 1. The cancellation clause is not in anything she can reach. What do you want sent?

**Where it is now.** Your terms — scope, property lines, utilities, warranty,
the whole CANCELLATION section, and the `YOUR RIGHT TO CANCEL — [REPLACE THIS
BLOCK BEFORE USING THIS CONTRACT]` marker — live in
`app/.../data/ContractTemplate.kt` and are read from the phone's own settings.
`PdfExporter.kt` prints them on the contract PDF.

**Why they cannot reach her.** `contractTerms` is not in `CloudSettings`
(`app/.../cloud/SettingsSync.kt`), so it never leaves the handset. No server
function has a copy. The quote page, her downloaded file and the approval email
therefore physically cannot carry the clause, and tonight's test asserts they
do not, so nobody can later claim they do.

**What it would take.** One field added to `CloudSettings` and to the two merge
functions in `SettingsSync.kt`, then read by `quote-view` the way it already
reads `payment_methods` — about an hour, and `SettingsSync.kt` is not mine
tonight.

**The decision, and it is yours, not a coding one:** the default terms still
carry that REPLACE marker, and `contractTermsNeedLegalReview()` flags it.

- **Publish the terms to customers.** She gets a complete contract with a
  cancellation clause in the file she keeps. But whatever is in that block goes
  out with it, marker and all, until an attorney replaces it — and a
  home-improvement contract missing the state's required right-to-cancel
  wording can be unenforceable and carry a penalty of its own.
- **Leave them off the customer surfaces.** Nothing goes out that you have not
  had checked. But what she downloads is a priced quote with her approval on
  it, not a contract: no scope limits, no property-line clause, no utilities
  clause, no warranty, no cancellation terms. If a job goes wrong, the only
  document with terms on it is the PDF you hand over yourself.

**ANSWER:** ______________________

## 2. Does she get told WHEN you are coming?

`jobs.scheduled_date` exists and you use it — it is set on 3 of your 11 jobs
(all three now in the past). Nothing customer-facing reads it. After approving,
she is told "the contractor will be in touch to schedule the work" and nothing
more.

I did **not** ship this, because showing a customer a date commits you to it
and that is your call:

- **Show it** (only when it is set and in the future): she stops phoning to ask.
  But the date on the row becomes a promise the moment she can see it, and
  moving it is then a conversation.
- **Leave it internal:** nothing changes, and "when are you coming" stays a
  phone call.

**ANSWER:** ______________________

## 3. How far below a signed price should the guard tolerate?

Tonight's guard refuses **any** shortfall below the agreed figure — the
strictest setting, because a dollar band or a percentage is a number you would
quote and I will not invent one. It has exactly one exemption, and that one is
exact rather than a band: the old engine rounded every total up to the next $10,
so a job you signed before 1 Oct carries a signed figure up to $9.99 above its
own exact total, and the same price under the new rounding still approves
(measured: fixture G, $7,735.45 of lines against a signed $7,740.00).

What strict costs you: **a deliberate re-price DOWNWARD cannot be approved
online until a new signature is captured at the new price.** The phone already
takes that position from the other side — it blocks sending the estimate and the
invoice whenever the signed total and the live total disagree, and capturing a
signature restamps `signed_contract_total` — so the way out exists and is the
one you already use. But it does mean dropping a customer's price now needs you
in front of her, or a re-sign, before she can tap Approve.

- **Keep it strict:** no customer can ever approve below a figure she signed.
  Cost: the extra step above on every price reduction.
- **Give me a band** (a dollar amount, a percentage, or "any drop under $X is
  fine"): I put it in as a named constant with your number on it. Cost: a
  collapse smaller than the band goes through silently, and the 1 Oct collapses
  were 62%, 62% and 77% so any sane band still catches those.

**ANSWER:** ______________________

## 4. Unapprove — you asked for it in September and it was never built

**What exists.** Nothing. `quote-view` POST accepts `action: "approve"` and
refuses everything else. The office has no button either, deliberately
(`docs/REAPPROVAL_RULE.md`: "Do not offer any office-side 'approve anyway'
button"). The only thing that currently clears an approval is the drawing-change
trigger, which withdraws it and records the whole prior approval in
`quote_reapprovals`.

**What it would take** — not small, which is why it is not built tonight:

1. A second POST action in `quote-view`. The columns are writable by the service
   role, so no migration is needed for the write itself
   (`hold_quote_gate_columns()` lets the service role through).
2. A record. A withdrawal must write a `quote_reapprovals`-style row with the
   prior approval on it, or the fact she ever agreed disappears. That is a
   migration or a reuse of that table with a new reason.
3. A refusal path. It must be **refused** once money has been taken
   (`amount_paid > 0`), once the job is past ACCEPTED, and once the crew has
   started — otherwise she can unapprove a fence that is half built.
4. A window. Unapprove at any time, or only within N days? N is your number.
5. The office has to see it: a badge, an alert and the history panel, in
   `website/dashboard.html`, which is another track's file.
6. The phone has to see it: pull-only columns, a banner, and "do not build yet"
   for the crew.

**The cheap half of it, if you want something this week:** she cannot unapprove,
but she can *reach you*. The page and the email already carry your phone and
your email, and the email says "just reply". A "I need to change something"
button on the approved page that opens a pre-filled email to you is small, safe
and needs no migration. It is not unapprove; it is the phone call made easier.

**ANSWER:** ______________________

## 5. Smaller things found, not shipped

- **The deposit figures on D and H are still the dropped trigger's.** I measured
  the stored figures tonight: D 2,158.45, H 8,101.68. What you originally typed
  (5,730 and 21,520) is last night's audit reading `audit_log`, not re-measured
  by me. Either way those stored figures are what the page, the email and the
  payment link all ask for.
- **Open payment links** (last night's audit, `docs/MONEY_AUDIT_SURFACES.md`
  F9; not re-measured tonight): H holds a pending 21,520.00 deposit link against
  a deposit of 8,101.68, and C holds links of 336.82 and 160.00 against 200.00
  owed. All test mode today.
- **No customer surface explains the deposit's arithmetic**, which is correct —
  the next-$100-plus-$100 rule is deliberately not disclosed, and the page, the
  email, the saved copy and the contract terms all carry one figure and a
  purpose sentence with no basis in it. Checked, still true after tonight.
- **The saved copy is a snapshot and says so** ("The amounts above are as of
  <date>"). If she pays between saving and reading, the file is stale by design.

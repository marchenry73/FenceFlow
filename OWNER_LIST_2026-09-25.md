# March's list, 25 September 2026

Written down so it survives a context reset.

**Status, 28 September, late.** Eleven waves. HEAD is 81852f9, which compiles
clean with 1062 unit tests. Everything since then is uncommitted and is held
back on purpose -- the reasons are below.

### Shipped and verified
A1 tax base (the cause was DATA -- 4 of 92 catalog items untaxed, all panels).
A3 balance. D2(a) crew delete. D4 tax-base note. B3 crew hours dispute. F1
referral picker. F3 admin email. E1 product key. B2 sync sentence. D3 + D2(b)
teardown. The contract-terms editor. B1 device-claim push. C2 quote summary +
download. A4 money audit -- 11 findings confirmed across six domains, ten of
them 3-of-3 on adversarial verification.

Three jobs re-quoted at the corrected price and proved on the live customer
link: James Bond 36,290, John Beaunissant 16,000, the unnamed draft 900.
accepted_total untouched on all three, so what each customer originally agreed
still anchors the price.

### The money defects found, and where each stands
- **Office payment link billed above the agreed price** -- FIXED and tested.
  It would have billed James Bond against 36,290 and John Beaunissant against
  16,000. My own restamp is what made it reachable.
- **Uncalibrated drawing bills full materials, zero labour** -- IN FLIGHT. 800
  dollars unbilled on a 100 ft run; a 38 percent undercharge. Biggest money item.
- **A time correction reprices old shifts at today's rate** -- NOT FIXED, needs
  his decision. Verified from the live function body.
- **Stripe credits money before it arrives** -- FIXED (an unpaid async session no
  longer credits). The REVERSAL half needs his decision; SQL written, unapplied.
- **Labour reports ignored the 200 floor** and got the verdict backwards --
  FIXED, one definition now instead of three copies.
- Uncapped deposit panel, gate-on-wall post cap, dead card-fee function: fixed
  or judged cosmetic.
- **Restored approval can make a signed change order vanish** -- armed, not
  sprung, no job in that state. Not fixed.

### Two defects the waves introduced themselves, both caught by review
- Business Settings could WIPE the company email (blank passes NOT NULL) --
  fixed on both pages with a drift guard between them.
- The admin console claimed saves it never made -- zero rows changed, no error,
  dialog closed as success. In flight.

### The guest demo (I1-I3) -- five waves, still not finished
The read-only PROMISE is being taken out of the copy now, because it is false.
A repository choke point exists (53 writes, one gate) but is DELIBERATELY NOT
WIRED: switching it on as-is would turn open writes into silent swallows in the
eleven view models that wrap writes in runCatching, and crashes in the two that
do not. Correct order is gate the view models, decide what a refusal shows, then
turn it on. Still open: pricing tiers, manufacturers, push-other-job, re-sign
contract, crew change request, run list add/duplicate -- and the company profile
save, which goes to a store no guard covers and the wipe does not revert, so a
guest's edit OUTLIVES the demo. That one is the only write that escapes.

### Not started
D1 unlimited grid. C1 cancellation. C3 drawn signature (blocked on one
edge-function change; SQL written, unapplied). E2 sandbox product key. F2 merged
change feeds. G1, G2.

### SQL applied to his database, all of it deliberate and told to him
supabase_r9_taxable_panels, crew_view_dispute_columns, admin_owner_login_email,
r9_retax_signed_jobs + its two corrections, r9_retax_restamp_totals. Verified
live with a positive control: NOTHING else in the repo root has been applied.
---

## A. Wrong numbers — highest priority, he gave figures

- [x] **A1. Tax is computed on the wrong base.** DONE 09-25, catalog + unagreed jobs. He set 7%. The app shows
      $401.10, which is 7% of 5,730. It should be 7% of the materials —
      9,475.34 — giving **$663.27**. `EstimateEngine.computeTotals` takes
      `taxableSubtotal = lineItems.filter { it.taxable }.sumOf { it.lineTotal }`,
      so the gap is line items whose `taxable` flag is false. Find why (catalog
      default? sync? items created before the flag existed?) and fix it in BOTH
      engines — Kotlin and `supabase/functions/_shared/pricing/` — or the parity
      gate refuses the release. 5,730 vs 9,475.34 is a 3,745.34 difference;
      identify exactly which lines are untaxed before changing anything.
- [x] **A2. NOT REPRODUCED** — the one caller passes materials, and both odd stored deposits are explained (James Bond $21,520 is materials rounded up under the still-owed cap; John Beaunissant $5,730 is a stale value written by code that no longer exists). Needs a screen and a job from March before anyone touches JobMoney. The old wording follows.
- [ ] ~~A2. The deposit suggestion asks the labour price, not the materials
      price.** `JobMoney.suggestedMaterialsDeposit(job, materialCost, billable)`
      — check what each caller passes for `materialCost`.
- [x] **A3. DONE 28-09.** A job paid in full read “Balance due $15,364.00” under “Paid in full”, proved on the live link. One meaning now, the server's, plus six tests from that fixture's figures.
- [x] ~~A3. The balance is wrong.~~ Check it everywhere: the estimate screen, the
      job sheet, the quote page, the PDF, the payment link.
- [ ] **A4. Audit every money calculation in the app and the office** and prove
      it charges the right price. Downstream suites exist
      (`tests/downstream-*.test.mjs`); extend rather than duplicate.

## B. Sync and devices

- [ ] **B1. "Use this phone" must stop the other phone immediately.** Today the
      newest claim wins and the displaced phone only notices when next opened.
      Push exists (`job-change-push`, `_shared/push-recipients.ts`) — a claim
      should reach the old phone straight away.
- [ ] **B2. Signing in on another phone does not sync immediately** and keeps
      saying it has not reached the cloud. Real bug, reported twice. Reproduce
      before changing anything — see the "empty answer reads as good news"
      memory: an unauthenticated read returns `[]`, not an error.
- [x] **B3. BUILT 28-09** (pending build + publish). The dispute reached the database all along; nothing in the app on either side read it. Owner now gets a disputed section above the approval queue; the crew member sees their own objection on the shift. `supabase_crew_view_dispute_columns.sql` applied 28-09.
- [ ] ~~B3. The crew sent hours, the crew say it was wrong, and it never reached
      the owner's phone.** Investigate from the live data, not the code alone.

## C. Money the customer sees

- [ ] **C1. Cancellation is not filled in** — make it work.
- [ ] **C2. A sent quote shows the customer everything, plus a pay link / "Pay
      here" that opens Stripe so they can pay immediately.**
- [ ] **C3. Signature by email:** send the customer everything they need to sign,
      with verification; they either draw a signature or type their full name;
      afterwards they can download the documents. This is for HIS clients to use
      with THEIR customers.

## D. The drawing

- [ ] **D1. Unlimited grid** — draw bigger, zoom out and keep finding grid. Make
      it look good. (Today `GRID_SIZES_FT` tops out at 2000 and satellite pins
      to 400.)
- [x] **D2(a) DONE 28-09 and it was a rule breach, not a feature gap:** a CREW phone could delete a fence run — `RunEditScreen` never read the session at all. Now gated on `canDelete`, hidden not greyed, checked again on the dialog.
- [ ] **D2(b). Erase a run from the DRAWING screen** — in progress.
- [ ] **D3. Draw the old fence on the grid** so nothing goes in the marker area,
      and make sure it is charged for.
- [x] **D4. STARTED 28-09.** The estimate now says what the tax was charged ON, whenever that differs from the materials — the line whose absence hid A1 for three passes. More charges to surface still.
- [ ] **D5. DO NOT BUILD AS ASKED — verified.** Those five controls are the ONLY place the teardown charge can be switched on or priced, and the engine forces the cost to zero when the switch is off. Remove them and the charge becomes permanently uncollectable — recreating D3's complaint one screen over. Instead: keep every field and show what it is pricing (in progress). Original wording:
- [ ] ~~D5. Remove the teardown section on the job page~~ now that it lives on
      the grid, and remove anything else duplicated between the two.

## E. Keys, plans and the admin portal

- [x] **E1. BUILT 28-09, and the feature was already live.** The table, all four functions and the office panel were applied on 24-09; a stale comment in the file said otherwise and fooled a survey. It is called a product key now, in his words, with a pointer to it from the dashboard. The switch that enforces it is still deliberately absent from the UI. Original wording:
- [ ] ~~E1. The per-device product key is not visible to customers~~ — they
      cannot use it, in the app or on the website.
- [ ] **E2. A TEST product key that unlocks the test data, and a REAL one** — a
      sandbox and the live app — both controlled from the admin portal.

## F. The office and the job page

- [x] **F1. BUILT 28-09.** Only one field on that sheet is genuinely a list — referral source — and it is a picker now in both the job sheet and the wizard, with every value already in the data carried so no job is rewritten. Everything else there is a name, an address, a note or a rate.
- [ ] **F2. Merge "Drawing changes since approval" with "Changes from the
      field"** into one section that looks good and saves space.
- [ ] **F3. His company in the admin portal must show marchenry73@gmail.com.**
- [ ] **F4. The customer reply-to address should be the COMPANY's email.**
      `marc@fenceflowapp.com` is his address within the company; the company
      needs its own, accurately.

## G. Queued from before

- [ ] **G1. Drawing versions** — the database half is applied and the restore
      screens shipped in 1.532; finish whatever remains.
- [ ] **G2. Different settings per company.** He explicitly said to leave
      **custom features** aside for now, to be built later.

## H. Later, on his instruction

- **H1. Once the app and the website are fixed, start building to get
  customers.** He said to save this for later — do not start it.

---

## Still waiting on March (not mine to do)

- Back up the signing key in two places. Only copy is
  `C:/Users/march/keys/fenceflow-release.jks`; fingerprint starts `7b:10:77:95`.
  Lose it and no installed copy can ever update again.
- Where customer deposits land; Stripe live keys; the "no card to start" wording
  on the homepage; the FenceFlow name check.
- Can an owner approve their own hours? Can the office create change orders and
  punch lists? Does a corrected shift keep the rate it was worked at?
- The $200 labour floor on his 4 existing drafts; whether the round-up to $10
  becomes a setting.
- `supabase_r8_drop_duplicate_touch_trigger.sql` is written and waiting: it DROPs
  the duplicate clock trigger on `fence_runs`.

# March's list, 25 September 2026

Written down so it survives a context reset.

**Status, 28 September.** Shipped and verified: A1, A3, D2(a), D4 (first half),
and 1.526–1.532 before that. Built and awaiting a build: B3, F1, E1, F3.
In flight: B2, the guest demo (I1–I3), D3 + D2(b), D5-as-reframed, the
contract-terms editor, B1. Not started: D1, C1, C2, C3, E2, F2, F4, G1, G2.

SQL applied since the list was written: `supabase_r9_taxable_panels.sql`,
`supabase_crew_view_dispute_columns.sql`, `supabase_admin_owner_login_email.sql`,
`supabase_r9_retax_signed_jobs.sql` and its correction
`supabase_r9_retax_fix_scope_and_wording.sql`. Written and waiting on March:
`supabase_r8_drop_duplicate_touch_trigger.sql`.

**THREE jobs are waiting for approval at the corrected price, verified on the
live customer link.** James Bond 35,240 -> 36,290; John Beaunissant
15,540 -> 16,000; the unnamed draft 870 -> 900. Each figure is the real server
engine's output (tests/company-golden-path.pricing-runner.mts), and separately
equals ceil10(old total + the SQL tax delta). accepted_total is untouched on
all three, so the price they originally agreed survives as the anchor. The
deposit followed automatically as he asked (John 5,730 -> 5,899.61, James Bond
21,520 -> 22,161.20). quote-view now returns total 16000 / deposit 5899.61 for
John, confirmed by fetching the customer endpoint.

TWO were withdrawn in error and have been put back, both needing HIS decision,
neither caused by the tax work:

- **Woody** -- its only fence run has EMPTY geometry and null manual feet, so
  the engine returns 350 against a stored 3,620. A large generated set (52 line
  posts, 54 panels, a gate) was tombstoned on 24 August. Restore the drawing, or
  accept the smaller price.
- **James** -- stored total 200 is just the minimum-charge floor; it has a real
  drawn polyline of ~270 ft never priced into line items, so the engine says
  5,830. One press of the job sheet's price button fixes it. No price was sent,
  because neither 210 nor 5,830 is defensible.

**Work through it and keep this file current** — tick an item only when it is
shipped and verified from the artifact, not when the code is written.

Rules that apply to every item on this list, from earlier in the session:

- Crew never see money and can never delete anything.
- Nothing weakens RLS, plan gates, quote security, server-side pricing, the
  payment ledger, signatures, offline sync.
- NO FAKE FEATURES. A control that does not do the thing is worse than none.
- Additive SQL may run after explaining; destructive SQL is shown and waits.
- Never `git add -A`; name paths and read `git status --porcelain` first.
- Verify from the built artifact (`aapt2 dump badging`), never from a build log.
- Commit BEFORE building, or publish refuses on the version mismatch.
- Use the lowest model that can do the job; one stronger model to check it.

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

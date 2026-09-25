# March's list, 25 September 2026

Written down so it survives a context reset. **Work through it and keep this file
current** — tick an item only when it is shipped and verified from the artifact,
not when the code is written.

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

- [ ] **A1. Tax is computed on the wrong base.** He set 7%. The app shows
      $401.10, which is 7% of 5,730. It should be 7% of the materials —
      9,475.34 — giving **$663.27**. `EstimateEngine.computeTotals` takes
      `taxableSubtotal = lineItems.filter { it.taxable }.sumOf { it.lineTotal }`,
      so the gap is line items whose `taxable` flag is false. Find why (catalog
      default? sync? items created before the flag existed?) and fix it in BOTH
      engines — Kotlin and `supabase/functions/_shared/pricing/` — or the parity
      gate refuses the release. 5,730 vs 9,475.34 is a 3,745.34 difference;
      identify exactly which lines are untaxed before changing anything.
- [ ] **A2. The deposit suggestion asks the labour price, not the materials
      price.** `JobMoney.suggestedMaterialsDeposit(job, materialCost, billable)`
      — check what each caller passes for `materialCost`.
- [ ] **A3. The balance is wrong.** Check it everywhere: the estimate screen, the
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
- [ ] **B3. The crew sent hours, the crew say it was wrong, and it never reached
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
- [ ] **D2. Erase a fence run** from the drawing, not just add one.
- [ ] **D3. Draw the old fence on the grid** so nothing goes in the marker area,
      and make sure it is charged for.
- [ ] **D4. Show everything that is being charged**, so nothing is missed.
- [ ] **D5. Remove the teardown section on the job page** now that it lives on
      the grid, and remove anything else duplicated between the two.

## E. Keys, plans and the admin portal

- [ ] **E1. The per-device product key is not visible to customers** — they
      cannot use it, in the app or on the website.
- [ ] **E2. A TEST product key that unlocks the test data, and a REAL one** — a
      sandbox and the live app — both controlled from the admin portal.

## F. The office and the job page

- [ ] **F1. More dropdowns on the job page.**
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

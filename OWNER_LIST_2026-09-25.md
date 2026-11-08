# March's list, 25 September 2026

Written down so it survives a context reset.

**Status, 29 September.** Twenty waves. HEAD 56c3d9f, version 552. Everything
below is COMMITTED and green: release Kotlin compiles, the pricing parity gate is
GREEN at 85 of 85 (engine 2026.09.3), Kotlin 1167 tests 0 failures, node 987 tests
967 passing with no real failures. Nothing is deployed and no APK is built.

### Done and verified
A1 tax base (cause was DATA: 4 of 92 catalog items untaxed, all panels). A3
balance. A4 money audit -- 11 findings, six domains, adversarially verified. B1
device-claim push. B2 sync sentence. B3 crew hours dispute. C2 quote summary,
download and pay link. C3 drawn signature (needs its column applied). D2 crew
delete + erase from the drawing. D3 old fence. D4 tax-base note. D5 reframed. E1
product key. F1 referral picker. F3 admin email. D1 PARTLY -- the grid is
unlimited now, but SATELLITE still stops at 400 ft.

Three jobs re-quoted and proved on the live customer link: James Bond 36,290, John
Beaunissant 16,000, the unnamed draft 900. accepted_total untouched on all three.

### The thirteen sabotage proofs RAN, and all thirteen passed
They had never been executed -- behind a switch nobody threw. The crew line door,
the signature stamp, the change-order latch and accepted_total on the money list
are verified against production for the first time, inside a rolled-back
transaction, with the reviewer stripping a live guard to confirm the green baseline
was a real refusal rather than a call that never happened.

### Money defects found and fixed
The office payment link billed above the agreed price (1,510 exposed on two real
jobs). An uncalibrated drawing billed materials with no labour (800 a hundred feet).
Labour reports ignored the 200 floor AND got the verdict backwards. Stripe credited
money before it arrived. A line-to-wall gate shorted a post cap. SIX buttons
reported saves they never made -- including one that showed an email link as removed
while the database still had it. An empty string could wipe the company email.

### Still open
- **Satellite zoom** -- the other half of D1.
- **Nobody has looked at the new grid on a screen.** Drawing code, verified only by
  compiling and reading. That needs HIS eyes before it ships.
- **DONE (office half) -- verified 31-10.** The office no longer assumes 20 px/ft:
  `jobDrawingScale()` reads `grid_extent_ft` and nothing on the page hardcodes 20.
  The remaining split is between the extent-aware DRAWING rules (phone screen,
  office page) and the flat-20 PRICING rules (phone engine's footageOf fallback,
  load.ts) -- deliberate, and safe only because no job can have a non-default
  extent with no calibration: setGridExtent always writes one, and the office never
  writes grid_extent_ft at all. Measured (16x over at the 25ft grid, 1/25 under at
  10000ft) and guarded by tests/a91-one-scale-for-pricing.test.mjs. Closing the
  split is a both-sides formula change that would reprice every uncalibrated job:
  needs March. Original wording:
  ~~the office assumes 20 px/ft and never reads the grid size, so they agree only at
  400 ft. Unreachable today, but the new grid sizes raise the possible error from 5x
  to 25x.~~
- **DONE -- verified 31-10.** The comment now says the opposite, at length:
  "THIS HARNESS CANNOT REACH THAT CASE, and not by oversight ... do not read a green
  fixture as covering it", and names where the coverage really lives (PhotoScaleTest.kt
  and tests/a17-photo-uncalibrated-pricing.test.mjs). The four parity cases were
  removed on 29-09, four days after this list was written. Original wording:
  ~~A false comment in PricingAdapters.kt -- the same lie four deleted parity cases
  were removed for.~~
- C1 cancellation, E2 sandbox product key, F2 merged change feeds, G1 drawing
  versions. G2 he said to leave.
- The guest demo: manufacturers, push-another-job, re-sign contract, crew change
  request, and the company profile save -- the only guest write that ESCAPES the
  demo, because it goes to a store no guard covers and the wipe does not revert.
  The repository choke point exists and is deliberately NOT wired: switching it on
  as things stand turns open writes into silent swallows.

### Waiting on him
Back up the signing key (one copy, C:/keys/fenceflow-release.jks). Check whether
bank debit is on in Stripe. Should a corrected shift keep the rate it was worked at
(it does not today). Stripe reversals: automatic or a flag. Change orders during a
re-approval. Woody (empty drawing geometry, engine says 350 against a stored 3,620)
and James (unpriced 270 ft drawing, engine says 5,830 against a stored 200 that is
just the minimum-charge floor).

**Deploy order when he ships: price-job FIRST.** Both sides carry 2026.09.3; the
deployed function is from 5 September and the phone is older still. If the office is
newer the phone backs off; ship the phone first and it overwrites the office.

### SQL applied to his database -- all deliberate, all reported
r9_taxable_panels, crew_view_dispute_columns, admin_owner_login_email,
r9_retax_signed_jobs plus its two corrections, r9_retax_restamp_totals. Verified
live with a positive control: NOTHING else in the repo root has been applied. Eight
.sql files are written, committed and unapplied, each waiting on a decision.
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

- [x] **C1. DONE 06-11 — and the title was literally true.** Cancellation is
      *built*: the office has the dialog, the phone has `CancellationApi`, and
      r45/r61 hold the rule server-side ($1 a foot for work that will not
      happen, plus material when it was ordered, nothing at all inside the
      three business days). What was **not filled in** was the column r45
      added for the purpose. `jobs.cancellation_retained` says in its own
      comment: *"What was kept, AS DECIDED AT THE MOMENT OF CANCELLATION.
      Stored rather than recomputed."* Nothing wrote it — not the office, not
      the phone, not a trigger. And the **deployed** `job_cancellation_terms`
      (read out of the live database, not a file) mentioned neither that column
      nor `cancelled_at`, so it re-priced from today's line items every time it
      was asked. The customer is told "we keep $X, you get $Y back", $X is
      stored nowhere, and the next person to open the job sees a different
      number with no way to tell which was the agreement — the same defect
      `accepted_total` was created to fix on the quote side, on a refund.
      Only the **material** half drifts; `feet` is `signed_linear_feet`, frozen
      at signing.
      `supabase_r71_cancellation_figure_is_frozen.sql`, applied 06-11: one rule
      function, the display prefers a figure already decided, and a trigger on
      the `cancelled_at` transition writes it. **A trigger, not two client
      patches** — that transition is the one funnel the office and the phone
      both go through, so neither needed changing and no APK was published.
      `retained` freezes; `refund_due` stays `max(paid − retained, 0)` against
      live `paid`, so it falls to zero as money actually goes back.
      0 of 20 jobs have ever been cancelled, so nothing had been harmed yet —
      and nothing needed backfilling. `tests/a165`, 14 checks including the
      behavioural one, with a positive control that disables the trigger and
      confirms the figure is then not stored.
      **Still open:** the cancel path has never been used by a real person; the
      office does not yet *show* what a cancellation kept; the phone cannot
      read the column at all.
- [x] **C2. DONE 06-11.** Three parts, and two of them already worked. The
      **summary** renders (fence type, total feet, gate count, a per-run
      breakdown one tap away) and the **pay link** works — measured live:
      `paymentsReady: true`, `depositPayable: true`, deposit $3,500 of
      $5,764.72. The **download** was the gap, and not in the way it looked:
      "Download a copy" was *declared inside* `#approvedBox`, which is
      `display:none` until the customer approves — so the two
      `$('downloadBtn').style.display=''` lines in the file both ran, both
      succeeded and both showed nothing. A customer still deciding had no way
      to keep the figures, which is the one audience a quote is for. The button
      now lives under the Pricing panel and one pure rule decides it
      (`canDownloadCopy`): yes once priced, still yes after approval, **no**
      while `approvalBlocked` — that figure is one the server has already
      refused as below an agreed price, and a file she keeps outlives the
      panel render() takes down for the same reason. Verified on a real
      unapproved quote (nini, $32,175.25, 1429 ft of vinyl, 1 gate): button
      visible, approved box still hidden, no console error, document built
      with no approval block. `tests/a164-quote-copy-before-approval.test.mjs`,
      13 checks, all four watched failing.
      NOT changed, deliberately: the quote still shows no materials/labour
      split. `quote-view` strips `subtotal`/`tax`/`taxRate` on purpose —
      subtotal *is* the material cost, and anyone with the link could subtract
      it and read the margin before negotiating. Reversing that is your call,
      not a coding one.
- [ ] ~~C2. A sent quote shows the customer everything, plus a pay link / "Pay
      here" that opens Stripe so they can pay immediately.~~
- [ ] **C3. Signature by email:** send the customer everything they need to sign,
      with verification; they either draw a signature or type their full name;
      afterwards they can download the documents. This is for HIS clients to use
      with THEIR customers.

## D. The drawing

- [x] **D1. ALREADY DONE - verified 24-10.** zoomGridExtent doubles the CURRENT extent rather than stepping a list, so it has no top ("every tap finds a bigger grid than the last, forever"); GRID_SIZES_FT reaches 10000, not the 2000 this item claims; square size scales with the extent; a Float overflow returns the current extent rather than calibrating against infinity; GridExtentTest pins it. Original wording: D1. Unlimited grid** — draw bigger, zoom out and keep finding grid. Make
      it look good. (Today `GRID_SIZES_FT` tops out at 2000 and satellite pins
      to 400.)
- [x] **D2(a) DONE 28-09 and it was a rule breach, not a feature gap:** a CREW phone could delete a fence run — `RunEditScreen` never read the session at all. Now gated on `canDelete`, hidden not greyed, checked again on the dialog.
- [x] **D2(b). DONE - verified 24-10.** SurveyDrawScreen has an ERASE mode and a Delete action on the selected run, both behind session.canDelete, with a confirm dialog; SurveyViewModel.eraseRun confirms the run still belongs to this job, forgets its timeline steps, and moves the selection so the canvas never goes blank.
- [x] **D3. ALREADY DONE - verified 24-10.** The drawing screen's + menu offers "new" and "teardown", so the old fence is started where it is drawn; it draws in PlanColors.teardownLine; linearFeet excludes it and teardownLinearFeet sums it, in BOTH engines; TeardownChargeRow puts the job-level charge switch on that same screen; and EstimateEngine warns when a teardown is drawn while the charge is off. Still open: what "so nothing goes in the marker area" asks for, and that an EXISTING run cannot be switched to or from teardown (it is only set when the run is added). Original wording: D3. Draw the old fence on the grid** so nothing goes in the marker area,
      and make sure it is charged for.
- [x] **D4. STARTED 28-09.** The estimate now says what the tax was charged ON, whenever that differs from the materials — the line whose absence hid A1 for three passes. More charges to surface still.
- [x] **D5. DONE 07-11 — and the phone half was already finished.** Still DO
      NOT BUILD AS ASKED: those five controls are the only place the teardown
      charge can be switched on or priced, and the engine forces the cost to
      zero when the switch is off, so removing them makes the charge
      permanently uncollectable — D3's complaint one screen over.
      The replacement ("keep every field, show what it is pricing") turned out
      to be **already done on the phone's job page**, which is what this item
      names: `JobDetailScreen` resolves the three-way footage fallback, names
      which one is in play in four words beside the money, carries the long
      version in a basis card, and takes the bottom line from the engine's own
      `teardownCost` so the two cannot drift. The "(in progress)" marker was
      stale.
      **The office wizard was the surface still silent**, and that is what was
      added: step 4's four teardown fields now carry a live sentence saying what
      they charge. The thing it exists to say is the engine's fallback —
      `teardownFeet > 0 ? typed : drawn > 0 ? drawn : billableFeet` — so
      leaving "Teardown feet" at 0 with no old fence drawn charges the per-foot
      rate **along the whole new fence**. Nothing on that panel hinted at it.
      It prints an exact figure when the feet are typed and names the length
      that will be used when they are not, because the office has no live
      linear-feet column and the wizard loads no runs — a figure it cannot
      stand behind would be worse than the silence.
      `tests/a169`, 13 checks, all four canaries watched failing, including one
      that fails if the ENGINE's fallback changes so the note cannot quietly
      become a lie. Original wording:
- [ ] ~~D5. Remove the teardown section on the job page~~ now that it lives on
      the grid, and remove anything else duplicated between the two.

## E. Keys, plans and the admin portal

- [x] **E1. BUILT 28-09, and the feature was already live.** The table, all four functions and the office panel were applied on 24-09; a stale comment in the file said otherwise and fooled a survey. It is called a product key now, in his words, with a pointer to it from the dashboard. The switch that enforces it is still deliberately absent from the UI. Original wording:
- [ ] ~~E1. The per-device product key is not visible to customers~~ — they
      cannot use it, in the app or on the website.
- [ ] **E2. NEEDS YOUR DECISION — it conflicts with a safety rule already in
      place (checked 07-11).** The sandbox/real split exists: `companies
      .is_sandbox` is live, `refuse_sandbox_real_world()` keys off it, and the
      admin portal shows it as a badge. What it will not do is let you *set*
      it, and that is deliberate — the code says why: *"a checkbox here would
      be a way to make a test company start mailing real people by misclick."*
      So "both controlled from the admin portal" is the one part not built,
      and building it as asked re-opens exactly the hole that comment closes.
      If you want it, say so and I will build it behind a type-the-company-name
      confirmation rather than a checkbox. Original wording: A TEST product key
      that unlocks the test data, and a REAL one — a sandbox and the live app —
      both controlled from the admin portal.

## F. The office and the job page

- [x] **F1. BUILT 28-09.** Only one field on that sheet is genuinely a list — referral source — and it is a picker now in both the job sheet and the wizard, with every value already in the data carried so no job is rewritten. Everything else there is a name, an address, a note or a rate.
- [x] **F2. ALREADY DONE — verified 07-11.** Both halves live in one panel
      (`#jobChangesPanel`, "Changes on this job") with one header and one
      border; the old separate panels are gone (0 references left).
      `syncJobChangesPanel()` shows it only when one of the four parts has
      content, so on most jobs the sheet is no longer than before the section
      existed — the "saves space" half of what was asked. The phone did its
      half in `JobDetailScreen.JobChangesSection` (line 5438).
      `tests/office-job-changes-merge.test.mjs` pins it: **50 checks**,
      including canaries proving the pre-merge rule (the drawing half deciding
      alone) would hide the section on a job that has field changes. Verified
      from the code and the passing suite, not from the comment that claims it.
- [x] **F3. ALREADY DONE — verified live 24-10.** `admin_companies()` returns `owner_email` (column 29) from the company's OWNER profile; Fence solutions has exactly one OWNER, `marchenry73@gmail.com`, and `admin.html` renders it in the company row and the Manage dialog. `companies.email` (`marc@fenceflowapp.com`) is the separate customer-facing setting and is deliberately untouched. Original wording:
- [x] **F4. DONE 07-11 (the code half).** The reply-to already *was* the
      company's email everywhere it matters — `mail-send` via
      `fenceflowReplyTo`, `hoa-letter`, `invite-crew` all read
      `companies.email`, and a company without one gets a refusal that names
      the remedy: *"Add your business email in Settings first, so replies to
      FenceFlow mail have somewhere to go."* What was wrong is that the
      customer-facing email is stored **twice** and, unlike name, phone and
      licence, was never mirrored: `companies.email` feeds the reply-to and
      the quote page, while the settings blob's `email` is what
      `PdfExporter` prints in the contract header. Same concept, two stores,
      agreeing only by luck.
      r62 excluded it for a reason that had stopped being true — it cites a
      disagreement where "the settings copy is a personal gmail", and measured
      07-11 there is no disagreement at all (both read `marc@fenceflowapp.com`;
      the gmail is gone). It also cited F3, but **F3 is a different pair**:
      `companies.email` vs the *owner's login* out of `profiles`. The blob's
      `email` is `BusinessProfile.email`, declared in `SettingsStore.kt`
      between `businessName`/`phone` and `licenseNumber` — the very fields
      already mirrored.
      `supabase_r72_email_follows_the_identity.sql`, applied 07-11: mirrors it
      both ways and adds `email` to the companies-side trigger column list
      (without that the branch is inert — r69's trap). One difference from the
      other three: a **shape check**, because a wrong name is merely wrong on a
      page while a wrong address silently stops customer mail — `"n/a"`, a
      phone number or a company name is never mirrored into a reply-to.
      `tests/a167`, both canaries watched failing.
      **Still needs you:** *"Marc fence"* has no customer-facing email in
      either store, so there is nothing to mirror — its quote pages show no
      contact address and its FenceFlow mail refuses. *"Legacy"* uses a
      personal yahoo address (`beaunissantmarchenrybernard@yahoo.fr`) as its
      customer-facing email; mirroring will now keep that accurately in both
      stores, which may not be the address you want.

## G. Queued from before

- [ ] **G1. Drawing versions — THIS ITEM'S PREMISE DOES NOT MATCH THE CODE
      (checked 07-11).** It says "the database half is applied". There is **no
      versions, snapshots, revisions or history table in production** — the
      live schema has none. What exists is two different things, and neither
      is what the sentence describes:
      • **Drawing undo/redo history** is a per-job **JSON file on the handset**
        (`DrawingHistoryStore.kt`), and that is a deliberate choice with its
        reason written down: *"an undo stack is screen state, not business
        data. It never syncs."* So it does not survive a device change, by
        design — not an unfinished database half.
      • **"Put this drawing back"** — the restore the office offers after an
        approval is withdrawn — is real, is backed by `quote_reapprovals`, and
        is covered by the 50 checks in `tests/office-job-changes-merge.test.mjs`.
      So "finish whatever remains" needs you to say which of the two you meant.
      If it is *versions a second phone can see*, that is a new feature and a
      real build, not a finish. Original wording: the database half is applied
      and the restore screens shipped in 1.532; finish whatever remains.
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

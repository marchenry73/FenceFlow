# Findings for the 25 September list — saved for a fresh session

Companion to `OWNER_LIST_2026-09-25.md`. Everything here was read off live code or
the live database on 25 September, so a new session can act on it **without
re-running the survey**. Seven investigators were commissioned; four had returned
when this was written, and the rest are noted at the bottom.

Each finding says whether it was CONFIRMED against the live system or is still
only PLAUSIBLE. Do not promote a PLAUSIBLE one to a fix without checking it.

---

## Two things found by accident that outrank most of the list

### X1. Crew can delete a fence run today. CONFIRMED.

- `app/src/main/java/com/fenceestimator/app/ui/runs/RunEditScreen.kt:218` — a
  Delete-run button, and **nothing in that file ever reads `session`**.
- `app/src/main/java/com/fenceestimator/app/ui/runs/RunEditViewModel.kt:21` —
  `delete()` calls `repository.deleteFenceRun()` directly, unguarded.
- `app/src/main/java/com/fenceestimator/app/MainActivity.kt:723` — the
  `RUN_EDIT` route has no `AccessGuard`.
- `JobDetailScreen.kt:251`'s own comment confirms crew accounts reach the job
  screen, and the `runs` section is unconditional.

Every sibling delete in `JobDetailScreen.kt` is wrapped in `canDelete`; this one
was added where `session` was not in scope and the gate was simply never written.
**This breaks the standing rule that crew can never delete anything.** Fix: gate
on `session.canDelete`, the pattern used four times already in
`JobDetailScreen.kt`. Do NOT remove the button — owners legitimately hold
`DELETE_RECORDS`.

### X2. A signed-out session has every permission. CONFIRMED.

`app/src/main/java/com/fenceestimator/app/cloud/SessionManager.kt:56` —
`!signedIn -> Permission.ALL`. Written for a real earlier situation (a solo owner
working offline before ever making an account); guest mode was layered on the same
"signed out" state later and nobody revisited it.

So the read-only demo he asked for is **not read-only in any enforced sense**: a
guest can create, edit, delete and re-price jobs and edit company settings and the
catalog. `SessionManager.permissions` (52-60) is the single choke point every
write-gated screen already asks, which is what makes this cheap to fix properly
rather than screen by screen.

### X3. Guest demo data can reach a real company's live database. CONFIRMED by the survey.

- `guest/GuestSeeder.kt:26` writes 3 jobs + 2 line items **into the real Room
  tables** through the ordinary Repository.
- `guest/GuestWipe.kt:64` refuses to run once `signedIn` is true.
- `MainActivity.kt:186` — on a real sign-in mid-demo it calls **only**
  `endGuestSession()`, and never wipes.
- Then `DataOwnership`'s "adopt a solo owner's pre-signup local work" and
  `JobSync`'s "anything the cloud has never seen is new work, push it" do exactly
  what they were built to do.

Route: try the demo, sign into a real account before it expires, and the demo
jobs sync up as real ones.

**No guest job has actually reached the live database.** I checked, rather than
leaving the survey's implication standing: zero rows in  carry the
name prefix, zero carry , and zero
soft-deleted rows carry either. So this is a live route that nobody has walked,
not damage to repair. Fix the route; there is no cleanup to do.

Two cheap fixes, and they should ship together: wipe at the moment sign-in is
detected (`MainActivity.kt:186-190`), and refuse to push a row that carries
`GuestMarker`'s sentinels. Note that `GuestWipe` currently depends on two
free-text markers (`GuestMarker.kt:25,28`) surviving unedited — and X2 means a
guest can edit the very customer-name field one of them lives in.

---

## A — money

### A2. "the deposit asks the labour price instead of the material price" — NOT REPRODUCED.

- `JobMoney.suggestedMaterialsDeposit` is at `estimate/JobMoney.kt:218`.
- Its **one** production caller is `ui/jobs/JobDetailViewModel.kt:123`, and it
  passes the `materialCost` StateFlow from `JobDetailViewModel.kt:57` — line items
  plus change-order material costs, the same formula as
  `EstimateEngine.kt:793`'s `materialsSubtotal`.
- `AcceptedPriceTest.kt:185` already covers it, materials-only.

There is nowhere in that chain for a labour figure to enter. **Do not "fix" this
without a specific job or screenshot** — an unmotivated change to a money helper
is how a working figure breaks. Ask March which screen and which job.

### A3. The balance genuinely disagrees between places. CONFIRMED.

`website/quote.html` computes Balance due as **Total − deposit ASKED** (a payment
schedule figure). Everywhere else — `JobMoney.balance`, the PDF
(`PdfExporter.kt:470`), the office (`dashboard.html:9071`), and the payment-link
cap — computes **Total − NET PAID** (a live figure).

Both are legitimate concepts. They diverge visibly once a customer has paid more
than the deposit alone. **This is a product decision, not a pure bugfix**: the
quote page is customer-facing copy on a public link. See the decision list below.

Balance render sites to keep in step: `JobDetailScreen.kt:1975`,
`EstimateScreen.kt:637`, `PdfExporter.kt:470`, `dashboard.html:9071`,
`quote.html`'s totals rows.

### A4. Everything else routes through a shared helper. CONFIRMED.

The inventory came back clean apart from A3: every other figure goes through
`EstimateEngine.kt` / `JobMoney.kt` on the phone, the same-named helpers in
`dashboard.html`, or `price-job` / `_shared/pricing/` / `_shared/quote-deposit.ts`
on the server. So A4 is **one fix (A3), not an audit**.

### C1. Cancellation — larger than it sounds.

Confirmed by a live schema query: there is nothing to build on. It is a new
status + schema + UI feature, possibly touching both pricing engines if a
cancellation fee is charged. **Sizing this as small would be dishonest.** One
small piece does exist and can ship on its own: an already-written
`contractTermsNeedLegalReview()` is not wired to anything.

---

## B — sync and devices

### B1. "Use this phone" cannot stop the other phone today. CONFIRMED.

`ServiceGate.kt:215` writes `profiles.active_device_id` and **nothing observes
that write**. The displaced phone finds out only via `stillMine()`
(`ServiceGate.kt:244`), reached only from `holdsLogin()` (`:322`), driven only by
`MainActivity.kt:302`'s ON_RESUME. The heartbeat (`AutoSync.kt:372,778` —
15 min background / 60 s foreground) never calls it. `profiles` is in neither of
`RealtimeWatcher.kt:232`'s table lists, so realtime does not carry it either.

The addressing machinery already exists and is used for other events:
`device_tokens`, `registerDeviceToken` (`SessionManager.kt:344`),
`_shared/push-recipients.ts:118`, and the `job-change-push` trigger pattern
(`supabase_narrow_push_trigger.sql:19`, jobs only).

Proposed: an `AFTER UPDATE OF active_device_id` trigger on `profiles` that POSTs
the **OLD** device id to a small edge function which pushes that one device.
**Must preserve ServiceGate's deliberate fail-open behaviour** — a push-driven
block must never fire on "could not reach the server", or a crew member in a dead
spot is thrown out of the app.

### B2. "has not reached the cloud yet" — PLAUSIBLE, needs a phone.

The exact string is `AutoSync.kt:55` (`SyncState.message`). One sentence covers
**three unrelated conditions** (`AutoSync.kt` ~630-640): `MoneyScope.UNKNOWN`,
`syncResult.heldBack > 0`, and a negative push result. So a phone with nothing
typed on it can read a sentence implying its own work is stuck.

First sync after sign-in: `AutoSync.kt:181`, `Authenticated -> requestSync()`.

Fix: split that sentence — a real local backlog versus "still confirming what you
can see". `AutoSync.kt:48-53` warns explicitly that this message must never read
as "everything is backed up" when it might not be, so the split must not lose
that.

### B3. The crew's hours dispute never reaches the owner's phone. CONFIRMED LIVE.

The dispute reaches the database correctly and immediately. **Nothing in the
Android app, on either side, ever reads the three columns that record it**, and
the owner's review screen shows nothing at all.

Fix: add `correctionSeenAt` / `correctionDisputedAt` / `disputeNote` to
`TimeEntry` and to EntitySync's time-entries pull mapping — the same treatment the
existing four correction columns already get — and show a disputed flag plus the
note on `TimeApprovalScreen`.

Note: `supabase_scheduling_and_approval_gaps_finding.sql:74-84` records that
`review_note` and `correction_disputed_at` are **deliberately** left writable by
any company member. Do not "tighten" that as part of this.

---

## D — the drawing

### D1. "Unlimited grid" — three honest readings, all with real costs.

Today: `GRID_SIZES_FT` is a fixed chip list 25–2000 ft
(`SurveyViewModel.kt:1101`, rendered at `SurveyDrawScreen.kt:2021`, no typed
entry); `GRID_CANVAS_SIZE = 8000` is fixed whatever the extent
(`DrawingScale.kt:38`), so `unitsPerFoot = 8000 / extentFt` (`:41`);
`setGridExtent` (`SurveyViewModel.kt:884`) **rescales every point, gate and
marker** by the resize ratio; `drawGrid` (`SurveyDrawScreen.kt:2320`) paints only
inside the fixed content rect; pinch zoom is clamped 0.25×–12× (`:676`).

1. **Bigger fixed ceiling** (5000/10000/20000 ft). Ships same day, reuses the
   rescale machinery. Resolution keeps degrading — 20000 ft is 0.4 canvas units
   per foot.
2. **Typed extent.** Same machinery, no chip list ceiling.
3. **True pan/zoom with no rescaling** — what he actually described. But it
   retires `setGridExtent`'s ratio-rescale path, which the code's own comments say
   already caused one real bug (gates re-matching to the wrong side after a
   resize), and it changes how satellite's 400 ft pin is expressed, since today
   extent and scale are the same lever by construction
   (`SurveyViewModel.kt:1109`) and that agreement with the office's 20 px/ft trace
   is load-bearing.

### D2. Erase a run — the button exists and is ungated. See X1.

`RunSelector` (`SurveyDrawScreen.kt:2077`) is select-only; `FenceRunRow`
(`JobDetailScreen.kt:897`) offers duplicate but not delete. The only delete is the
ungated one in `RunEditScreen`.

### D3. Teardown drawing and billing are already correct.

What still sends him to the marker area: `SiteMarkerKind.EXISTING_FENCE` sits in
the marker picker (`SurveyDrawScreen.kt:1568`) with nothing distinguishing it from
the real billable teardown run. Fix is a relabel or a removal — but removing the
enum value affects any job that has one placed for a legitimate note-only reason.

### D4. Show what is charged — small, and it would have caught the tax bug.

Add a row under Tax showing the base: `Tax base: $2,955.59 of $9,475.34
materials`, from `totals.taxableSubtotal`, whenever it differs from
`materialsSubtotal`. Display only, no engine change.

### D5. Do NOT remove the job page's teardown fields.

Each control there is the only way to set or price that charge; deleting one costs
him the ability to charge for it. If it still reads as redundant the fix is
presentation, not removal — show which drawn run the figures came from.

---

## Decisions needed from March before building

1. **A3** — should the customer's "Balance due" become a live paid-down figure
   (Total − what they have actually paid), or stay a payment-schedule figure
   (Total − the deposit asked)? Different answers, different copy on a public
   page.
2. **A2** — which screen and which job showed a labour figure where the materials
   deposit should be? The code is materials-correct; without this it cannot be
   fixed.
3. **D1** — which reading of "unlimited"? Option 1 ships today; option 3 is what
   he described and retires machinery that has already caused one bug.
4. **Guest demo duration** — `GuestSession.kt:16` says 5 minutes and its comment
   says that is what he asked for. He now says an hour. One line plus three
   strings once confirmed.
5. **C1** — what does "cancellation filled" mean: a status with a typed reason, or
   a cancellation fee that reaches the price?

---

## Not yet returned when this was saved

Three of the seven surveys were still running: **keys/plans (E1, E2)**,
**customer-facing (C2 quote+Stripe, C3 signature by email)**, and **office (the
Dismiss bug, F1 dropdowns, F2 merge the two change feeds, F3 admin email, F4
company reply-to)**.

Their results are in the run's journal and can be read without re-running them:

```
C:\Users\march\.claude\projects\C--Users-march-OneDrive-Desktop-Claude\1efd664f-6d97-4c6b-86ea-0ee58b04bfdb\subagents\workflows\wf_f0e52f0f-8be\journal.jsonl
```

Each `{"type":"result",...}` line holds one agent's full return value. If that
directory is gone, re-commission those three from the prompts in:

```
C:\Users\march\.claude\projects\C--Users-march-AndroidProjects-FenceEstimator\1efd664f-6d97-4c6b-86ea-0ee58b04bfdb\workflows\scripts\fenceflow-owner-list-survey-wf_f0e52f0f-8be.js
```

---

## Where to start, on the evidence so far

1. **X1** — crew can delete a fence run. A standing rule is broken today.
2. **X2 + X3** — a signed-out session has every permission, and demo data can
   become real data. Both are in the way of the read-only demo he asked for, and
   X3 touches real customer records.
3. **B3** — confirmed, well understood, and he reported it himself.
4. **D4** — smallest useful thing on the list, and it makes the next tax-shaped
   problem visible instead of invisible.
5. **B2**, then **B1**.

Ask the five questions above before starting A3, A2, D1, C1 or the demo duration.

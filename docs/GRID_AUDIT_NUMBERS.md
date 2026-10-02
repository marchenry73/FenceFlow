# Grid audit, lens three: numbers that can disagree with themselves

Written 2 Oct 2026, about 01:15 EDT. **A hunt. No source file was changed, no SQL applied, nothing
deployed, staged, pushed or sent, and `gradlew` was not run.** Live reads were SELECTs only through
`supabase db query --linked`, counts and one-row probes, each with a positive control (a row or count that
had to come back) and the raw output checked for `ERROR` before it was parsed. One probe came back as an
empty file (the CLI timed out, exit 124); I reran it and did not read the empty file as "no rows". No
customer name, address, phone or email was selected. Jobs are named by the first eight characters of their
sync id. **By matching figures, `10b0407f` is job D in `MONEY_AUDIT_SURFACES.md` and job 4 in
`MATERIALS_AUDIT.md`; `4598150b` is job H there.**

Evidence is tagged: **RUN** (executed here), **LIVE** (read-only SELECT on his company), **READ** (code
read, not executed), **GUESS** (inference, said so).

The files were moving under me. `EstimateEngine.kt` was edited at 00:46 and `SurveyViewModel.kt` at 00:56
while I read, and `JOIN_PRICING_READY` went from false to true in the middle of it. At 01:04 `joinAdjustments`
had no caller; at 01:16, as I was finishing, another wave had added four. F2 below says what I saw at each time.
Re-run the greps in section 7 before acting on it.

## 0. Read this first

1. **LIVE. A two-point run with "Closed perimeter" ticked is measured out and back, twice its length, and it
   is on a real signed job.** Job `10b0407f` (COMPLETED, accepted at $15,540) has one 60.04 ft vinyl run of two
   points with the box ticked. The phone, the contract PDF, the server and the office all measure it at
   **120.07 ft**, and the engines count it as 2 corner posts and no end posts. The customer's quote link measures it at 60 ft. The
   footage stamped on the signature, 716.726, is 596.66 + 120.07, so the doubled figure is what was signed.
   The link tells the customer **657 ft**; the contract says **716.7 ft**. Labour alone on the extra 60 ft is
   $480.32 at $8/ft. (F1)
2. **READ and RUN. "Joined sides share one post" was switched on in the code and did nothing on the phone at
   01:04. By 01:16 another wave had wired it.** `EstimateEngine.joinAdjustments` had no caller anywhere in the
   app while `JOIN_PRICING_READY` was `true` and its comment, and the header of `RunJoinArithmetic`, said the
   phone priced joints. The office did (`price-job` reads the joint columns since today). Callers now exist in
   `TakeoffRefresher.refreshRun`, `EstimateViewModel.takeoff`, `postWorkings` and `regenerateInternal`, each
   over all runs; I read them and they look right. Zero joints exist, so no money has moved either way. The
   two tests that guarded this looked for the word, not for a call, so they stayed green throughout. (F2)
3. **RUN. The same L-shaped fence prices three ways.** 35 ft + 35 ft, vinyl, 8 ft panels, through the real
   server engine: drawn as one polyline, **10 posts / 9 panels**; as two runs joined at the corner, **11 / 10**;
   as two runs not joined, **12 / 10**. The comment on the join arithmetic says a join "prices as drawing them
   as one polyline does". It does not. The by-hand count a contractor would make is 11 / 10. (F3)
4. **The scale has four different fallback rules among its readers, and the SQL one is the odd one out.**
   For a job with no stored calibration: the drawing screen and the crew plan read 8000/extent, the engines and
   most other screens read a flat 20, the **re-approval fingerprint reads zero** (so a drawing change on an
   approved job with no calibration never withdraws the approval), and for an uncalibrated survey photo the
   price refuses while eight other surfaces quietly invent a footage at 20 px/ft. No live job is exposed today
   (the two null-calibration jobs have no runs and look like fixtures), so this is latent, not bleeding. (F4)
5. **READ. The materials list is re-priced only while the drawing screen is open.** Edit a run's spacing,
   panel width or height in the run editor, change the waste percent, or "make the drawing match N ft" on the
   estimate, and the takeoff block on the estimate screen changes at once but the priced lines and the total do
   not. The next tap on the drawing then re-prices that run with every pending change at once. The home list
   total is also only recomputed when the `jobs` table changes. (F5)
6. **"Total footage" is one number with fifteen definitions** (section 2.2): typed or drawn first, teardown in
   or out, change-order feet in or out, doubled closed pair or not, and which scale. The survey headline "job
   total" counts teardown runs and ignores typed ones; crew pay and the duration estimate count teardown runs
   as built. (F6, F7, F9, F10)
7. **RUN. The same run reads 16 ft on the quote link and 17 ft on the contract.** Half-foot sides (16.5, 48.5)
   round to different whole feet on the phone and on the quote page 37% of the time at an arbitrary heading.
   It is display only, and it is on the document the customer reads. (F8)
8. **LIVE. Two definitions of "accepted".** The phone and server prices treat a drawn signature or an online
   approval as accepted; the re-approval trigger protects only the online approval. Job `8c6b2b44` ($19,810,
   signed in the app, never approved on the quote page) was signed at 801.3 ft, which is its vinyl run alone,
   and the app now measures 994.8 ft because a 193.5 ft wood run sits beside it. Nothing withdrew or flagged
   it. (F13)
9. **LIVE. The office has a second labour formula, and `MONEY_AUDIT_SURFACES.md` section 3.4 says there is
   none.** `quotedLaborOf` in `dashboard.html` is `rate x signed feet + flat`, with no gate deduction. It
   overstates quoted labour by gate feet x rate: **$80, $80 and $120** on his three signed jobs with gates.
   The "labour over budget" alert and the labour-vs-quoted column read it. (F11)

What cannot disagree is in section 4. Section 4 is not short on purpose.

## 1. How this was done

| Tag | What |
|---|---|
| RUN | The repo's own TypeScript engine (`supabase/functions/_shared/pricing/*.ts`, the Float-exact port that 85 parity fixtures hold to the Kotlin) imported into node 24 and called on drawn shapes (section 7). A transcription of `landSide` copied from `tests/a41-footage-existing-sides.test.mjs` lines 48-165 for the Monte Carlo runs. No Kotlin was run: there is no `kotlinc` on this machine and Gradle was off limits. Kotlin statements are READ, and where I say a Kotlin result I mean the port's result with the Kotlin read beside it. |
| LIVE | 16 read-only SELECTs (two of them metadata: a column list and the trigger's presence). Scale, runs, signed footage, per-run bay arithmetic, approval coverage, gate feet. Counts and short rows only. |
| READ | `FenceGeometry.kt`, `SideLength.kt`, `GateSpan.kt`, `DrawingScale.kt`, `EstimateEngine.kt`, `TakeoffRefresher.kt`, `JobMoney.kt`, `CrewPay.kt`, `DurationEstimator.kt`, `PdfExporter.kt`, `SurveyViewModel.kt`, `SurveyDrawScreen.kt`, `EstimateViewModel.kt`, `EstimateScreen.kt`, `CrewJobScreen.kt`, `CrewFencePlanScreen.kt`, `JobSync.kt`, `AutoSync.kt`, `ReportsViewModel.kt`, `JobsViewModel.kt`, `price-job`, `pricing/*.ts`, `quote-view`, `website/quote.html`, `website/dashboard.html`, `website/js/lib/pay.mjs`, `supabase_reapproval_on_drawing_change.sql`. |

Not trusted: any comment that says what the code does. Every claim below that a function "is called" or
"is not called" was checked with a grep for the call, not the name.

## 2. The matrix: every number he reads off the drawing, and every place it is made

### 2.1 A side's length

Made by one function in the app, and again by four ports.

| Where | How | Same as the takeoff? |
|---|---|---|
| Takeoff, canvas dimension labels, side chips, "set this length" dialog, closing side | `FenceGeometryEngine.analyze`, through `sideLengthFeet` (`SideLength.kt`). One call, one float. | yes, by construction |
| Server `price-job` | `geometry.ts analyze`, Float-exact port | yes (parity fixtures; RUN on 5 shapes) |
| Customer quote link | `quote.html runFeet`: `Math.hypot` in doubles over the float coordinates, `/ (cal \|\| 20)` | to about 1e-6 ft; differs in rule, see F1, F4, F8 |
| Office run panel, per-foot pay, reports | `pay.mjs runLengthFt`, `Math.hypot` in doubles | same, and doubles a closed pair like the phone |
| Re-approval fingerprint | `reapp_run_takeoff`, plpgsql doubles, rounded to 0.1 ft | agrees except where `ppf` is null (F4) |

Rounding on the way to the screen: the label and chip round to the **inch**, the total to **0.1 ft**, the
dialog to an **eighth of an inch**. Adding twelve chips by hand can miss the printed total by up to half a foot
(F8).

### 2.2 Run footage and job footage

"Typed" is `manual_linear_feet`. "Teardown" is `is_teardown`. "Closed pair" is a closed run of exactly two
points. "Photo" is an uncalibrated survey photo.

| # | Surface | Where | Typed wins | Teardown runs | Closed pair | Null calibration | Change-order feet | Shown as |
|---|---|---|---|---|---|---|---|---|
| 1 | Phone billing | `EstimateEngine.linearFeet` :516, `footageOf` :536 | yes | out | doubled | grid 20, photo **0** | in `billableFeet` | Float |
| 2 | Server billing | `totals.ts linearFeet` | yes | out | doubled | grid 20, photo 0 (run blanked in `load.ts`) | in | Float |
| 3 | Estimate run header | `EstimateScreen RunSection` | yes | **0.0 ft** | doubled | as 1 | no | `%.1f` |
| 4 | PDF per run / PDF total | `PdfExporter` :369 / :486 | yes | 0 | doubled | as 1 | no / **yes** | `%.0f` / `%.1f` |
| 5 | Survey headline, active run | `SurveyDrawScreen` :829 | **no, drawn only** | counts | doubled | `?: 20`, but the panel hides it | no | `%.1f` |
| 6 | Survey "job total" | `SurveyDrawScreen` :865 | **no** | **counts** | doubled | `?: 20` | no | `%.1f` |
| 7 | Crew job screen | `CrewJobScreen` :368 | yes | counts | doubled | `cal ?: 20`, **photo invented** | no | `%.0f` |
| 8 | Crew plan card | `CrewFencePlanScreen` :383 | yes | counts | doubled | `drawingScale ?: 20`, **photo invented** | no | |
| 9 | Duration hours | `DurationEstimator` :115; `JobDetailScreen` :1598, `JobDetailViewModel` :167 | yes | **counts, and sets teardown hours** | doubled | `cal ?: 20`, **photo invented** | no | hours, stored |
| 10 | Per-foot crew pay | `CrewPay.builtFeet` :258 | yes | **counts** | doubled | `cal ?: 20`, **photo invented** | no | pay |
| 11 | Reports "fence types" | `ReportsViewModel` :507 | **no** | counts | doubled | **skipped** | no | |
| 12 | Quote link, per run / chip | `quote.html runFeet` :740, `installTotals` :760 | yes | listed / out of chip | **not doubled** | `\|\| 20`, **photo invented** | no | `Math.round` both |
| 13 | Office pay and reports | `pay.mjs runBuiltFeet`, `dashboard.html feetOfJob` :17796 | yes | `feetOfJob` out, `jobBuiltFeet` **in** | doubled | `\|\| 20` | no | |
| 14 | Office run panel label | `dashboard.html runFootageLabel` :20911 | **no when drawn** | | doubled | `\|\| 20`, **photo invented** | no | `Math.round` |
| 15 | Re-approval fingerprint | `reapp_run_takeoff` | yes | tracked apart | doubled | **0** | no | 0.1 ft |
| + | Signed footage, stored | `jobs.signed_linear_feet` | = billableFeet at signing | | | | in | Float |

Where two rows disagree, the reader sees two footages for one fence. The disagreements that exist in his data
today are F1 and F13; the rest need a typed-and-drawn run, a teardown run, a photo, or a non-400 grid with no
calibration, none of which his live drawn runs contain (section 3, LIVE counts).

### 2.3 Posts, panels, corners

| Number | Made | Can two copies disagree |
|---|---|---|
| Corner and end count | `analyze` vertex classification, 15 degrees. Ported to `geometry.ts`, `reapp_run_takeoff`. Typed run: `manualCornerCount`, which defaults to 0. | Drawn: no. **Typed over a drawing: yes** (F6). |
| Line / corner / end / gate posts, caps | `computePostCounts` (Kotlin :766, `takeoff.ts`). Rounds `bays = ceil(net / spacing)` on the **whole run**. | Phone vs server: no (parity). Against a by-side count: yes, F3 and `MATERIALS_AUDIT.md` finding 4. |
| "End posts" on the takeoff block vs the END_POST line | Block shows `posts.endPosts` (the run's two). The line item merges in a gate's END_POST (WALL and LINE_TO_WALL). | Per role yes; summed over all post roles no. The block lumps gate posts into "Gate posts". Label problem, not arithmetic. |
| Shared-post markers on the plan | `RunJoinGesture.markers`, built from `RunJoinArithmetic.adjust` | The marker and the phone's takeoff **will** (F2). Marker and office: no. |
| Survey panel "N corners" | same `analyze` over the live draft | vs takeoff: no for drawn runs; yes for a typed override (F6) |
| Panel count | `ceil(net / panelWidth)`; `net` is a Float | Zero tolerance: a side labelled 48'0" at 48.02 buys a ninth 6 ft bay. Typed and snapped sides are landed under the target; dragged sides are not (GUESS: about 1 run in 80 shows an exact multiple and buys one more). |

### 2.4 The scale

Stored on the job: `calibration_pixels_per_foot` (call it cal), `grid_extent_ft`, `grid_feet_per_square`,
`calibration_known_feet`. For a grid job cal should equal `8000 / extent`.

| Reader | Rule | Null cal, grid, extent not 400 | Null cal, photo | cal zero or negative |
|---|---|---|---|---|
| Drawing screen, crew plan card, `editScale`, PDF standalone gates | `DrawingScale.of`: stored if > 0, else 8000/extent for a grid, else none | **8000/extent** | none (asks for a calibration) | treated as absent |
| Phone billing, `TakeoffRefresher`, estimate takeoff block, post workings | `cal ?: 20`; photo with no cal bills nothing | **20** | 0 | footage 0 |
| Suggest Quantities (`regenerateInternal`) | seeds `calibrationToSeed` (8000/extent) and writes it to the job first | seeds | refuses | |
| Server `load.ts` | `cal ?? 20`; photo run blanked | **20** | 0 | footage 0 |
| Re-approval fingerprint | `ppf := calibration_pixels_per_foot`; `ppf > 0` required | **footage 0, corners 0** | 0 | 0 |
| Crew job screen, duration, per-foot pay | `cal ?: 20` | 20 | **20, invented** | |
| Office, quote link, quote e-mail | `Number(cal) \|\| 20` | 20 | **20, invented** | **20** |
| Reports "fence types" | `cal ?: return` | skipped | skipped | |

`price-job`'s `JOB_COLUMNS` has no `grid_extent_ft`, so the server cannot read the extent at all. The only
place that knows `8000` is the phone (`DrawingScale.GRID_CANVAS_SIZE`).

Writers of the scale pair, to see how it can split: `setGridExtent` (writes extent and cal together, rescales
every point, gate and marker by the ratio, one run at a time and the job last, not one transaction),
`ensureGridCalibration` (seeds cal when null, on screen open), `applyCalibration` and `recalibrateFromRun`
(write cal and `calibration_known_feet` only), `clearSurveyImage` (seeds), `importImage` (writes null),
`resetGridCalibration` (now through `setGridExtent`). The office wizard writes cal 20 on every new job.

### 2.5 Rounding, wherever one number is shown more than one way

| Number | Shown as | Where |
|---|---|---|
| A side | inch (`formatCompact`) / eighth inch (`format`) | canvas label and chips / dialog |
| Run or job footage | `%.1f` | survey headline, perimeter, estimate header, PDF total |
| Run or job footage | `%.0f` | PDF per run, job screen teardown line, crew screen, stale-signature reason |
| Run or job footage | `Math.round` | quote link per run and chip, office run panel |
| Run footage in the fingerprint | `round(x, 1)` | decides whether an approval is withdrawn |
| Gate feet | `%.0f` | PDF "Gates (N ft)", estimate totals card |
| Money, a row | `NumberFormat` currency, **HALF_EVEN** | phone (`Money.format`) |
| Money, a row | `Intl.NumberFormat`, half away from zero | office and quote page |
| Money, the total | `Math.round(x * 100) / 100`, half up, once | both engines |
| Panels, bays, pickets | `ceil`, no tolerance | both engines |
| Concrete | summed first, `ceil` once; waste not rounded twice | both engines |

### 2.6 Stored and also recomputed

| Stored | Recomputed | Can drift | Note |
|---|---|---|---|
| `signed_linear_feet` | `billableLinearFeet` | yes, by design; tolerance **2 ft absolute** (`FOOTAGE_TOLERANCE`) | 10% of a 20 ft fence, 0.1% of a 2,000 ft one. LIVE: F13. |
| Estimate line items | live takeoff | yes (F5) | the lines are a snapshot of one moment |
| `jobs.contract_total` | `computeTotals` | yes, by design | the money lens owns it |
| `estimated_duration_hours` | `DurationEstimator` | yes | written only by phones that may reschedule |
| `jobs.calibration` + runs' points | each other | yes, if the runs and the job row land apart | `AutoSync` pushes the job first, then runs, so the fingerprint sees new points and new scale together |

## 3. Findings, ranked

Severity: **HIGH** is a wrong number on a real signed job, or a number that will be wrong the day a flag flips.
**MEDIUM** is two surfaces that disagree on a case that can happen. **LOW** is display.

### F1. A closed perimeter on two points measures the line twice (HIGH, LIVE)

**What happens.** `FenceGeometryEngine.analyze` runs `segmentCount = if (closedLoop) n else n - 1`
(`FenceGeometry.kt` :162 and :184). For `n = 2` that is two segments, a to b and b to a. Both vertices have a
180 degree turn, so they classify as CORNER and the run has no ends. `SurveyViewModel.toggleClosedLoop` (:831)
has no guard, and the box can be ticked before the third point is drawn. The server port, the plpgsql
fingerprint (`seg_count := ... n`) and the office (`runLengthFt` concatenates the first point on) all do the
same. `quote.html` alone requires `pts.length > 2` before it closes a loop, so it alone shows the true length.

**How to see it.** Draw two points, 40 ft apart, tick Closed perimeter. The panel reads 80.0 ft total and
lists two sides. Or LIVE: job `10b0407f`, run `77f7c166`: 2 points, open length 60.04 ft, `closed_loop` true.

**Evidence.**
- RUN (server port): two points 40 ft apart, open **40 ft, 2 ends, 0 corners, 6 posts, 5 panels**; closed
  **80 ft, 0 ends, 2 corners, 10 posts, 10 panels**.
- LIVE: job `10b0407f` has two live runs: 596.66 ft (4 points, gates) and 60.04 ft closed pair measured at
  **120.07 ft**. `signed_linear_feet` = 716.726 = 596.66 + 120.07. `accepted_total` 15,540, status COMPLETED,
  `reapproval_count` 1, no line items today (`MONEY_AUDIT_SURFACES.md` F1).
- READ: the quote link for that job lists the run at "60 ft" and totals the chip at 657. The contract per run
  says "120 linear ft" and the total line "716.7 ft".
- `MATERIALS_AUDIT.md` section 1.3 describes this run as "two sides of 60.05 ft". It is one line with the box
  ticked, and it is the only live run in that table whose footage is doubled.

**Costs him.** On this job: 60.04 ft of labour at $8 = **$480.32**, plus the panels, posts, concrete and the
two corner-post rows that the doubled run bought while the lines existed (GUESS that they did: the signed
$15,540 is far above today's labour-only $5,853.81). All of it is inside the signed price. He cannot re-price it
away, because the accepted price is anchored; what is at stake is that the contract and the link he sent
disagree by 60 ft. One run in 17 live is a closed pair.

**Solution, argued.** Make "closed" mean something only at three points or more, in the one funnel every
reader goes through: `analyze` (Kotlin), `geometry.ts analyze`, `reapp_run_takeoff`, `runLengthFt`, and
`toggleClosedLoop` (keep the flag, ignore it below three points, so ticking first still works).
- *Only disabling the checkbox* leaves the live row, anything the office wizard writes, and every old row.
- *Only fixing the engine* leaves the survey panel listing a second side that is the first side backwards.
- Both engines get a version bump and the 85 fixtures regenerate in the same commit (as for 2026.10.1).
- **Decision for him, not for me:** the live row. After the fix `10b0407f` measures 596.66 + 60.04 =
  656.7 ft and `signatureIsStale` will say the fence "went from 717 to 657 ft" on a COMPLETED job. Do not
  re-sign. Leave the stored 716.726, or untick the box on `77f7c166` and let the stale note stand once.

### F2. The phone did not price joined posts while the code said it did (HIGH at 01:04, wired by 01:16, READ and RUN, not exposed)

**What happened at 01:04.** `EstimateEngine.joinAdjustments` (:697) was defined and had **no caller**. The three places
that call `suggestQuantities` (`TakeoffRefresher.refreshRun` :167, `EstimateViewModel.takeoff` :93,
`regenerateInternal` :252) and `explainPosts` (:118) pass no `joinAdjustment`, so it is the default `null`.
The claims to the contrary:
- `FenceGeometry.kt` :731: "BOTH PRICING ENGINES NOW CALL THIS."
- `SurveyViewModel.JOIN_PRICING_READY = true`, whose comment says `EstimateEngine.joinAdjustments feeds
  RunJoinArithmetic.adjust on the phone`.
- `SurveyDrawScreen` :2416 shows `attach_price_later` ("price unchanged") only while the flag is false, so with
  it true the dialog will promise a saving.

The office is on the other side: `price-job` `JOIN_COLUMNS_LIVE = true` (since today), `RUN_COLUMNS` select the
joint columns and `priceJob` calls `adjustJoins` over all runs (`pricing/index.ts` :727, :736).

**Why the tests are green.** `a57 check 2h` asks whether an engine file *references*
`RunJoinArithmetic|JoinableRun|JoinAdjustment|RunPostAdjustment` after comments are stripped; `EstimateEngine.kt`
does, because it defines the function. `a61 check 7f` asks whether `fun joinAdjustments(` exists. Neither asks
whether anything calls it.

**What I saw at 01:16.** `grep -rn "joinAdjustments(" app/src/main --include=*.kt` now returns the definition and
four calls: `TakeoffRefresher.kt` :173 (re-reads every run of the job from the repository, then `forRun(run.syncId)`),
`EstimateViewModel.kt` :84 (`takeoff`, computed once outside the per-run map), :140 (`postWorkings`) and :278
(`regenerateInternal`, from `runs.value`, the screen's snapshot rather than a fresh read). That is the shape I
would have asked for: once over all runs, handed to each run. **Not checked:** that a test now fails if one of
the four is removed (I did not re-read `a57` or `a61`), that a joint prices the same on phone and office
(there is no joint to price; `a61` is the test that would show it), and whether `regenerateInternal` should
read the runs from the database like the other three.

**Costs him.** Nothing today: 0 of 17 live runs carry a joint (LIVE) and `EntitySync.JOIN_COLUMNS_LIVE` is
false, so the phone cannot send one. Had the phone started sending joints at 01:04: for each joint the office
quotes one post, one cap, one bag fewer and a corner-post row instead of two end-post rows; the phone and
the stored lines it writes keep two end posts. They overwrite each other's line items (same deterministic
sync ids) and each pushes its own `contract_total`; `JobSync` already documents a price that flipped between
two figures every few seconds for a similar reason (two devices each pushing their own total).

**Solution, argued.**
1. Wiring, as above, once per pass over all runs. Not per run: the owner of a shared post is chosen across runs,
   and a per-run call sees one candidate, so every member keeps its post. Done by 01:16 at four sites.
2. Still open: a test that counts **calls** (`joinAdjustments(` outside its definition) and fails at fewer than
   four, with a planted canary that removes one. The probe behind `a57` 2h cannot fail for want of a call, and
   an unguarded wiring is how a flag came to say it was done while nothing called the function.
3. Order of flips, to keep: `EntitySync.JOIN_COLUMNS_LIVE`, `JOIN_STORAGE_READY` last. A join made while the
   phone cannot send it is stranded on the handset (the run never pushes again), so the tool must not appear
   first. Between 01:04 and 01:16 the right answer was to set `JOIN_PRICING_READY` false until the callers
   landed; with them in, true is correct.

### F3. One fence, three prices: per-run rounding, and "joined" is not "polyline" (HIGH, RUN)

**What happens.** `computePostCounts` rounds `ceil(net / spacing)` once over the whole run's footage
(`takeoff.ts`, `EstimateEngine.kt` :794). A corner, an end or a gate cannot share a bay across itself, so a
by-side count is higher, and the number depends on how the fence was drawn.

**Evidence (RUN, real server engine, vinyl, 8 ft panels and spacing, no gates):**

| Fence | Posts / panels | By hand, per side |
|---|---|---|
| L, 35 + 35, **one polyline** | 10 / 9 | 11 / 10 |
| the same L as **two runs, joined** (`adjustJoins` applied) | **11 / 10** | 11 / 10 |
| the same L as **two runs, not joined** | 12 / 10 | 11 / 10 |
| L, 40 + 30, one polyline | 10 / 9 | 10 / 9 |
| the same, two runs not joined | 11 / 9 | 10 / 9 |
| U, 10 + 10 + 10, one polyline | **5 / 4** | 7 / 6 |
| one straight 30 ft | 5 / 4 | 5 / 4 |
| square 4 x 25, closed | 13 / 13 | 16 / 16 |

A U of three 10 ft sides prices exactly like 30 ft of straight fence. The comment on `RunJoinArithmetic` ("a
turn... joining two runs prices as drawing them as one polyline does", `FenceGeometry.kt` :792) is true of the
kind of post and false of the count: the joined L comes out one post and one panel higher than the polyline.
LIVE, my own count of gross bays on his 12 drawn non-teardown runs (gates ignored): the whole-run rule is short
of the per-side count on 5 runs, 9 bays in all (run `e4c67e4a`: 5; `3a05e599`, `efa01dbd`, `16d83d9f`,
`8cf44e18`: 1 each; the other 7 runs are exact). That agrees in direction with the table in
`MATERIALS_AUDIT.md` section 1.3, which prices it at $22.05 a missing post.

**How to see it.** Draw 35 ft, turn, 35 ft. Open the post workings dialog (tap the post count). Draw it as two
runs and compare.

**Costs him.** Under-quoted by about a post, cap and bag per awkward side ($22.05 in `MATERIALS_AUDIT.md`,
plus a panel where the panel count is also short), small on any one job and always in the same direction. The larger cost is that the answer depends on
how he drew the fence, which is the thing he cannot see.

**Solution, argued.** Count posts and panels **per drawn side** (the sides are already in
`FenceGeometryResult.segments`, which `computePostCounts` never reads), gates assigned to the side
`GateGeometry.spanFor` already puts them on. Then a polyline and joined runs agree by construction, and a U
stops costing the same as a straight line.
- *Keep per-run for* chain-link fabric, rails, pickets, top rail: those are bought by the foot, and per-run is
  right for them.
- *Offcut reuse* (the argument for leaving it): real for vinyl panels and not for posts, so posts must go per
  side whatever is decided for panels; `MATERIALS_AUDIT.md` reaches the same split.
- *Typed footage* has no sides and stays per run.
- Both engines, version bump, fixtures. Anchored totals never move. Unsent quotes re-price up by the amounts
  above. This is a price decision, so it is his.

### F4. The scale has four fallback rules, and the SQL one reads zero (MEDIUM, latent)

**What happens.** See the table in 2.4. A job with no stored calibration is measured at 8000/extent on the
drawing screen and crew plan, at a flat 20 by the engines and most other readers, and at **zero** by the
re-approval fingerprint. They agree only at extent 400. For an uncalibrated survey photo the engines and the
server refuse (0 ft, and the server blanks the run), while the crew job screen, the crew plan card, the
duration estimate (which then *stores* hours), per-foot pay, the office run panel, and the quote link and
quote e-mail all fall back to 20 px/ft and print a footage and a 3D fence at it.

Two more ways the guard on photos is defeated:
- `importImage` writes a null calibration for a new photo, but a null never travels (`SurveyNullsDoNotTravelTest`),
  so the cloud's older value, usually the grid's 20 seeded when the job was opened, comes back. The new photo
  is priced at it. Tested, documented and decided ("unmeasured, and shown as such, but priced").
- The server decides "photo" from `survey_storage_path`, the phone from the local path *or* the storage path.
  A photo imported on a phone that has not uploaded yet is a photo on the phone (blocked, 0 ft) and a grid job
  on the server (priced at 20) until the upload lands.

The fingerprint's zero matters because the trigger exits when there is no calibration: before and after a
drawing change both read `b=0.0|c=0|e=0`, so only a gate change registers. An approved job with no calibration
can have its fence lengthened and keep its approval.

**LIVE.** 11 live jobs: 2 with null calibration, both at extent 400, both with 0 runs and ids beginning 44444444 (they look like fixtures); 0 grid jobs
whose calibration disagrees with 8000/extent (the extent-25 and cal-20 pair patched on 29 Sep was the one, and is fixed);
1 photo job and it is calibrated. So today nothing is exposed.

**Costs him.** Latent. When it fires it is a quote link showing "N ft" beside a $0 total, a crew screen
showing a footage the price refuses to bill, or an approval that survives a bigger fence.

**Solution, argued.** Make "a grid job always has a calibration" an invariant rather than teaching every reader
8000/extent:
1. Write the calibration when a job is created (the phone and the office wizard; the wizard already does) and
   backfill the two fixtures.
2. Make the SQL fingerprint fall back to 20 exactly as `load.ts` does, until the invariant is a constraint.
3. One `isMeasurable(job)`/scale function with the photo rule, used by the crew screens, duration, per-foot
   pay, the office and `quote-view`; each shows "not measured" when it returns null.
- *Teaching the engines 8000/extent* is the alternative. Rejected: the server has no extent column in its
  input, so it is a contract change on `price-job` and a version bump to fix a state that does not occur.
- *Seeding 20 on photos* is the invented number the photo rule exists to refuse.

### F5. The materials list follows the drawing only while the drawing screen is open (MEDIUM, READ)

**What happens.** `TakeoffRefresher.refreshRun` is called from two places: the survey view model's watcher
(`watchDrawingForRepricing`) and `repriceAfterScaleChange` (calibrating on the drawing). The Suggest button
rebuilds on its own path (`regenerateInternal`). The watcher lives in `SurveyViewModel`, so it runs only while
that screen is on the back stack. The run editor
is opened from the job screen, not from the drawing, so editing a run's panel width, spacing, height, colour
or rails there changes the run and reprices nothing. Waste percent, `recalibrateFromRun` (the estimate's
"make the drawing match N ft") and a drawing change that arrives by sync while the drawing screen is closed do the same. Meanwhile
`EstimateViewModel.takeoff` is derived live, so the block above the lines moves at once.

Consequences, all READ:
- The takeoff block says "Panels 14" over a priced line "Panels x13"; the total follows the line.
- The note "press Suggest after changing this" appears only while waste is above 0. Set it back to 0 and the
  note goes while the lines keep the old waste.
- The next drawing tap re-prices that run with every pending change at once, so the price jumps for a reason
  that is not the tap. That reads as a number changing by itself.
- `JobsViewModel.jobTotals` and `outstandingTotal` are keyed to `observeJobs()` (and payments), and Room only
  invalidates on the `jobs` table. A line-item rewrite does not refresh the home list row until the job row
  changes or the list leaves composition for more than the 5 s `WhileSubscribed` window. GUESS on the window.

**How to see it.** Job, then a run, change the post spacing, then Estimate: the block moves, the lines do not.

**Costs him.** A quote total that does not match the specs on the screen, by the size of the change.

**Solution, argued.** The cheap honest fix first: compute "lines are out of date" (generated lines against the
live takeoff for the run) and show a banner with a Suggest button. It can never move a price silently. Then,
separately, move the watcher out of `SurveyViewModel` into the repository so a run-row write marks the run
stale whoever wrote it. *Counter-argument for auto-reprice everywhere:* it moves prices without being asked,
on jobs nobody is looking at. The existing rules (`mayReprice`, never touch hand-edited lines) make that safe
for unaccepted jobs, but it is a behaviour change he should choose.

### F6. A typed length over a drawing: the screens disagree about which one is the fence (MEDIUM, READ, none live)

**What happens.** Typed footage wins outright in every billing path. The survey headline (`liveFeet`, :829) and
the office run label (`runFootageLabel`, "N ft measured" whenever there is a drawing) show the **drawn**
length for the same run. The corner count for a typed run is `manualCornerCount`, default 0, so a drawn L with a
typed total bills its corner as a line post (RUN: L 40 + 30 with typed 70: 0 corners, 8 line posts, against
1 corner, 7 line posts drawn). The estimate field is enabled on drawn runs, so the state is one tap away.

**LIVE.** 0 of 17 runs have both. Nothing is exposed.

**Solution, argued.** One function, `billedFeet(run)`, for every screen that prints a run's footage, and a chip
"typed 70 ft overrides the drawing's 70.0 ft" wherever both exist. When a drawing exists and the typed corner
count is 0, read the corners from the drawing: the typed field cannot distinguish "0 corners" from "not
entered". *Counter-argument:* a typed corner count is explicit. Yes, so store null for "not entered".

### F7. The survey "job total" counts the old fence and ignores typed runs (MEDIUM, READ)

**What happens.** `totalFeetAllRuns` (`SurveyDrawScreen` :865) is `totalLinearFeetAcrossRuns` over every
run's points: teardown runs counted, typed runs ignored. It shows once a job has more than one run. The
billing figure (`linearFeet`) does the opposite on both counts. With a 100 ft new fence and 90 ft of old
fence drawn as a teardown run, the drawing says 190 and the price is for 100.

**LIVE.** One empty teardown run exists (job `4598150b`, no points), so no number is wrong today.

**Solution.** The headline should call `EstimateEngine.linearFeet` and `teardownLinearFeet` and print both,
"100 ft new, 90 ft old". It is a label problem with a real number behind it, and it also answers "the footage
changed when I added a run".

### F8. The same footage is rounded five ways, and half-foot sides round differently on the quote link (LOW, RUN)

**What happens.** Section 2.5. Three that can be seen by eye:
- A side typed as 16.5 ft is landed on Floats that measure at or just under 16.5 on the phone (`landSide`
  never lands over). When the Float measures exactly 16.5 the PDF and estimate print `%.0f`, which is half-up,
  so **17**. The quote link measures the same coordinates in doubles, often gets 16.4999998, and prints
  `Math.round` = **16**; the reverse happens too. RUN,
  20,000 sides at each heading class: **37.3%** differ at any angle, 25.6% at 45 degrees, 5.0% axis-aligned.
- The quote link rounds each run and the chip separately, so three runs of 10.4 ft read "10, 10, 10" under a
  chip of "31 ft".
- Gate widths print `%.0f`: a 3.5 ft walk gate reads "4 ft" beside a charge computed on 3.5.
- Sides print to the inch and the total to a tenth, so a person adding twelve chips can be half a foot out.

**Costs him.** Nothing in money. It is the customer reading 16 on the link and 17 on the contract.

**Solution.** One display rule for footage on customer documents: whole feet, rounded once from the Float the
engine returns, and the quote function (not the browser) supplies the figure, so the page cannot re-measure.
The cheap half: have `quote-view` return per-run and total feet computed by the shared TypeScript engine.

### F9. The estimate screen shows an old-fence run as a full takeoff and lets Suggest bill it (MEDIUM, READ, none live)

**What happens.** Neither `EstimateViewModel` nor `EstimateScreen` mentions `isTeardown`. A teardown run's card
reads "0.0 ft" (`linearFeet` excludes it) above a full takeoff block (`takeoff` is derived for every run), and
its Suggest button runs `regenerateInternal`, which writes materials for the fence that is leaving.
`TakeoffRefresher.refreshRun` clears the generated lines of a teardown run on the next drawing change.
So the lines appear when Suggest is pressed and vanish at the next tap on the drawing.

**LIVE.** One teardown run, empty. Not exposed.

**Solution.** Treat a teardown run as a card with no takeoff block and no Suggest, and make `regenerateInternal`
refuse it the way `refreshRun` clears it. Two functions disagreeing about whether an old fence needs panels.

### F10. Crew pay and the duration estimate count the old fence as built (MEDIUM, READ, none live)

**What happens.** `CrewPay.builtFeet` and the office `jobBuiltFeet` sum every run with no teardown filter, so a
per-foot crew is paid per foot for fence they tore out, and the office's report footage (`feetOfJob`) excludes
it. `DurationEstimator.estimate` adds teardown runs into install hours and then sets
`teardownHours = feet x teardownHoursPerFoot` over **all** drawn feet, while the price's teardown charge is on
the typed `teardownFeet`, else the drawn teardown run, else the new fence. Hours and money use different
footage for the same teardown.

**LIVE.** 0 per-foot employees of 2; 0 jobs with teardown enabled. Not exposed.

**Solution.** Per-foot pay on `linearFeet` (new fence only) unless he decides removal is paid; duration on the
same teardown footage the charge uses. One decision for him: is tearing out paid by the foot?

### F11. The office has a second labour formula (MEDIUM, LIVE)

**What happens.** `quotedLaborOf` (`dashboard.html` :15741) is `labor_rate x signed_linear_feet + flat`, floored
at the minimum. The engine's labour is `(billableFeet - gateFeet) x rate`, because gates are charged at the
gate rate. The comment above the office function says it "mirrors totals.ts". It reads the stored signed feet,
so an unsigned job is quoted at its flat fee only, and it ignores gates and change orders.
`MONEY_AUDIT_SURFACES.md` 3.4 says "No second formula anywhere"; this is one.

**LIVE.** Three signed jobs with gates, quoted labour overstated by gate feet x rate:

| Job | signed ft | gate ft | rate | office "quoted" | engine formula, same feet | difference |
|---|---|---|---|---|---|---|
| `8c6b2b44` | 801.349 | 10 | $8 | 6,410.79 | 6,330.79 | **$80** |
| `10b0407f` | 716.726 | 10 | $8 | 5,733.81 | 5,653.81 | **$80** |
| `4598150b` | 1,673.36 | 15 | $8 | 13,386.88 | 13,266.88 | **$120** |

`4598150b` also has a gate rate of 0, so its 15 ft of gates are in neither the labour nor the gate charge.
That is a rate he set, not a formula.

**Costs him.** The "labour over budget" alert fires $80 to $120 late on these jobs and the labour-vs-quoted
column reads better than it should.

**Solution.** Do not recompute in the browser. `job_costing` already carries the engine's numbers server
side; read the quoted labour from the stored `contract` parts or have the RPC return it.

### F12. A change order's feet are priced twice live and once billed (LOW to MEDIUM, READ, no live change orders)

**What happens.** `computeTotals` bills `changeOrderCost` and also puts `changeOrderFeet` into `billableFeet`,
so labour is charged on them (the unit test `change orders move the total` pins +$400 and +30 ft x $10 =
+$700). After acceptance the price that stands is `accepted_total` plus the cost of orders signed since
(`JobMoney.extraWorkSinceAcceptance`, written four times and agreeing), which carries **no labour on the
feet**. The live total and the billable total differ by `feet x rate x (1 + markup)` for each new order.
`MONEY_AUDIT_SURFACES.md` 3.11 checked the anchoring rule, which does agree, and found no live order.

**Solution.** His call, one sentence: does a change order's cost include its labour? If yes, drop the feet
from `laborFeet`. If no, add the feet's labour to the anchored extra. The field says only "Additional feet
(optional)".

### F13. Two definitions of "accepted", and a signed footage that no longer matches (MEDIUM, LIVE)

**What happens.** `isAccepted` (phone), `billableTotal` (TypeScript) and `accepted_total` treat a drawn
signature or an online approval as accepted. `reapp_on_run_change` returns at once when
`quote_approved_at is null`, so a job accepted by drawn signature only is never protected by the re-approval
rule. The phone's own check is `signatureIsStale`, 2 ft absolute.

**LIVE.** Job `8c6b2b44`, ACCEPTED, signed in the app 5 Sep at $19,810 and 801.349 ft, `quote_approved_at`
null, `reapproval_count` 0. It has two runs: 801.3 ft of vinyl (exactly the signed footage) and 193.5 ft of
wood. The engine measures 994.8 ft today, +193.5 ft, 24% more fence than was signed. Both runs carry the same
`updated_at` (11 Sep 02:11:38, which looks like a bulk write) and `fence_runs` has no `created_at`, so I cannot
say when the wood run appeared. GUESS: after the signature. Either way nothing withdrew or flagged it: the
rule's migration is dated 17 Sep and the earliest withdrawal in the database is 19 Sep, and a job accepted by
drawn signature is outside the rule anyway. The phone will say "needs re-sign" on that job's estimate screen,
which is the only place this shows.

Of his 6 jobs signed in the app, **all 6** have `quote_approved_at` null today; three of them
(`reapproval_count` 1, 1, 3) were approved on the page and later withdrawn by the rule, which clears it.

**Solution.** Define accepted once and let the trigger use it: `signed_at is not null or quote_approved_at is
not null`, and compare against `signed_linear_feet` when the signature is the acceptance. Make the tolerance
relative (the larger of 2 ft and 1%) so a 20 ft job can't grow 10% silently and a 2,000 ft job doesn't
re-sign for a 21 ft nudge.

## 4. What cannot disagree (checked, and how)

1. **A side's length on the canvas, the chip, the set-length dialog, the closing side and the takeoff.** One
   function (`sideLengthFeet` reads `analyze`). READ.
2. **Phone and server footage for one input.** `geometry.ts` emulates Float arithmetic (`f32`), and 85 parity
   fixtures hold it to the Kotlin. RUN: 5 shapes plus the 2-point loop through the port; no Kotlin was run.
3. **Typed side lengths add up to the typed total.** RUN: 20,000 random drawings (2 to 5 sides of whole feet
   whose total is an exact multiple of 8, five grid scales, arbitrary headings), each side landed with the
   transcription of `landSide`. **0** measured above its typed length, **0** totals above the typed sum,
   **0** extra panels from float dust. The worry that 24 + 24 ft buys a seventh 8 ft panel is closed.
4. **Changing the grid size does not change a length.** RUN: 3,000 runs through 11 consecutive random size
   changes (rescale by `after / before` in Float, calibration to 8000/extent). Worst drift **0.00015 ft**, **0**
   runs whose tenth of a foot changed. Matches the 0.00033 ft in `FOOTAGE_DRIFT.md`.
5. **Gridlines at a hand calibration.** `drawGrid` takes the job's real scale, so a "20 ft" square is drawn at
   the scale the footage is measured at. READ.
6. **Satellite ground scale, phone and office.** Same constants (156543.03392804097, 3.280839895). READ.
7. **The grand total's cent.** Rounded once, `Math.round(x * 100) / 100`, identically in both engines; the
   NaN path is deliberate. READ, vectors in `a29`.
8. **Gate width taken out of the run.** Both engines subtract the same widths from the gross footage, and the
   labour deduction in `computeTotals` is the same. READ and parity.
9. **Concrete.** Summed across gates and posts, then `ceil` once; waste does not round it a second time. READ.
10. **Corner threshold.** 15 degrees in Kotlin, TypeScript and SQL. Exactly 15.000 is the only place two
    float widths could disagree; GUESS that nothing real lands there.
11. **Spacing equal to panel width on panel fences.** The run editor locks them on the phone
    (`defaultSpacingFor`). The office wizard and templates do not lock them (`MATERIALS_AUDIT.md` 5 and 6).
12. **The shared-post marker cannot show a post the arithmetic does not count.** It is built from the same
    `adjust`. At 01:04 that was the problem in F2, because the arithmetic was not what the phone priced; with the
    callers in, the marker, the phone's takeoff and the office are one arithmetic. Not exercised with a real joint.
13. **The deposit request after a part payment.** Not re-derived here; `MONEY_AUDIT_SURFACES.md` F3 holds it
    and I read the same rule in `JobMoney.nextRequestAmount` and `quote-deposit.ts depositFigures`.
    Unchanged since `MONEY_DISAGREEMENTS.md`.

## 5. Not checked

- **Kotlin execution.** Nothing in `app/` was compiled or run. Every Kotlin claim is a reading, backed where
  stated by the port.
- **Sync ordering as a cause of drift.** The "sync puts an older drawing back" suspect in `FOOTAGE_DRIFT.md`
  is still unproven; I did not try to prove it. I did read the push order: `AutoSync` runs `JobSync.sync`
  before `EntitySync.pushAll`, so the job's new calibration reaches the server before the runs rescaled to
  match it, which is the safe order for the re-approval trigger. If the runs push failed after the job's
  succeeded, the server would hold the new scale over the old points. GUESS, not seen.
- **The 5 s window in F5** for the home list. READ of `WhileSubscribed(5000)`, not observed.
- **Whether `CrewJobScreen` and `CrewFencePlanScreen` print footage to crew who may not see money.** They
  print feet, never dollars; I left that as correct.
- **The crew door.** `crew_save_job` carries cal, extent and square size together, so they cannot split there.
  READ of `CREW_WRITABLE_JOB_KEYS`, not exercised.
- **Locale.** The Estimate and survey headlines format with the default locale (`String.format("%.1f")`), so
  in Spanish or French they print a decimal comma. Display only, not followed up.
- **The office run panel against a real browser.** I read the functions; I did not load the page.

## 6. Seen in passing (belongs to the other lenses)

- **A double tap makes a tiny side.** `addDrawPoint` has no minimum distance (`SurveyDrawScreen` :1227). The
  second tap, a few pixels from the first, is kept; `snapDrawPoint` leaves out `previous` from the corners it
  joins. The old end becomes a vertex whose turn depends on the tiny side's heading. READ that it is classified
  like any vertex; GUESS that a stray tap usually turns more than 15 degrees and so reads as a CORNER. The
  total post count would not move, but a line post would become a corner-post row.
- **Dimension labels vanish when zoomed out.** `if (onScreenLen < 56f) continue` (:1502). The chip row in the
  panel always lists every side.
- **`FeetInches.parse` refuses a decimal comma** ("47,5") in the set-length dialog, which is the only caller.
  Fine in English, a dead field on a Spanish or French keyboard.
- **Dead second copies** of footage maths nobody calls: `TakeoffRefresher.footageOf`,
  `FenceGeometryEngine.roundFeet` (the fingerprint's SQL comment says it is "the app's own roundFeet"; the
  app never calls it), `segmentLengthPx`, `stretchSegment`, `EstimateViewModel.regenerateAll`. Each is a
  second implementation waiting to be called by mistake.
- **`setGridExtent` writes the runs one at a time and the job last**, with no transaction. A crash between them
  leaves points scaled and the scale not (`fitSurvey` documents the same window).
- **Run editor spec edits on a job that was accepted** change the run row. The fingerprint reads length,
  corners, ends and gates, not spacing or panel width, so a spec change after approval never withdraws it.

## 7. Reproduce

Greps (as of 01:04 EDT; the join wiring was being edited):

```
grep -rn "joinAdjustments(" app/src/main --include=*.kt        # F2: one line (the definition) at 01:04; five at 01:16
grep -n "JOIN_PRICING_READY = \|JOIN_STORAGE_READY = " app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt
grep -n "JOIN_COLUMNS_LIVE = " app/src/main/java/com/fenceestimator/app/cloud/EntitySync.kt supabase/functions/price-job/index.ts
grep -n "isTeardown" app/src/main/java/com/fenceestimator/app/ui/estimate/*.kt     # F9: nothing
```

Node 24 runs the TypeScript engine directly (use `file:///` URLs on Windows). F1 and the shapes in F3:

```js
import { analyze } from "file:///C:/Users/march/AndroidProjects/FenceEstimator/supabase/functions/_shared/pricing/geometry.ts";
import { suggestQuantities } from "file:///C:/Users/march/AndroidProjects/FenceEstimator/supabase/functions/_shared/pricing/takeoff.ts";
const ppf = 20, enc = p => p.map(q => `${q[0]*ppf}:${q[1]*ppf}`).join(",");
const base = { syncId:"r", label:"", fenceType:"VINYL", sortOrder:0, pointsEncoded:"", gatesEncoded:"", closedLoop:false,
  isTeardown:false, colorOrFinish:"", panelWidthFt:8, panelHeightFt:6, aluminumStyle:"RACKABLE", woodStyle:"PRIVACY",
  woodRailCount:2, picketWidthIn:5.5, picketGapIn:0, fabricHeightFt:4, includeTopRail:true, includeTensionWire:false,
  includeBarbedWireArms:false, includePrivacySlats:false, splitRailCount:2, postSpacingFt:8, concreteBagsPerPost:1,
  manualLinearFeet:null, manualCornerCount:0, suppressedRoles:new Set(), startJointId:"", endJointId:"" };
const two = [{x:1000,y:1000},{x:1800,y:1000}];
console.log(analyze(two, ppf, false).totalLinearFeet, analyze(two, ppf, true).totalLinearFeet);   // 40, 80
const s = suggestQuantities({ ...base, pointsEncoded: enc([[0,0],[35,0],[35,35]]) }, ppf, 0);       // 10 posts, 9 panels
```

The joined L: build two runs with `endJointId` and `startJointId` set to one uuid, run
`adjustJoins(...)` from `joins.ts` over `{ id, geometry: resolveGeometry(run, ppf), heightFt, sortOrder,
isTeardown, startJointId, endJointId }`, and pass `adjustmentForRun(adj, run.syncId)` as the fourth argument of
`suggestQuantities`. Result: 11 posts, 10 panels.

Monte Carlo for section 4 items 3 and 4 and F8: copy `nextUp`, `nextDown`, `floatsAround` and `landSide` from
`tests/a41-footage-existing-sides.test.mjs` lines 48-67 and 112-165 into a scratch file, build each side with
`landSide(prev, [cos a, sin a], f32(feet), f32(ppf))`, and compare `analyze(pts, ppf).totalLinearFeet`
against the sum of typed feet (item 3), against the same points after 11 rescalings (item 4), or against
`Math.hypot` sums divided by `ppf` rounded with `Math.floor(x + 0.5)` (F8).

Live probes, all SELECT, His company `aba5b097-afc4-48dd-9851-b50200d5e8f4`, counts and short rows. The shapes:

```sql
-- scale and runs: counts with a canary (false filter) that must be 0
select count(*) filter (where deleted_at is null and calibration_pixels_per_foot is null) as cal_null,
       count(*) filter (where deleted_at is null and survey_storage_path is null and calibration_pixels_per_foot is not null
                        and abs(calibration_pixels_per_foot - 8000.0/grid_extent_ft) > 0.01) as grid_cal_disagrees,
       count(*) filter (where false) as canary_must_be_zero
from public.jobs where company_id = '...';
-- closed pairs: npts = commas + 1
select count(*) filter (where closed_loop and (length(points_encoded) - length(replace(points_encoded, ',', ''))) = 1)
from public.fence_runs where company_id = '...' and deleted_at is null;
-- footage as the engine reads it: unnest points, lag() for the previous point, sqrt((x-px)^2+(y-py)^2),
-- add the closing side when closed_loop (n = 2 comes back doubled), divide by coalesce(calibration, 20).
```

Results as read: 11 live jobs, 17 live runs (13 drawn, 7 with a bend, 3 closed, **1 closed with two points**,
7 with gates, 1 teardown and empty, 0 typed, 0 joined), 6 jobs signed in the app, all with `quote_approved_at`
null today, 8 re-approval rows in the database, trigger present.

# Footage drift: "Sometimes on the grid when I add a side, the footage changes"

Diagnosed 2026-10-01. **No app code was changed.** Evidence is
`tests/a41-footage-existing-sides.test.mjs` (15 checks, green) and two read-only probes of the live
database. This file says plainly which statements were RUN, which were READ from the code, and which
are a GUESS.

## Verdict

1. **The geometry does not drift. Could not reproduce a side that moves when another is added.**
   360 drawings (six grid sizes from 25 ft to 2000 ft, three kinds of stored scale, one to three runs, open
   and closed, every snap kind) were built the way the screen builds them and then had a side added the way
   the screen adds one (`snapForDraw` -> `addDrawPoint` -> encode -> decode). In every one, every side that
   was already there came back **bit-identical**: not "within a hundredth of a foot", the same Float bits,
   because the existing corners are literally the same floats. This was run on the REAL Kotlin
   (`FenceGeometry.kt`, `SideLength.kt`, `GateSpan.kt`, `DrawingScale.kt`, unedited, compiled standalone with
   kotlinc 2.0.21 and a five-field stand-in for the Room `Job`), and the JS transcription in the test was held
   to it line for line.
2. **So `DrawingScale.kt` and `FenceGeometry.kt` are left exactly as they were.** Both are correct for this
   symptom, and changing correct code to look busy is how a drift gets made.
3. **Footage CAN change when a side is added, for reasons that are not the geometry.** Ranked by how well
   they fit "sometimes" (section 3). The strongest is in the sync, was found by reading and is NOT
   reproduced. Two others are real and deterministic and are in the survey screen, which this effort was not
   allowed to edit.

## 1. The four suspects, each confirmed or ruled out

| # | Suspect | Verdict | Evidence |
|---|---|---|---|
| 1 | The scale is shared; adding a run recomputes a job-level calibration | **Ruled out for adding a side.** The scale is a stored job field and a pure function of it; nothing on the add path reads or writes it. | RUN: a refit and a re-derived scale are planted as canaries and the detector catches both (test 2b). READ: `addDrawPoint` and `writePoints` contain no `updateJob`/`calibration`/`gridExtent` (test 6b); the DRAW tap calls only `snapForDraw` and `addDrawPoint` (6c). |
| 2 | Snapping moves an EXISTING point | **Ruled out.** `snapDrawPoint` is handed read-only `List<FencePoint>`s and returns one `SnapResult`; a vertex snap copies an existing corner's position onto the NEW point and never moves the old one. The comment claiming this is true, and the test proves it rather than quoting it. | RUN: 360 drawings, nine of them vertex snaps (four onto another run's corner). A snap that drags the previous corner is planted as a canary and caught (2b). READ: 6a. |
| 3 | The grid extent grows when a side is added and lengths follow it | **Ruled out.** Nothing grows the extent. The only callers of `setGridExtent` are the grid-size chips, the zoom +/- buttons, and turning satellite on (`ensureSatelliteCalibration`). Lengths are NOT derived from the extent once a calibration is stored; the extent is only the fallback for a job with none. | READ: every writer of a job's scale in the whole app is enumerated and pinned (6d, 6f); a new one fails the test. RUN: a scale re-derived from a grown extent is a canary (2b). |
| 4 | Rounding at the boundary: a hundredth reads as a foot | **Cosmetic, and not the cause.** Adding a side moves no side at all (bit-identical), so there is nothing to round. The one path that rescales a drawing, a change of grid size, moves a side by at most **0.00033 ft** (four thousandths of an inch) over **eleven consecutive** grid-size changes, measured on the real Kotlin. A label shows whole inches. | RUN: test 4 and the Kotlin `RESCALE` lines. |

`setGridExtent` itself preserves length by multiplying every point, gate and site marker by the ratio of the
two scales, and stores the new scale last. It is not one database transaction, so a phone killed between the
runs and the job leaves a drawing and a scale out of step (this is already documented on `fitSurvey`). That is
a crash window on grid-size changes, not a thing that happens when a side is added.

## 2. What a live job looks like (read-only, counts only, positive controls fired)

Jobs not deleted: **19**. Grid jobs whose stored calibration disagrees with 8000/extent: **0**. Grid jobs with no
calibration at a non-400 ft extent: **0**. Grid jobs with no calibration at 400 ft (where the flat 20 the
billing assumes equals the grid's own 8000/400): **10**. Photo jobs: **1**. So on today's data the screen and
the billing measure every grid job at the same scale, and the class of defect behind the one job patched on 29 September (extent 25,
calibration 20) is absent. The other probe, which looks for jobs whose drawing history shows an existing corner
moving when one was added, found **one** row in the whole table and it started from an empty drawing: the live
data is too thin to confirm or refute anything about drift. Neither probe names a company, a job or a customer.

The a21 split is still real in the code: with no stored calibration the screen reads 8000/extent and the
billing reads a flat 20, and the two agree only at 400 ft (test 5b). Nothing the app does on its own was found
to create that state: reading `setGridExtent`, a change of extent writes the new calibration with it, and the one
branch that writes the extent alone runs only when the scale would not change. That is a reading, not a test.
The live table, as of today, holds no such job.

## 3. What CAN make the footage change when a side is added, ranked

**A. The sync can put the previous drawing back over the new side. READ, NOT REPRODUCED, strongest fit for
"sometimes".** `AutoSync` runs push-then-pull on every ordinary pass, 1.5 s after the last local change
(`DEBOUNCE_MS`). `EntitySync.pushFenceRuns` reads the local runs at one instant and uploads them; the server's
`fence_runs_touch_updated_at` trigger stamps the cloud row with the SERVER clock when the upload lands.
`EntitySync.pullFenceRuns` then replaces a local run whenever `row.updatedAtMillis() > existing.updatedAt`.
A corner tapped in after the push read, with a phone-clock time earlier than that stamp, makes the pull treat
the cloud copy (without that corner) as newer and write it over the new corner. The next push then declines to
send the corner (`run.updatedAt > claimed.updatedAtMillis()` is false), so it is gone from both places. The
window is one upload round trip, and a phone whose clock runs behind the server's widens it by the difference.
That someone tapping corners every second or two can land inside it is a guess about timing, not a measurement;
it is the reason "sometimes" fits, and the reason this stays unconfirmed until it is watched happening.
**How to tell:** draw the same fence in airplane mode. If the footage never changes offline, this is the cause.
The fix is in the sync (never overwrite a local run whose content differs from what this phone last pushed;
that needs a marker on the row, hence a Room migration), not in the geometry. It is out of this effort's files.

**B. A closed perimeter replaces its closing side when a corner is added. RUN, real, by construction.** With
"Closed perimeter" ticked, `addDrawPoint` appends the new corner after the last one, so the old closing side
(last corner back to the first) no longer exists: it becomes the side to the new corner, and a new closing
side runs from there to the start. Worked example, run on the real Kotlin: sides 40, 40, 56.57 (perimeter
136.57) become 40, 40, 45, 60.125 (perimeter 185.125). Sides 1 and 2 are bit-identical; **side 3 changed from
56.57 to 45 ft**, because it is now a different side. The text shown when typing a closing side's length warns
that the side before it changes; nothing warns when a corner is added. Test 3 pins it. Fits "sometimes" only
for someone who ticks the box.

**C. The headline "N ft total" is only the selected run. READ, display.** `PropertyInfoPanel` shows
`liveFeet`, the footage of the active run, labelled "ft total", and adds "| N ft job total" only when
`runs.size > 1`. Adding a run makes the new, empty run active, so the number is replaced by "Draw the fence
line -- the grid is already to scale", and the first side drawn then shows that run's footage under the word
"total". If "a side" meant a run, this is the likeliest thing he saw. The fix is a label, in `SurveyDrawScreen`
and the strings.

**D. The corner-join radius is a fixed 26 canvas units, so it is 80 times looser at one grid size than another.
RUN as arithmetic, real, moves the NEW corner only.** `snapDrawPoint`'s `vertexSnapPx` is 26 units. In feet that
is 0.08 ft on a 25 ft grid, 0.33 ft on 100 ft, 1.3 ft on the 400 ft default, 3.3 ft on 1000 ft and **6.5 ft on
2000 ft**. On an acreage grid a corner tapped within 6.5 ft of any corner of any run is pulled onto it, so the
side being added can come out several feet different from where the finger was (in the 360 drawings, vertex
snaps on the 1000 ft and 2000 ft grids pulled the new corner 2.1 ft and 2.9 ft from where it was tapped). The whole-foot snap (0.35 ft)
and the angle tolerance are scale-free; only this one is not. Whether to make it a distance in feet or on
screen is a design choice that changes how snapping feels at every grid size, so it was left alone.

**E. Typed footage outranks the drawing.** A run with a typed length bills that length whatever is drawn
(`EstimateEngine.footageOf`, `TakeoffRefresher.footageOf`), so adding a side to it changes nothing the job
prices. That is the opposite complaint, but it is why two screens can disagree about one run.

**F. One deliberate path moves every side at once.** `EstimateViewModel.recalibrateFromRun` ("make the drawing
match N ft") sets the job's scale from one run's drawn length and clears its typed length, so every run's
footage changes together. It is a button, reached from the estimate screen, and nothing calls it when a side is
added. It is the only place outside the survey screen that rescales a drawing's meaning on purpose, and it is
in the pinned list (6f).

## 4. Three questions that separate A, B and C in a minute

1. Did the number change **while drawing offline**? Yes means it is not A. No means A.
2. Is "Closed perimeter" ticked on that run? If so, B.
3. By "add a side", did he mean a corner, or the "New fence run" button? The second is C.

## 5. What was changed, and what was not

Added: `tests/a41-footage-existing-sides.test.mjs`, this file. Nothing else.

Not changed, and why:
- `DrawingScale.kt`, `FenceGeometry.kt`: correct for this symptom (section 1).
- `SurveyDrawScreen.kt` (B's add flow, C's label), `SurveyViewModel.kt`: committed an hour before this work and
  possibly reopened elsewhere; described precisely above instead.
- `EntitySync.kt` / `AutoSync.kt` (A): another wave was editing `EntitySync.kt` while this was written; the
  clock gate in `pullFenceRuns` was unchanged when last read. The fix needs a schema change.

## 6. What this does not establish

- No device, no real tap sequence, no timing was observed. A is a reading of the code.
- The test cannot run Kotlin. It holds a transcription to a frozen snapshot of the real Kotlin's output
  (recipe at the bottom of the test); a later edit to `snapDrawPoint`, `landSide` or `DrawingScale` is caught
  only by the source checks until the harness is re-run.
- "Zero drift in 360 drawings" is a statement about the add path as the screen drives it. It says nothing
  about sync, about the Estimate screen, or about a person typing a length.

---

## CORRECTION, checked 1 Oct 2026 after the gate reported

The gate's summary offered TWO deterministic explanations in the survey screen. One is real.
The other is NOT, and it should not reach the owner:

**WRONG: "the N ft total headline is only the selected run, so starting a new run swaps the
number."** It is not. `SurveyDrawScreen.kt` computes `totalFeetAllRuns` over `runs.map { ... }`
-- every run on the job -- substituting the active run's draft points for its saved ones only
so the figure moves live while a finger is down. Its own comment says so: *"Job-wide total
(every run, not just the one on screen)"*. Starting a new run therefore ADDS to the headline;
it does not swap it. Telling him otherwise would have sent him looking for a bug that is not
there, in the one number he trusts.

**RIGHT: the closed perimeter.** With "Closed perimeter" ticked the last side is DERIVED --
it is the segment from the final point back to the first, and it is not something he drew. So
dropping a new corner necessarily recomputes it, and the total changes even though he only
"added a side". `totalLinearFeetAcrossRuns` is handed `pts to r.closedLoop` for exactly this
reason. That is correct arithmetic and surprising behaviour at the same time, which is the
shape of his complaint: a number moving for a reason that is real but invisible.

**What would actually fix the symptom** -- neither is a bug fix, both are the screen telling
the truth sooner:
1. Draw the closing side differently from the sides he placed (dashed, or a different weight),
   so it reads as derived rather than drawn. Then its length changing is obviously a
   consequence of closing the loop.
2. Show the delta when the total moves, rather than only the new figure. A total that changes
   silently is indistinguishable from a total that is wrong.

**Still unproven and still the strongest remaining suspect: the sync putting an older drawing
back.** The one-minute test that settles it, and the owner can run it himself: draw the same
fence in airplane mode. If the footage never moves offline, it is the sync and not the screen.

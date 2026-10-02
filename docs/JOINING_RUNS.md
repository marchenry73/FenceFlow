# Joining runs, and the 6-to-4 transition

Written 2026-10-01 from the code and the live schema, read-only. **Nothing here is
implemented and nothing was applied.** Line numbers are as of that day; the pricing files
are being edited by other work, so function names are the stable reference.

Owner's asks this settles (`FIELD_FEEDBACK_2026-10-01.md` C2 and C6):

> "connect the sides together ... connect the whole fence together not necessarily close
> perimeter I still want that option" and "the 6ft high fence to go from 6ft to 4ft ...
> slanted diagonally to the 4 ft and then continue on."

What this track produced, and what it deliberately did not touch:

> **DECIDED 1 Oct 2026 — read section 11 first.** Storage is settled (columns, not the
> `run_joins` table), the approval hazard in 7.2 was verified live and a fix is written, and the
> drawing-version answer and the no-backfill figures are measured. Section 11 is the decision;
> sections 1.6, 6.3 and 7.2 are the working that led to it and carry corrections pointing at it.

| File | What |
|---|---|
| `docs/JOINING_RUNS.md` | this document |
| `supabase_a32_join_runs.sql` | PART 1: two additive joint columns on `fence_runs`. PART 2 (contested): the transition flag. **Unapplied.** |
| `supabase_a56_join_reapproval_fingerprint.sql` | **the 7.2 blocker, written.** PART A teaches the re-approval fingerprint the joints; PART B teaches the drawing snapshot. **Unapplied**, and PART B is reader-gated. Section 11.2 |
| `tests/a56-join-decision-fingerprint.test.mjs` | the tripwires that hold 11.1-11.4 to the files: append-only, gated, no backfill, no second home, and the PART B reader order |
| `tests/a32-join-posts.test.mjs` | the join arithmetic: 21 cases red on purpose, 8 guards, 13 baselines |
| `tests/a32-join-transition.test.mjs` | the transition item (answer C, contested): 4 cases red on purpose, 4 guards. Delete if the owner's "priced as 6 ft" decision stands |

No existing source file was changed. The drawing screen, its view model, the Kotlin engine
and `pricing/index.ts` were all held by other work, so everything that has to change in them is
described in section 7 instead.

---

## 0. The answer in one screen

1. **A join is recorded, not inferred.** Each run gets two text columns, `start_joint` and
   `end_joint` (`''` = free end). Runs whose ends carry the same id share one post. Coordinates
   only ever *propose* a join in the drawing screen; they never decide a price. (Another piece of
   work stores the same fact as rows in a new table; 1.6 compares the two and recommends columns.)
2. **A joint of `d` ends turns `d` billed end posts into one post**, so the fence has `d - 1`
   fewer posts. With the legs used throughout (30, 17, 24 ft at 6 ft spacing):

   | Case | Today | After | Roles after |
   |---|---|---|---|
   | two runs joined at one end | 10 | **9** | 7 line + 2 end |
   | three runs joined in a line | 15 | **13** | 11 line + 2 end |
   | four runs joined end to end *and* closed | 20 | **16** | 12 line + 4 corner + 0 end |
   | a T, three runs meeting at a point | 15 | **13** | 9 line + 1 corner + 3 end |

3. The shared post is a **line post** if the fence turns less than 15 degrees there (the rule the
   engine already uses for an interior vertex), otherwise a **corner post**; a T is a corner post;
   a join with no drawn angle (typed footage) is a corner post. It is billed to **one** run: the
   taller, then the lower `sort_order`.
4. Nothing else double-counts at a join. Caps and concrete follow the posts; the two minimum
   charges are per job, not per run (verified). A few things are per run and stay per run (section 3).
5. **6-to-4 is three runs joined end to end.** Height is on the run, so a fence cannot change height
   inside one. What the middle run *is* is **contested** (4.2): either one ordinary bay of the taller
   fence, which needs nothing beyond joining, or a priced transition item, which needs a run flag, a
   catalog role and a catalog row that the engine has none of today. The request I was given asked for
   the item; other work written the same day records an owner decision that it is priced as 6 ft.
   Both are specified; ask the owner (Q4).
6. **Closed loop is unchanged and stays optional.** A chain that happens to end where it started
   is *not* closed unless the owner joined it; the engine never deduces it.

Three ways this ships a wrong price **silently** if missed (section 7 has the detail):

* **The re-approval fingerprint and the drawing snapshot do not read the new columns.** Joining
  two runs on an approved quote would change its posts without withdrawing the approval. The join
  UI must not ship before the database follow-up in 7.2. **Verified live and fixed, unapplied:
  section 11.2 and `supabase_a56_join_reapproval_fingerprint.sql`.**
* **Adding the 4 ft catalog rows, on their own, underprices every 6 ft run.** Height is not a
  selection key (6.3, and `docs/PANEL_HEIGHT_BLINDNESS.md`); the ornamental catalog already does this
  today.
* **The phone re-prices per run.** The owner's shared post depends on a *neighbour's* geometry,
  so a neighbour's edit must re-price it (7.4).

---

## 1. How a run is stored, and how a join is recorded

### 1.1 What exists

| Fact | Where |
|---|---|
| A run is one polyline: `points_encoded`, text `"x:y,x:y,..."`, `Float.toString` pairs in the drawing's pixel space, shared by every run on the job. Interior vertices are the corners. | `FenceRun` (`Entities.kt` 544-640), `FenceCodec.encodePoints` (`FenceGeometry.kt` 70) |
| `closed_loop` joins the last point back to the first with an implicit closing side and removes both end posts. | `analyze` (`geometry.ts` 140-193) |
| Height is on the run: `panel_height_ft` (vinyl, aluminum, ornamental, wood), `fabric_height_ft` (chain link), none for split rail. | `RunEditScreen.kt` 346-395. The cloud and the DB call it `panel_height_ft`, not `height_ft`. |
| The row the server loads is `RUN_COLUMNS`. A column not in that list reaches the engine as `undefined`. | `price-job/index.ts` 82-87, read at 187 |
| A typed run (`manual_linear_feet > 0`) has **no coordinates**: typed footage wins outright and the engine invents `endCount` 0 or 2. | `resolveGeometry`, `takeoff.ts` 215-229 |
| On an uncalibrated photo job the loader **blanks every drawn run's points** before the engine sees them. | `neutralizeUnscaledRun`, `load.ts` 280 |
| Line items belong to a run: id is a hash of `fenceline:<run sync id>:<ROLE>`. | `line-items.ts` 25 |
| Rows sync one at a time, last-edit-wins on `updated_at`. The phone's JSON has `explicitNulls = false`, so a Kotlin `null` is **left out** of an upsert body and the column keeps its old value. | `pushFenceRuns`, `EntitySync.kt` 3216-3250; the same trap is written up on `deleted_at`, `EntitySync.kt` 295 |
| Drawing a point near another run's corner already copies that corner's exact `Float` pair (`SnapKind.VERTEX`, within 26 px), across every run on the job. | `snapDrawPoint`, `FenceGeometry.kt` 436-465; `snapTargets`, `SurveyViewModel.kt` 504 |

The last row matters most: **today two runs can already meet on one identical coordinate, and the
price ignores it.** `computePostCounts` is per run, so each run still bills its own two end posts
(test B11 prints the 10-post answer for two runs that end on the same pixel). Two comments imply
otherwise (`FenceGeometry.kt` 408 and `SurveyViewModel.kt` 500: runs that do not meet at one point
make "the takeoff count two posts where the crew will set one"). Read plainly they say that runs
which DO meet at one point are counted once. They are not. Section 9.

### 1.2 The options

| | A. infer from coordinates | B. "joined to" reference | C. ordered chain | **D. joint id per end** |
|---|---|---|---|---|
| Fits what exists | Yes: snapping already makes ends coincide | Partly | Poorly | **Yes**: sits beside `closed_loop` and `suppressed_roles` |
| Schema | none | 2 columns + a rule for who stores it | `chain_id`, `chain_position`, `chain_closed`, `reversed` | **2 text columns** |
| Typed (no-drawing) runs | **cannot** (no coordinates) | yes | yes | **yes** |
| T (3 runs at a point) | yes | awkward (who points at whom) | **no** (chains are linear) | **yes**: three ends, one id |
| Transition in the middle | n/a | rewrite two rows | renumber every later row | add one run, write two ids |
| Concurrent edit on two phones | n/a | A says "joined", B says nothing | many rows rewritten, conflicts | worst case an id is alone: reads as free end |
| Failure direction | **silent, either way** | stale reference | reorder bugs | **toward today's price** |

**Why not A, said concretely.** Dragging one point a pixel is the whole problem:

* *Exact equality.* `movePoint` (`SurveyViewModel.kt` 657) writes only the selected run, so the
  partner's identical vertex stays behind and the join silently dissolves. The next re-price bills
  one more end post. Nothing on screen changed by more than a pixel.
* *With a tolerance.* The price steps by a whole post when a drag crosses the tolerance. A price
  that jumps on continuous input is not a price you can defend to a customer.
* *The tolerance is in pixels, not feet.* 26 px is 1.3 ft on the grid (20 px/ft) and 6.5 ft on a
  4 px/ft satellite photo. Two posts 6 ft apart would merge.
* *A typed length edit moves the far end.* `setSideLength` slides every later vertex with the
  edited side, so correcting an early leg walks a run's last point off its neighbour.
* *Typed runs and photo jobs have no coordinates at all* (table above).
* *Closing must stay a choice.* Inference makes "ends happen to meet" mean "closed", which is
  exactly what the owner said he does not want (section 5).

The live data (13 drawn runs in 9 jobs, read 2026-10-01, positive-controlled) has no two runs
meeting at all, exactly or within 60 px, so there is no legacy join to preserve and nothing to
backfill. It says nothing about what people will do once the tool exists.

**Why D over B.** A joint is not a relation between two rows, it is a place a post stands. Giving
the place an identity makes a T three members of one thing instead of three pairwise links, makes
"join C to the existing corner" one write instead of three, and means no row has to agree with
another to be understood. It also needs no table: a joint has no attributes, only members.

### 1.3 The model

```
fence_runs.start_joint    text    not null default ''    joint at this run's FIRST point
fence_runs.end_joint      text    not null default ''    joint at this run's LAST point
fence_runs.is_transition  boolean not null default false  PART 2, contested: section 4, 6
```

* A joint is a uuid the phone generates. Ends with the same id are one post.
* **Text, not a nullable uuid**, because of `explicitNulls = false`: an un-join sends a null,
  the body leaves it out, and the office keeps pricing the runs as joined. `''` travels.
* **No CHECK constraint.** Upserts are batched; one refused row fails the whole batch and no run
  syncs. The database accepts any text and the **readers validate** (1.4).
* The index is the end, not a vertex number: `start_joint` is the first point, `end_joint` the
  last. Inserting or deleting vertices in the middle cannot move a joint, and Undo needs no
  renumbering. (A T onto the *middle* of a straight run is made by splitting that run in two at the
  point; the three ends then meet. v1 does not join onto a mid-span vertex.)
* The schema, with its proof rows, is `supabase_a32_join_runs.sql`.

### 1.4 What a reader must do (both engines)

A joint takes effect only if **all** of these hold; otherwise the end is a plain free end, which
is today's price:

| Condition | Test |
|---|---|
| the id is non-empty | every baseline: no id, no join |
| it is carried by ends of at least **two different runs** | G2, G3 |
| a run carrying it at **both** ends is dropped from it | G3 |
| each member run is **open** (`closed_loop` false) | G6 |
| each member run is **not a teardown run** | G4 |
| each member run **prices some footage** (typed, or drawn and not blanked) | G5 |

The last three are not arbitrary. A teardown run bills no materials, an empty or photo-blanked run
has no posts, and a closed run has no ends. A post handed to any of them is a post nobody pays for.
Test G4 sets the teardown run's `sort_order` *lower* on purpose, so a naive "lowest sort order owns
it" picks it.

### 1.5 What is not stored

The joint's **position, kind (line / corner / tee) and owner are derived** on every price from the
runs themselves, never stored. There is no stale copy to disagree with the drawing.

### 1.6 A second design appeared while this was written: rows, not columns

`app/src/main/java/com/fenceestimator/app/data/RunJoin.kt` (another piece of work: Room schema 48,
not synced, called by no screen and no engine) records the same fact as a Room **table**,
`run_joins`: one row per run end, a shared random `jointId`, three unique indexes, a cascade on the
run, and `planJoin` as the write-time rules. Its header says plainly that the two designs cannot both
be the home of a join and that the loser should be removed while that is still free, which is before
any build at schema 48 exists. The arithmetic written alongside it (`RunJoinArithmetic`,
`FenceGeometry.kt`) already follows this document's rules and mirrors the two column names, so it
works with either home. Only the storage is open.

| | Columns on `fence_runs` (this document, the `.sql`) | Table `run_joins` (`RunJoin.kt`) |
|---|---|---|
| The model | joint id per end, two ends minimum, random ids, no vertex index | **the same** |
| New cloud table, RLS, crew scope, suspension | **none**: rides `fence_runs`, whose grants are table-level and whose policies name no column (7.2) | all of them, and every list that names tables must gain it or the table is silently unprotected: `supabase_sweep_hardening_patch.sql` 40, `supabase_crew_job_scope.sql` 288 and 1049, the realtime publication, the tenant-isolation tests. Per its own header it is also not in `SyncTables.ALL` (the reaper's list) and not in the unsynced-work warning |
| What `price-job` reads | one more name in `RUN_COLUMNS` | a new query and a new array in `PricingInput`, paged (the 1000-row cap) |
| Re-approval on an approved quote | the run row's existing trigger fires; the fingerprint change is about a dozen lines (7.2) | its own header: "nothing at all fires on a join here". Needs a new security-definer trigger on the new table and a whole-job fingerprint that reads across two tables |
| Two phones, one run | row-level last-edit-wins: a stale copy of a run pushed after someone joined it can drop the join. It fails toward today's higher bill, and visibly | per-end rows: a join survives an edit to the run |
| Nonsense (same end twice, a run joined to itself) | the readers refuse it (G2, G3, G6), as they must anyway | the schema refuses it; pricing still has to re-check closed, typed and teardown, as its header says |

**Recommendation: columns.** *(Now the decision — see 11.1, which weighs this again from the
code rather than accepting it, and adds the two arguments this table missed: the batched-upsert
failure mode cuts the other way from how it reads here, and a T is the case where the table's
schema buys the least.)* The deciding facts are the first two data rows and the re-approval row:
this repository's history is a series of places where a new table was left off a list (backups,
tenant isolation, the reaper), and the owner's re-approval rule is the one that must not be walked past.
The one thing the table does better, surviving a concurrent edit of the same run, is a failure mode
the run row already has for every other field, in the safe direction.

If columns are chosen, keep from `RunJoin.kt`: `planJoin`'s refusals as the phone's *write-time*
checks (same job, not a closed loop, not a teardown run joined to a new one, never silently merging
two points), the random labels, and its analysis of what two phones can do to each other. Delete the
table, its DAO, `SchemaV48` and `syncIdFor`. If the table is chosen instead, do **not** apply
`supabase_a32_join_runs.sql`, and 7.1-7.3 change: a table, policies, sync, a trigger and the extra
read are each new work.

**One real difference to settle either way: typed footage.** `RunJoin.kt` refuses to *create* a join
on a typed run (it has no drawn line). This document's reader honours an existing join on a typed run
as a corner post (2.4, test D3), so that a run joined and later typed is not silently un-joined. Both
can hold together (refuse on write, honour on read). The alternative is to ignore a join to geometry
that no longer applies. This document picks the first: the owner's decision stands until he changes it.

---

## 2. The shared post

### 2.1 Today

`computePostCounts` (`takeoff.ts` 263-311, Kotlin `EstimateEngine.kt` 444-496):

```
gatePosts = 2 per gate (3 for LINE_TO_WALL)
bays      = ceil(netFt / postSpacingFt)               netFt = footage minus gate openings
estimate  = bays + 1 - gateCount   (open: endCount 2)   |   bays - gateCount   (closed: endCount 0)
line      = max(estimate - corners - ends, 0)
total     = line + corners + ends + gatePosts
```

So an open run always bills **two end posts**. Join two runs and, naively, the customer is charged
for a post that does not exist. Verified against the engine: legs of 30, 17 and 24 ft bill 6, 4
and 5 posts alone (B6).

### 2.2 The rule

For every joint of `d` ends: the `d` end posts those ends were billed disappear, and **one** post
stands in their place. Everything strictly inside a run (its line posts, its interior corners, its
gate posts) is untouched.

```
total  = sum(total)  - sum over joints of (d - 1)
end    = sum(end)    - sum over joints of d
corner = sum(corner) + number of CORNER joints
line   = sum(line)   + number of LINE joints
```

### 2.3 The arithmetic, case by case

Legs: **A** 30 ft (5 bays), **B** 17 ft (3 bays), **C** 24 ft (4 bays); spacing 6 ft; no gates.
Alone they bill A 6 = 4 line + 2 end; B 4 = 2 line + 2 end; C 5 = 3 line + 2 end.

| Case | Joints | Posts | Working | Roles |
|---|---|---|---|---|
| A and B straight, joined at one end | 1 x d=2, LINE | **9** | 6 + 4 - 1 | line 4+2+**1** = 7, end 4-2 = 2 |
| A, B, C straight in a line | 2 x d=2, LINE | **13** | 6 + 4 + 5 - 2 | line 4+2+3+**2** = 11, end 6-4 = 2 |
| A, B, C, D (30, 17, 30, 17) joined end to end and D back to A | 4 x d=2, CORNER | **16** | 6+4+6+4 - 4 | line 12, corner **4**, end 8-8 = **0** |
| T: A.end, B.start, C.start at one point | 1 x d=3, CORNER | **13** | 6 + 4 + 5 - **2** | line 9, corner **1**, end 6-3 = 3 |

Each of the first three equals what the engine already prints for **one run drawn through the same
points** (47 ft open = 9, 71 ft open = 13, the 30 x 17 loop closed = 16; tests B1-B3, B7-B9), which
is the check that the rule is right and not merely self-consistent. An L of two runs meeting at 90
degrees equals one L polyline (B4, B10), and the joint is a corner post.

**Why legs of 30 / 17 / 24.** Per-leg bay counts (5 + 3 + 4 = 12) must add up to the whole-polyline
count (ceil(71 / 6) = 12) for the comparison to hold; 17 ft rather than 18 also keeps an angled leg
off an exact bay boundary, where float noise would add a bay. See 3 for what happens when they do
not add up.

### 2.4 What kind of post, and who is billed

**Kind** (a joint of `d` members):

| `d` | Kind |
|---|---|
| 2, both runs drawn | the fence turns where it arrives along one run and leaves along the other. **Corner if the turn is >= 15 degrees, else line.** Computed with exactly the arithmetic `analyze` uses for an interior vertex, so a joint classifies the same as the same two legs drawn as one polyline (P5a-P5e, including 14.5 and 15.5 degrees; exactly 15.000 is, as in the pricing contract, not asserted) |
| 2, either run typed or with no heading | **corner** (D3). No angle exists; a deliberate join of typed runs usually means a change of direction or spec, and a corner post is the stronger of the two |
| 3 or more | **corner**. The catalog has no tee-post role; adding one is a catalog decision |

Orientation must not matter. `START`-`START`, `END`-`END` and `END`-`START` joins of the same two
legs price identically (P6a-P6d), and a run drawn *toward* the joint that carries on straight is a
line post, not a U-turn (P6e). The arithmetic: the incoming heading is the direction of travel into
the joint along the first run (last segment for an `END`, first segment reversed for a `START`); the
outgoing heading is the direction of travel away from it along the second.

**Who is billed.** Each run has its own line items, so the shared post must be billed to exactly
one run. Among the members (after 1.4): **the tallest run, then the lowest `sort_order`, then the
lowest `sync_id`.** Height is `fabric_height_ft` for chain link, `panel_height_ft` otherwise, 0 for
split rail. The owner's end bills a `LINE_POST` or `CORNER_POST`; every other member's end bills
nothing. Surfaced as the owner's "Line posts" / "Corner posts" takeoff lines and entries, so caps,
concrete and the post readout need no new path. Per-run results are in D1, D2.

Why the tallest: a taller post can carry a shorter panel, not the reverse. It changes nothing while
the catalog ignores height (6.3), and starts mattering the day the 4 ft rows land. Why billed to a
run at all and not to a job-level line: the whole line-item machinery (edited-line merge, per-run
sync ids, suppression, teardown) is per run, and a "shared posts" line would need a second
regenerate path and an answer to "which colour". The price of this choice is the cross-run
dependency in 7.4.

### 2.5 Edges

* **Gates** sit inside one run and are unaffected: a gated run's 7 posts plus a 4-post neighbour is
  11 unjoined and 10 joined (P7), with the gate's two posts untouched.
* **The clamp.** `line = max(estimate - corners - ends, 0)` keeps `ends` at 2 for an open run even
  when ends are shared, so no join can drive a run's line posts negative, and a run with no
  joints computes exactly as before. A one-bay run with both ends shared and neither owned bills 0.
* **A joint that is open** by a few feet because a point was dragged is still honoured: the price
  follows the owner's decision, not the pixels. The drawing screen warns (7.4).
* **Chain-link terminals.** Bands, brace bands, rail ends and wire arms follow `terminalPosts`
  (corner + end + gate). A corner joint is one terminal where two end posts were two; a straight
  (line) joint is none. This matches how an interior vertex of one polyline is already counted.

### 2.6 Reference algorithm

Appendix A is the pure function (about 90 lines) that implements 1.4, 2.3 and 2.4. It was run, as a
patch to a scratch copy of the engine, against all of the tests below. It is a **prototype of the
spec**, not code to paste: the Kotlin side needs its own port with the same arithmetic, and parity
fixtures from the Kotlin writer (never regenerated from TypeScript).

---

## 3. What else is per run, and what a join does to it

| Thing | Where | Scope | At a join |
|---|---|---|---|
| End posts | `takeoff.ts` 277-295 | per run | **the double count; removed by 2** |
| Post caps | `takeoff.ts` 321 (`POST_CAP` = total posts) | follow posts | follow (P8) |
| Concrete | `takeoff.ts` 149-150, then `wholeBags` 243-247 | follows posts; **rounded up per run** | the shared post's bag is billed once, to the owner (P9). Per-run rounding is unchanged: 24 + 12 ft unjoined = 8 + 5 = 13 bags, one 36 ft run = 11 (B12) |
| Panels, rails, pickets | `takeoff.ts` 315, 327-330 | `ceil` **per run** | per-leg `ceil`, which is the physically right count at a post. Not a defect; see below |
| Chain-link bands, rail ends, arms | `takeoff.ts` 361-369 | follow terminal posts | one terminal per corner joint (2.5) |
| Minimum labour charge | `totals.ts` 196-197 | **per job** | none. Three joined runs bill the floor once (G8) |
| Minimum job charge | `totals.ts` 238 | per job | none |
| Gate charge, flat fee, trash haul, teardown | `totals.ts` | per job | none |
| Footage and labour | `totals.ts` 71 | sum of runs | none: a post has no length (G7) |
| Tax, markup, discount | `totals.ts` | per job | none |
| Line item identity | `line-items.ts` 25 | per run | none |
| Job duration estimate | `DurationEstimator.kt` 115-122 | counts each run's *interior* corners | **misses joint corners.** It already misses them today where two runs meet. Add the corner joints |
| "Why N posts?" readout | `PostWorkings`, `EstimateEngine.kt` 52 | explains one run | must show "shared with X", or the explanation disagrees with the number (its own test says an explanation must never do that) |
| Re-approval fingerprint, drawing snapshot | `supabase_reapproval_on_drawing_change.sql`, `supabase_r8_drawing_versions_full_snapshot.sql` | per run | **blind to joints** (7.2) |

**A consequence worth knowing, not a join bug.** One polyline takes its bay count from its *total*
length; joined runs take it per leg. A 7 ft + 7 ft L drawn as one run prices 4 posts (3 bays); drawn
as two joined runs it prices 5 (2 + 2 bays, one shared post). Five is right: each 7 ft leg needs a
post at its far end. So redrawing a polyline as joined runs can raise the count by up to one bay
per corner. Do **not** change the polyline rule as part of this: it would move every quote already
sent. The owner should be told.

---

## 4. The height transition

### 4.1 What the code says

* Height lives on the run (1.1). `takeoff.ts` **never reads `panel_height_ft`**; the only height the
  engine reads there is `fabric_height_ft`, for chain link. So a run cannot change height along its
  length.
* ~~and nothing about a run's height changes its price today~~ **— no longer true, corrected
  1 Oct 2026.** `line-items.ts` now narrows candidates by height for `PANEL`, `GATE_PANEL` and
  every post role (`LINE_POST`, `END_POST`, `CORNER_POST`, `GATE_POST`, `BLANK_POST`), against
  `MaterialItem.heightFt` (`supabase_a40_material_height.sql`, `supabase_a50_post_heights.sql`,
  Room schema 49, `PRICING_ENGINE_VERSION` 2026.10.2, `tests/a51-post-height-choice.test.mjs`).
  A run's `panel_height_ft` therefore **does** change its price today. That lands on this track in
  two places, both in 11.2: it is why the join fingerprint has to carry the heights, and it is a
  hole in the re-approval fingerprint that exists **with or without joins** and is not this
  track's to close.
* There is no transition, rake or step item in the 92-row starting catalog at any height, and no
  `MaterialRole` for one (`Entities.kt` 30-41, `types.ts` 27-38).

### 4.2 What the middle run is

Three answers are possible. Which the engine can express today is the last column.

| | The middle run is | Engine today | Needs |
|---|---|---|---|
| **A** | **one ordinary bay of the taller fence**: a standard 6 ft panel, cut on site to rake. Priced as 6 ft | **Yes, the day joining lands** (P10: 11 posts, 10 ordinary panels) | joining and nothing else |
| B | a one-bay run at an in-between height (a "5 ft" bay) | It parses, and **changes no price**: panel height is never read | nothing useful. Rejected, below |
| C | a one-bay run **carrying a transition item**: a priced rake or step product | **No.** No column, no role, no catalog row | `is_transition`, `TRANSITION_PANEL`, a catalog row and an engine rule (section 6) |

**Which is wanted is contested, and this document cannot settle it.** The request this track was
given said to add a transition item, which is C. Two other pieces of work written the same day record
that the owner decided the opposite: a 6 ft fence that steps down to 4 ft is priced as 6 ft, the raked
bay being a standard 6 ft panel cut on site, with no item, no role and no engine rule, which is A (the
header of `tests/a32-panel-choice-ignores-height.test.mjs` and `docs/PANEL_HEIGHT_BLINDNESS.md`). I
cannot tell from the code which is current, so section 6 specifies C completely and **removably**, and
A needs nothing from it. Question Q4 in section 8 is the one to ask.

**B is never the answer.** An in-between height is not a product, because nobody sells a 5 ft panel to
join a 6 ft fence to a 4 ft one. And the engine ignores panel height, so a "5 ft" run would price as an
ordinary panel with a different number in a box that changes nothing.

Under either A or C the bay has length and labour is charged by the foot, so the middle bay is a
**run** with length, billed fence footage like any bay (T1d). So 6-to-4 is **three runs joined end to
end**: the 6 ft run, the middle bay, the 4 ft run. 30 + 6 + 24 ft is 10 bays and **11** posts, not 13
(P10, T1c). That part, which is the joining, is needed in every case.

### 4.3 What the engine can express today

| | Today |
|---|---|
| Three runs end to end, geometry | Yes, but priced as three runs with three sets of end posts (13, not 11) until joining lands |
| A, the middle bay priced as an ordinary 6 ft bay | Yes, once joined. Nothing else to build |
| C, a run flagged as a transition, priced from a catalog item | **No.** No column, no role, nothing to match. Until built, the middle run prices as an ordinary panel (T1a prints this) |
| C by hand | Only as a typed extra (role `NONE`, survives a regenerate) |

---

## 5. Closing stays optional

* `closed_loop` is unchanged: the one way to close **one run** on itself (analyze closes the last
  point to the first; no end posts).
* A **chain** of runs is closed only by an explicit joint on its last end: the owner pressed Join.
  Same count either way when the legs line up (B9, P3: four joined runs = one closed loop, 16
  posts, no end posts) because **a closed loop is the case where no end is free**: every end has a
  partner.
* A chain that merely ends where it started, with no joint recorded, is **not closed**: both ends
  still bill an end post at that one spot (G1). That is the sentence the owner asked for ("not
  necessarily close perimeter"). The engine never deduces closure; the drawing screen may *offer*
  it ("These ends meet. Join them?") and the owner decides.
* There is no second way to say closed. A run carrying the same joint at both ends is dropped from
  that joint and stays open (G3); joint ids on a `closed_loop` run are ignored (G6). The drawing
  screen clears both when a loop is closed so a stale id cannot come back when it is reopened.

---

## 6. The transition item (answer C in 4.2)

> **CONTESTED. Do not build this until the owner has been asked.** The request this track was given
> said to add a transition item. `tests/a32-panel-choice-ignores-height.test.mjs` and
> `docs/PANEL_HEIGHT_BLINDNESS.md`, written the same day, record an owner decision that no item is
> needed (answer A in 4.2: priced as 6 ft). If that stands, **delete this section**, PART 2 of
> `supabase_a32_join_runs.sql`, `tests/a32-join-transition.test.mjs`, and the "(C only)" rows of 7.1.
> Joining does not depend on any of it.

### 6.1 Role and flag

* New `MaterialRole.TRANSITION_PANEL`. Places that list roles: `Entities.kt` 30-41 (enum),
  `types.ts` 27-38, `EnumLabels.kt`, the role lists in `website/dashboard.html`,
  `supabase_r20_seed_new_company_catalog.sql`. A role the phone does not know falls back to `NONE`
  on pull, so shipping the catalog row ahead of the phone is harmless.
* New run flag `is_transition` (1.3, PART 2 of the `.sql`).
* **Rule.** For `VINYL`, `ALUMINUM` and `ORNAMENTAL_IRON` runs with `is_transition`, the `PANEL`
  entry's role becomes `TRANSITION_PANEL` (same quantity = bays, same preferred width, same
  quantity reconciliation against the chosen item). Posts, concrete, caps and labour are exactly
  the run's own. Other fence types **ignore** the flag (T4): wood, composite and split rail are
  pickets and rails cut to follow a slope, and chain link is fabric. They have no transition panel
  to sell. A run is not limited to one bay by the engine; the drawing screen should warn when a
  transition run is longer than one panel width.
* **No silent substitute.** With no `TRANSITION_PANEL` row in the catalog the run reports it in
  `unmatched_roles` and carries **no** `PANEL` line (T3). Pricing a rake as a flat panel
  undercharges and says nothing, which is the failure this repo keeps finding.

### 6.2 Catalog rows

One per fence type and colour already in the starting list, for the three panel types: for
example "Transition panel 6'H to 4'H x 6'W - White", `role TRANSITION_PANEL`, `covers_ft` 6.
**Ship the price as 0.00, flagged**, until a supplier says what they stock (rake, step, or a
cut-down panel; `FIELD_FEEDBACK_2026-10-01.md` C6 already says to ask on the call about the 4 ft
prices). A matched item at 0.00 is reported in `zero_priced_names` and the estimate shows it needs a
price; an invented number would be a fake feature. Whether the starting rows belong in `SeedData.kt`,
`supabase_r20_seed_new_company_catalog.sql` or both is the catalog work's call
(`FIELD_FEEDBACK_2026-10-01.md` B2), and must be the same rows.

### 6.3 Height is not a selection key (owned elsewhere; why it matters here)

This defect is measured, with a reference fix and its cost, by **`docs/PANEL_HEIGHT_BLINDNESS.md`**
and `tests/a34-height-blindness.test.mjs`, and tripwired by
`tests/a32-panel-choice-ignores-height.test.mjs`. I found it independently while reading
`buildLineItems` (`line-items.ts` 136-156), and those documents are the fuller account. In short: a
panel was chosen by nearest width, then cheapest, then sync id, and `panel_height_ft` was read by no
pricing code, so a 6 ft ornamental iron run was priced with the cheaper 4'H panel (the shipped
`template-08-ornamental-iron-6ft.json` fixture expected it).

> **FIXED, and the fix changes this section. Corrected 1 Oct 2026.** Height is now a selection key
> for the two panel roles **and for every post role**, narrowing within a width (`line-items.ts`,
> the `entry.role === "PANEL" || ... || "BLANK_POST"` block; `MaterialItem.heightFt`;
> `supabase_a40_material_height.sql`, `supabase_a50_post_heights.sql`, Room schema 49,
> `tests/a51-post-height-choice.test.mjs`). So the bullets below that say height cannot be
> selected on, or that the 4 ft rows are blocked, are **stale**: they are kept because they are
> what the reasoning rested on, not because they are still the state. The live consequence for
> this track is in 11.2.

What it meant for this track:

* **Answer C could not select a transition by height.** A second height pair (8 to 6, 6 to 3) is
  indistinguishable from the first, so version 1 of C supports **one transition per fence type and
  colour**, and says so.
* **The 4 ft rows are blocked on it** (their analysis, and mine): the day a 4'H x 6'W white vinyl
  panel exists, every 6 ft white vinyl run is priced with it.
* **Answer A is unaffected.** It adds no catalog row.
* Read live and aggregate: no ornamental run exists in the live data (17 live runs), so nothing real
  has been mispriced yet. One company's catalog already holds the pair.

---

## 7. What the implementation has to touch

### 7.1 Engine, contract, parity

| File | Change |
|---|---|
| `_shared/pricing/types.ts` | `FenceRun` gains `startJoint`, `endJoint`; **(C only)** `isTransition`, and `MATERIAL_ROLES` gains `TRANSITION_PANEL` |
| `_shared/pricing/joins.ts` (new) | Appendix A: `planJoins(runs, pixelsPerFoot)` -> per run `{ start, end }` in `FREE / OWNS_LINE / OWNS_CORNER / SHARED` |
| `_shared/pricing/takeoff.ts` | `suggestQuantities` and `computePostCounts` take an optional joined-ends argument (default: all free, so every existing call is unchanged); **(C only)** `panelBasedEntries` emits `TRANSITION_PANEL` when flagged |
| `_shared/pricing/line-items.ts` | **(C only)** the PANEL quantity reconciliation (188-197) also applies to `TRANSITION_PANEL` |
| `_shared/pricing/index.ts` | `FenceRunRow` gains the fields (all tolerant: absent = `""` / `false`); `runFromRow` maps them; `priceJob` computes the plan once before its loop |
| `_shared/pricing/load.ts` | `DbFenceRunRow` and `fenceRunRowToInput`. `neutralizeUnscaledRun` needs no change: a blanked run prices no footage, so G5 already drops it from any joint |
| **`price-job/index.ts`** | **add the new columns to `RUN_COLUMNS` (82-87).** Left out, every row arrives without them, joins are silently ignored on the server, and the phone and the office price one job two ways. `check-parity.mjs` cannot see this: it never exercises that select. The same trap is written up at the top of that file for `minimum_labor_charge` |
| Kotlin | `FenceRun`, `EstimateEngine.kt` (same rule, same arithmetic as `analyze` for the angle), a pure `FenceJoins.kt`, `PricingContract.kt`, `PricingAdapters.kt`, `ParityCases.kt` |
| `docs/PRICING_CONTRACT.md` | the run fields; `posts` semantics (an owner's `line` / `corner` include its joint posts; `end` counts free ends only; `geometry.end_count` stays the geometric 2) |
| engine version | bump (`PRICING_ENGINE_VERSION`, now `2026.10.1`) on **both** engines. Signed prices do not move: `JobMoney.anchoredTotal` is checked before any recompute |
| fixtures | the contract says nulls are written, never omitted, so every run in every fixture gains the keys: regenerate **all** with the Kotlin writer, in the same commit. Add join cases from the scenarios in the tests, and the four disqualified-member guards |

### 7.2 Database follow-up. This is a blocker for the join UI.

`supabase_a32_join_runs.sql` adds the columns and changes nothing else. Two more things need the
columns and must land before anyone can join runs on a job that may be approved:

**1. The re-approval fingerprint.** `reapp_row_takeoff` feeds both the per-run trigger and the
whole-job proof (`reapp_job_takeoff`). Neither reads a joint, so joining or un-joining runs on an
approved quote changes its posts and **does not withdraw the approval**: the owner's rule ("must not
quietly enlarge an approved job") is walked straight past. Proposed, untested, to be proved on the
dev project with a planted row (`jsonb_populate_record`) before anything else:

```sql
create or replace function public.reapp_row_takeoff(r public.fence_runs, ppf double precision)
returns text language sql immutable set search_path to 'public' as $fn$
    select public.reapp_run_takeoff(
               r.points_encoded, r.gates_encoded, r.closed_loop,
               r.manual_linear_feet, r.manual_corner_count, r.is_teardown, ppf)
        -- Appended ONLY when this run carries a join or is a transition, so every fingerprint
        -- that exists today stays byte-identical and no stored before/after changes meaning.
        || case when r.start_joint <> '' or r.end_joint <> '' or r.is_transition
                then '|j=' || left(md5(r.start_joint || '/' || r.end_joint), 8)
                     || case when r.is_transition then '|x=1' else '' end
                else '' end;
$fn$;
```

Row-level, so a re-pointed or removed join counts as a change (conservative: it withdraws more
often than strictly needed, never less). The signature and the seven-argument
`reapp_run_takeoff` are unchanged (read live 2026-10-01).

**2. The drawing snapshot.** `reapp_run_snapshot` writes six parts today. A restore puts the
drawing back and then proves the fingerprint matches. Without the joint columns a restore leaves
the *current* joints beside the *restored* points, and the proof reports "the price must have
moved", naming the wrong cause (the failure that file's header describes for typed footage).

Extend it, but **append only when the run has a joint or is a transition**: nine parts then
(`start_joint`, `end_joint`, `is_transition`), six otherwise, exactly as for the fingerprint, so
every snapshot that exists today and every un-joined run stays byte-identical.

The readers are on the clients, **not** in SQL, and both are strict about length:
`parseRunSnapshot` (`JobDetailViewModel.kt` 1118) returns null unless there are exactly 3 or 6 parts,
and `reapprovalRestoreState` (`website/dashboard.html` ~19387) answers `unreadable` unless 3 or 6.
So the order is: ship readers that accept 3, 6 **and** 9 first, then the writer. An old phone that
meets a 9-part snapshot refuses it as unreadable, which fails safe (that row cannot be restored
from that phone), and a writer that emitted nine parts for every run before the readers changed
would make **every** restore unreadable on every phone not yet updated.

Triggers on `fence_runs` that a join write passes through (read live): `touch_updated_at` (a join
is a user edit, so bumping the clock is right), `enforce_delete_permission` (a join is not a
delete), `reapproval_on_drawing_change`. Read live: every grant on `fence_runs` covers all of its
34 columns (nothing is column-specific), and its policies mention only `company_id` and the
suspension check. So RLS, crew scope and the plan gates are untouched by new columns; joint ids
are not money.

### 7.3 Phone sync

The new fields must go through **every** place `suppressedRolesCsv` already goes (the closest
sibling: a per-run text field). Missing one is silent:

* `FenceRun` (`Entities.kt`) and a Room migration (`AppDatabase.kt`)
* `CloudFenceRun` (`EntitySync.kt` 148-190) with defaults `""` / `false`
* **both** pull sites in `pullFenceRuns`: the create (about 3095) and the merge `copy()` (about
  3150). A field in one and not the other arrives on a new phone and never updates, or the reverse.
  The comment at the second site records exactly this having happened once to the run spec
* `FenceRun.toCloud` (3690)
* `TakeoffRefresher.pricingSignature` is `run.copy(...).toString()`, so new fields join the
  signature automatically. Check it still does after the change

### 7.4 The drawing screen and view model

All of these are in files held by other work; they are the requirements, not a patch.

1. **Offer, do not decide.** When a placed or dragged point snaps (`SnapKind.VERTEX`) onto the first
   or last point of another open, non-teardown run, offer "Join". A one-tap action in the run menu
   covers ends that already coincide. Writing a join sets one id on both ends, or adopts the id the
   target end already has, in **one** Room transaction that bumps both rows' `updatedAt`.
2. **A joined end moves with its joint.** `movePoint` (657) writes one run; for an end carrying a
   joint it must write the same point to every other member in the **same Undo step**. Undo today
   is per run (`DrawingSnapshot`, `DrawHistory.kt` 14; recorded in `SurveyViewModel.kt` 296), so a
   multi-run edit needs a compound entry.
3. **The snapshot carries the joints.** `DrawingSnapshot(points, gates, closedLoop)` gains the three
   fields; otherwise Undo of a join, or Redo across one, leaves joints pointing at the wrong end.
4. **Typed length edits.** `setSegmentLengthFeet` -> `setSideLength` slides every later vertex. If
   that moves a joined end, its partners must follow, or the screen must ask first. Otherwise the
   join is silently held open by the edit.
5. **`clearPoints` and `toggleClosedLoop(true)` clear that run's joint ids.**
6. **Open-join warning.** A joint whose members are more than half a foot apart (measured in feet at
   the drawing's scale, never pixels) shows "This join is open by N ft", with Snap and Unjoin. The
   engine honours the join regardless (2.5).
7. **Re-price the neighbours.** The watcher (`watchDrawingForRepricing`, `SurveyViewModel.kt` 113)
   re-prices only runs whose own signature changed. With a shared post, run A's takeoff depends on
   B's geometry (joint kind), height and sort order (who owns it). A change to B must re-price A.
   Compare a *group* signature: the run's own plus every run it shares a joint with. The same goes
   for `TakeoffRefresher.refreshRun`, which takes one run: it must be given the job's runs to resolve
   the joint plan. (The server needs nothing: `priceJob` re-prices every run each time.)
8. **A join edit changes two runs' lines.** Refresh both. An owner's line the owner has hand-edited
   (`auto_generated = false`) is kept as typed, as everywhere else in this engine; the screen should
   say the join saved a post the hand-edited line still includes.
9. **(C only) Transition run:** a toggle on panel-based types only; a warning past one panel width.

### 7.5 Other consumers

* `DurationEstimator` (3): add the joint corners.
* `PostWorkings` (3): the "why N posts" line must show the shared post.
* `PdfExporter`, `CrewFencePlanScreen`, `quote-view`: no price effect. The customer's 3D scene draws
  runs at their own `heightFt` (`quote-view/index.ts` 710), so a 6-to-4 draws as a step, not a rake.
  Cosmetic, and only that.
* Office (`dashboard.html`): no drawing tool, so joins are read-only there and `price-job` already
  prices them once `RUN_COLUMNS` carries the columns.
* Crew: no new permission. A join is a drawing edit like moving a point, goes through
  `field_changes` and re-approval like one, and carries no money. Crew cannot delete a run, and
  nothing here deletes one.

### 7.6 Order

1. Engine + contract + `RUN_COLUMNS` + Kotlin port + fixtures (gate: `a32-join-posts`,
   `a32-join-transition`, `check-parity`).
2. Database: `supabase_a32_join_runs.sql`, then the fingerprint and snapshot file (7.2), dev first.
3. Phone sync and Room migration.
4. Drawing screen (7.4) and its strings. **Not before step 2.**
5. Only if answer C is confirmed: the transition flag, role and catalog rows (6), **with** height-aware
   selection (6.3). The 4 ft rows need height-aware selection regardless.

---

## 8. Decisions only the owner can make

| # | Question | Proposed |
|---|---|---|
| Q1 | Where two joined fences differ in height, whose post is it? | The taller one |
| Q2 | A T-junction post | A corner post (no tee item exists) |
| Q3 | A join between two typed-footage runs, where there is no angle | A corner post |
| **Q4** | **Is there a transition product, or is the 6-to-4 bay priced as an ordinary 6 ft bay?** Contested (4.2) | If he cuts a standard 6 ft panel on site: **A**, nothing to build beyond joining. If suppliers sell a rake or step panel: **C** (section 6), one bay of it in place of one bay of ordinary panel, labour as ordinary footage |
| Q5 | (Only if C) What do suppliers stock for 6-to-4: a rake, a step, a cut-down panel? | Unknown. The starting row ships at $0.00 and flagged until answered |
| Q6 | Should snapping one end onto another offer the join or make it? | Offer. A join removes a post from a price |
| Q7 | Redrawing a polyline as joined runs can raise the post count by up to one bay per corner (3) | Accept; it is the more accurate count |

Q1-Q3 are encoded as the tests labelled POLICY (D1: equal heights go to the lower sort order, D2: the
taller run owns it, D3: typed runs are a corner), so they change in one place if he decides otherwise.

---

## 9. Found on the way (outside this track)

* **Two comments imply the takeoff counts a snapped corner once, and it does not.**
  `FenceGeometry.kt` 408 and `SurveyViewModel.kt` 500. Snapping makes the coordinates identical;
  nothing downstream collapses the posts (B11). Reword them when joining lands, or now: a comment
  that describes a benefit the code does not deliver is what the owner's rules forbid.
* **Height is not a selection key**, and ornamental iron is already priced from the cheaper 4'H
  panel on 6 ft runs (6.3, and `docs/PANEL_HEIGHT_BLINDNESS.md`, which owns it). Read live, aggregates
  only: 17 live runs, **none ornamental**, so no real job has been mispriced by it yet; one company's
  catalog already holds two prices at one panel width. Every new ornamental 6 ft job will be, until
  height is a key.
* **Concrete is rounded up per run** (B12). Documented, unchanged.
* **The whole-polyline bay rule undercounts at corners** when legs are not multiples of the spacing
  (3). Unchanged, on purpose.
* **`DurationEstimator` ignores corners where runs meet**, today and after.
* A comment on `PostWorkings` in `EstimateEngine.kt` and the header of
  `tests/downstream-posts-concrete-waste-tax.test.mjs` still say 77 fixtures; there are 85.
* **Other work landed beside this while it was being written, and the pieces agree except where
  noted.** `RunJoinArithmetic` (`FenceGeometry.kt`) and `tests/a33-join-arithmetic-posts.test.mjs`
  reach the same figures and the same rules (taller owns, then sort order, then id; a T is a corner;
  typed footage is a corner; teardown, closed, empty, lone and self joints are ignored). I ran that
  test: 125 checks, 0 failures. It pins the same numbers independently and compiles the Kotlin
  transcription, which I could not. The open points are the **storage home** (1.6) and the
  **transition item** (4.2, 6). `tests/a32-panel-choice-ignores-height.test.mjs` and
  `tests/a34-height-blindness.test.mjs` cover the height defect more completely than the test I first
  wrote for it, so I removed mine.

---

## 10. How this was checked

* **Read, not assumed:** `takeoff.ts`, `geometry.ts`, `line-items.ts`, `totals.ts`, `types.ts`,
  `load.ts`, `index.ts`, `price-job/index.ts`, `quote-view/index.ts`, the Kotlin `FenceRun`,
  `EstimateEngine.computePostCounts`, `snapDrawPoint`, `SurveyViewModel`, `EntitySync` fence-run
  sync, `TakeoffRefresher`, `DurationEstimator`, the re-approval and drawing-version SQL, and, once
  they appeared, `RunJoin.kt`, `RunJoinArithmetic` and the headers of the a32/a33/a34 tests.
* **Live, SELECT only, positive-controlled:** `fence_runs` has 34 columns and no joint column, every
  grant on it is table-level and its policies name no column; 17 live runs, none ornamental;
  triggers and fingerprint function signatures match the repo's SQL; of those, 13 are drawn,
  non-teardown runs in 9 jobs, and none meets another (the pair matcher was proved first by planting
  an exact pair and a 2 px pair inside the query: it found exactly 1 and 2). The proof rows in the
  `.sql` were run before the columns exist: the column checks read false, the rest true, and the
  default-value literals were checked against sibling columns.
* **The arithmetic was run, not just reasoned.** The spec was implemented as a patch to a *scratch
  copy* of the engine (Appendix A plus about 30 lines in `takeoff.ts`, `types.ts`, `index.ts` and
  `line-items.ts`). Against it: `a32-join-posts` 13 baseline + 21 pending all green + 8 guards live
  and green; `a32-join-transition` 4 pending + 4 guards green. Against the **real** engine: baselines
  pass, pending cases are red with the number the engine produced today, guards print `vacuous`
  because their control (the same wiring without the disqualifier) does not join yet.
* **Every guard has teeth.** One deliberate bug at a time was planted in the prototype (inferring a
  join from coordinates, admitting a teardown run, an empty run, a closed run, a self-join or a lone
  id; ignoring the angle; thresholds of 10 and 25 degrees; reading an END member's heading from the
  wrong end; assuming every join is end-to-start; ignoring height for ownership). Each turned the
  case written for it red, 12 of 12.
* **Not done:** no Gradle, no `check-parity.mjs`, nothing applied, nothing deployed, no source file
  edited. The Kotlin port into the engine and its parity fixtures are untested because they do not
  exist.

Test index. Baselines (green now, must stay green): B1-B12 and B5b. Pending join arithmetic: P1-P10.
Policy: D1-D3. Guards (each with a control): G1-G8. Transition (contested): T1a-T4.

---

---

## 11. The decision, 1 Oct 2026

Written after reading the live function bodies out of `pg_proc` and probing his data read-only.
This section settles what sections 1.6 and 7.2 left open. **Nothing was applied and nothing was
deployed.** The gesture itself is deliberately not built here: the next phase builds it, and it
depends on 11.1 and cannot ship before 11.2.

What he said today was "for the grid, I'm not able to attach the fence to the other ones", and
what he said before that is the spec: *"it would not be a corner post if I drew it on the other
side until I connect it to that one."* A post becomes a corner because **he joined it**, never
because two points happen to land on the same spot. Everything below holds that line.

### 11.1 Storage: columns on `fence_runs`. The `run_joins` table is retired.

The two joint columns win. Section 1.6 recommended it; this is that recommendation re-argued from
the code, including the two places where 1.6's own table is wrong or incomplete.

**Where 1.6 is right, and it is the deciding point.** The join has to be noticed by
`reapp_on_run_change`, the `AFTER` trigger on `fence_runs`. With columns it already is noticed —
the write *is* a write to `fence_runs`, so the trigger fires, and all that is missing is about
twenty lines of fingerprint (11.2, written). With a table, `RunJoin.kt`'s own header says it
plainly: *nothing at all fires on a join*. That would need a new `SECURITY DEFINER` trigger on a
new table, and a fingerprint that reads across two tables — on the one rule in this product that
must not be walked past. The whole reason this phase exists is that the join must not move an
approved price silently, and one design starts half-done while the other starts at zero.

Second: a new cloud table has to be added by hand to every list that protects a table. This
repository's history is a catalogue of a list that was missed — `supabase_sweep_hardening_patch.sql`,
`supabase_crew_job_scope.sql` (twice), the realtime publication, the tenant-isolation tests, and,
per `RunJoin.kt`'s own header, `SyncTables.ALL` (the deletion reaper) and the unsynced-work
warning. Probed live: every grant on `fence_runs` is table-level and its policies name only
`company_id` and the suspension check, so two new columns inherit RLS, crew scope, the plan gate
and the suspension gate **with no new line of policy anywhere**. A new table inherits nothing.

**Where 1.6's table is wrong, and it matters because it is the argument *for* the table.**

1. **`explicitNulls = false`.** 1.6 lists this against neither design, but it is the reason the
   columns must be `text not null default ''` rather than a nullable uuid, and the file already
   says so. Worth restating because it is the trap that would make un-joining a one-way door: a
   Kotlin `null` is **left out** of the upsert body, so a nullable column could be set from the
   phone and never cleared, and the office would go on pricing two runs as joined after he had
   pulled them apart. `''` travels. Note this cuts **against** the table too: `RunJoin.kt`'s
   header says its own future sync must send the empty string and map it back to null on pull,
   because its local unique index cannot hold two empty strings — i.e. the table needs the same
   trick *plus* a mapping layer the columns do not.
2. **Batched upserts.** 1.6 reads this as a point for the table ("the schema refuses the
   nonsense"). It is the opposite. `fence_runs` upserts go up in batches and **one row the table
   refuses fails the whole batch**, so nothing for that company syncs — the same way one
   duplicate estimate-line id once stopped a job's estimate reaching the cloud. The table's
   three unique indexes are exactly the kind of refusal that does that. The columns design takes
   any text and makes the **readers** validate, which fails toward today's higher price instead
   of toward a company whose phones have stopped syncing. A schema that refuses nonsense is a
   virtue locally and a liability on a batched wire.
3. **A T, three ends at one point.** This is where the table buys least. Both designs model a T
   the same way — three ends, one id — so the table's three unique indexes refuse nothing a T
   needs refusing, and pricing still has to re-check closed, typed and teardown on every price
   either way (`RunJoin.kt`'s header says so itself). The table's refusals are a subset of the
   checks the readers must perform regardless.
4. **The one thing the table genuinely does better** is the one 1.6 names: per-end rows survive a
   stale whole-row push of the run. With columns, a phone that pushes an old copy of a run after
   someone joined it drops the join. That is real — and it is the failure mode `fence_runs`
   already has for `points_encoded`, `gates_encoded`, `closed_loop`, `panel_height_ft` and every
   other field on the row, and it fails toward **today's higher post count**, visibly, and with
   11.2 applied it withdraws the approval while doing so. Trading that for the re-approval gap
   and seven protection lists is not a trade.

**The ambiguity the two designs disagreed on, settled.** `RunJoin.kt` refuses to *create* a join
on a typed-footage run; this document's reader *honours* an existing join on one as a corner post
(2.4, D3). Both stand: **refuse on write, honour on read.** A run that was joined and later typed
is not silently un-joined, and a typed run cannot be joined in the first place. That is his rule
("until I connect it"), applied in both directions.

**What retiring the loser costs, concretely.** Not a file deletion. `run_joins` is live on
phones: `AppDatabase.kt` lists `RunJoin::class` among its entities at `version = 49`, exposes
`runJoinDao()`, and `SchemaV48.MIGRATION_47_48_STATEMENTS` creates the table — and its own comment
records that **a link build at schema 48 already exists**, which build 568 confirms. So:

| Step | File | Cost |
|---|---|---|
| Drop the entity from the `@Database` list and `runJoinDao()` | `AppDatabase.kt` | 2 lines |
| A **new** `SchemaV50` with `DROP TABLE IF EXISTS run_joins` and `version = 50` | `AppDatabase.kt` | a migration, not an edit to 48 or 49. Room validates the schema against the entity list on open: remove the entity without the migration and **every phone that already opened a 48 or 49 database refuses to open it** |
| Remove `observeRunJoins`, `getRunJoins`, `joinRunEnds`, `unjoinRunEnd` and the private helper | `Repository.kt` | about 80 lines, one `guardWrite` block |
| Delete the file and its storage test | `data/RunJoin.kt`, `tests/a33-join-model-storage.test.mjs` | the test asserts the table, the migration, the DAO and `planJoin`; it is wholly about the retired design |
| **Keep** `planJoin`'s refusals | re-home them as the drawing screen's write-time checks (7.4) | they are the right rules; only their storage is wrong |
| **Keep** `RunJoinArithmetic` (`FenceGeometry.kt`) and `tests/a33-join-arithmetic-posts.test.mjs` | — | the arithmetic already mirrors `start_joint` / `end_joint` and is home-agnostic. 125 checks, independent of storage |

**This phase did not do that retirement, on purpose.** `Repository.kt` is held by another wave and
`AppDatabase.kt` cannot be edited without the Room migration above. Deleting `RunJoin.kt` on its
own would leave `AppDatabase.kt` and `Repository.kt` referring to a type that no longer exists —
**a compile error, with a release build queued behind this.** So the file is left in place, inert,
with the decision recorded here and in `supabase_a32_join_runs.sql`. It is read by no engine and
called by no screen, so it costs nothing to leave standing for one more wave; the only thing that
gets more expensive with delay is the `DROP TABLE` migration, and that is already unavoidable.

### 11.2 The approval hazard. Verified, and the fix is written.

**Verified, not taken on trust.** Read live from `pg_proc` on 1 Oct 2026, with a positive control
(the same query found six of the seven functions asked for and reported a non-zero body length for
each, so an empty answer could not read as "clean"):

* `reapp_row_takeoff(r public.fence_runs, ppf double precision)` — its entire body is one call to
  `reapp_run_takeoff(r.points_encoded, r.gates_encoded, r.closed_loop, r.manual_linear_feet,
  r.manual_corner_count, r.is_teardown, ppf)`.
* `reapp_run_takeoff` returns seven fields: `b=` built feet, `t=` teardown feet, `c=` corners,
  `e=` ends, `g=` gate count, `gf=` gate feet, `gm=` gate mountings.
* `position('start_joint' in prosrc)` and `position('end_joint' in prosrc)` are **0** in
  `reapp_run_takeoff`, `reapp_row_takeoff`, `reapp_job_takeoff` **and** `reapp_run_snapshot`.
* `reapp_on_run_change` (`SECURITY DEFINER`, the trigger `reapproval_on_drawing_change` on
  `fence_runs`) computes `before_fp` and `after_fp` with `reapp_row_takeoff` and, on
  `if before_fp = after_fp`, **returns without touching the approval**.

So the answer to "would they notice a join?" is **no, and silently**. Writing a joint id to two
ends changes neither the points nor the gates nor the flags the fingerprint reads. The trigger sees
a write that changed nothing, the approval stands, and the post count drops by one per joint. The
customer's agreed price moves **down**, behind her back, on a quote she has already approved.
`docs/REAPPROVAL_RULE.md` says the office "must not be able to quietly enlarge an approved job";
quietly shrinking it is the same wrong, and it is the direction a join actually goes.

**Which way it must fail: toward withdrawing.** A withdrawal that was not strictly necessary costs
one more tap on a quote link she already has. A join that slips past costs her a fence she never
agreed to buy.

**The rule is not reinvented.** `docs/REAPPROVAL_RULE.md` already defines the whole mechanism —
history row in `quote_reapprovals` with the prior approval and the before/after takeoff, lines in
`audit_log` and `field_changes`, `quote_approved_at` cleared, `reapproval_required_at` stamped,
**no money column written**, and re-approval through the ordinary quote link. The fix adds nothing
to that. It teaches the existing fingerprint to see the join, so the existing rule fires.

**`supabase_a56_join_reapproval_fingerprint.sql`, unapplied.** It replaces two function bodies in
place and touches nothing else: no row, no table, no column, no policy, no grant, no trigger, no
money. It must run **after** `supabase_a32_join_runs.sql`, and PART 0 refuses to go further if the
columns are absent.

*PART A — the fingerprint.* A tail is appended to the existing seven fields, and **only** for a run
that is a live join member: a joint id of uuid shape, open, not a teardown run, and pricing some
footage. Those are 1.4's own conditions (G4, G5, G6), so the fingerprint says exactly what the
engine will act on. Gating on them hides nothing, because each of them is already visible in the
seven base fields — `is_teardown` swaps `b=` and `t=`, `closed_loop` moves `e=` from 2 to 0 and
changes the length, clearing the points empties `b=` — so a run that becomes ineligible moves its
own fingerprint anyway.

The tail is `|sj=|ej=|jf=|jph=|jfh=|jso=`: the two ids (**membership** — the only part that changes
the post *count*), `fence_type` (it decides which height column ownership reads), **both** height
columns raw, and `sort_order`.

* **Why the heights.** The shared post is billed to the **tallest** member (2.4), and since
  `supabase_a50_post_heights.sql` a post row is chosen **by height** — so which member owns it is
  a price, not a bookkeeping detail. Section 6.3's "height is read by no pricing code" is stale
  and now says so. Both columns go in rather than the one the fence type selects, so a fence-type
  change cannot hide a height change behind it.
* **Why `sort_order`, and how to get rid of it.** It is the ownership tie-break between members of
  equal height, so it can move a post — and therefore money — between two runs. It is also the
  one field `docs/REAPPROVAL_RULE.md` lists as **explicitly not material**, and it stays not
  material for every unjoined run, because the tail is empty there. The cost of keeping it: on a
  joined, approved job, **reordering the run list withdraws the approval**. That is the safe
  direction, which is why it is in. **The cheaper fix is in the engine, not the fingerprint:** let
  ownership be *tallest, then lowest `sync_id`*, dropping `sort_order` from the tie-break.
  `sync_id` is immutable, so it can never move a price, and the day that lands the `|jso=` line
  comes out of the SQL and nothing else changes. That is a one-line change to
  `RunJoinArithmetic` (`FenceGeometry.kt`) and Appendix A's `byOrder`, plus the D1 policy test —
  **recommended, and not done here** because this phase owns neither file. See 11.5.
* **Why not `is_transition`.** Contested (4.2, Q4 — the owner's call). Joining does not depend on
  it. When it lands it appends `|jx=1` to the same tail under the same gate.

*Byte identity is load-bearing, not tidiness.* `reapp_restores_approved_state` matches a freshly
computed fingerprint against the `takeoff_before` **text** stored in `quote_reapprovals`, so a
format change makes every withdrawal already on the books unrestorable — and there are rows on the
books: **two of his jobs are flagged needs-reapproval right now.** The gate keeps every one of
them matchable. A fourth gate clause, `reapp_is_empty(fp)`, exists for the same family of reason:
the trigger lets an empty run be added to or removed from an approved job without disturbing it by
comparing against the exact literal `b=0.0|t=0.0|c=0|e=0|g=0|gf=0.0|gm=`, and anything appended to
an empty run's fingerprint would break that comparison for ever.

*Proved before it was written, read-only, on his 16 live runs.* The tail expression was computed
inline as a `SELECT` — no function created, no row written, the joint values synthesised — in four
variants per run:

| Claim | Result |
|---|---|
| unjoined: new fingerprint byte-identical to today's, every run | true |
| **canary**: the same test on the joined variant | **false** — so the row above can fail |
| joined: eligible runs whose fingerprint moved | 11 of 11 |
| joined: eligible runs that did **not** move | 0 |
| two different joint ids at the same end fingerprint differently | true |
| a junk (non-uuid) joint id is ignored: byte-identical to today | true |
| `reapp_is_empty` still true for the all-zero fingerprint, false for a real one | true / false |

Every proof row in the `.sql` that can be run before the columns exist was also run live and
returns what it asserts, canaries included.

**A row-level fingerprint is enough for a fact that spans two rows.** A join writes an id to both
ends, so both rows are written and the trigger fires twice; the first firing withdraws and the
second finds nothing left to withdraw (`reapp_withdraw_approval` returns early when
`quote_approved_at` is null), so **one** withdrawal row is written, not two. If the two pushes are
separated — offline sync sends one run at a time — the first arrival withdraws while the id is
still alone and therefore still priced as a free end: a withdrawal slightly *ahead* of the price
move, which is the safe side. Every case where a member's geometry, angle, eligibility or
membership count changes without its own joint columns changing is covered too, because that
member's own row changed and its own fingerprint moved.

**One hole this does not close, named rather than implied.** The fingerprint reads geometry only.
Changing a run's `fence_type`, `color_or_finish` or `panel_height_ft` moves its material and post
prices **today**, on an unjoined run, and the approval stands — `REAPPROVAL_RULE.md` lists
`color_or_finish` as not material, which was true before height and colour became selection keys.
That is wider than joins and older than this track, and closing it means putting those columns in
the **base** fingerprint, which is the format change that would make the two pending withdrawals
unrestorable. It needs its own file, its own decision about those two rows, and the owner told.
Joins do not widen it: inside a joint the heights are in the tail.

### 11.3 Drawing versions: what a restore produces now, and what must change

`reapp_run_snapshot` writes six bar-joined parts — points, gates, closed, typed feet, typed
corners, teardown — and carries no joints (verified live). A restore writes those columns back onto
the run: the office's `patch` in `website/dashboard.html` (`points_encoded`, `gates_encoded`,
`closed_loop`, and from a six-part record `manual_linear_feet`, `manual_corner_count`,
`is_teardown`) and the phone's `RunSnapshot.appliedTo`. Neither writes a joint column.

**Exactly what that produces**, in two parts:

1. **Yesterday's points under today's joints.** The engine honours a join however far apart its
   ends have drifted — the owner's decision beats the pixels (2.5) — so the restored drawing keeps
   a shared post that the restored geometry does not have. The customer's restored price is
   **one post lower** than the price she approved. It is also the case the drawing screen's
   open-join warning (7.4.6) exists for, except that here nobody touched the drawing: the restore
   did it.
2. **The approval does not come back, and the reason given is wrong.**
   `reapp_restores_approved_state` matches the recomputed fingerprint against the stored
   `takeoff_before`. With PART A live, today's joints are in the recomputed value and yesterday's
   in the stored one, so it cannot match; the office reports that the price must have moved and
   names the drawing, when what actually differs is a joint that is invisible on screen. That is
   the same shape of wrong cause that file's own header describes for typed footage.

Worse than either, and the reason a gated snapshot is not enough on its own: **a join made after
an approval could never be put back.** The withdrawal's snapshot, taken from the pre-join drawing,
says nothing about joints; a restore from it leaves the join in place for ever.

**What must change.** A **seventh** part on the snapshot, written only when the run carries a
joint, holding `sj=<id>;ej=<id>` — a key=value list, not a positional field, so a later flag (the
contested `is_transition`) adds a **key** and the readers' accepted counts change **once, ever**.
Neither `;` nor `=` can occur in an existing part: points and gates are `:`-pairs joined by `,`,
and the flags are `1` or `0`.

The contract that makes an un-join restorable:

| Parts | Means | A restore writes |
|---|---|---|
| 3 | outline only, as today — it never recorded the rest | nothing to the joint columns |
| 6 | **both joints were empty** | `''` to `start_joint` and `end_joint` |
| 7 | parts 1-6 as today; part 7 is `sj=<id>;ej=<id>`, both keys always present, either value possibly empty | the two ids as given |

Six meaning "no joints" is true of every six-part record that can exist: those written before
`supabase_a32_join_runs.sql` had no columns to record, and those written after it are gated on the
joints being empty. That is what lets a restore **clear** a join, which is the whole point.

**The writer normalises, and that was found by running it rather than reasoning about it.** PART B
was tried against synthesised rows before it was written down, and the junk case came back as
`sj=oops;ej=` — a seven-part snapshot the reader contract above has to refuse, which would leave
that run's withdrawal **permanently unrestorable over a value the price already ignores**. So the
snapshot uuid-checks both columns exactly as the fingerprint does: junk snapshots as **six** parts,
a restore puts `''` back, and that is what the price already believes. The two functions therefore
agree, field for field, on what counts as a joint — and a malformed value can only reach a reader
from something that is not `reapp_run_snapshot`, which is precisely when refusing the row is right.
Measured on the seven synthesised cases: unjoined → 6 parts and an unchanged fingerprint; joined
and eligible → 7 parts and a moved fingerprint; joined but teardown, closed or empty → 7 parts and
an **unchanged** fingerprint (the snapshot records it, the price ignores it, which is correct for
both); joined with junk → 6 parts, unchanged; joined on a typed chain-link run → 7 parts and a
moved fingerprint carrying `jfh=5.00`, honouring the join as 2.4 and D3 require.

**The strict readers, named, both sides.** Both refuse any count but 3 or 6 today:

* **Phone** — `parseRunSnapshot`, `app/src/main/java/com/fenceestimator/app/ui/jobs/JobDetailViewModel.kt`:
  `if (parts.size != 3 && parts.size != 6) return null`. It must accept 7, put the two ids into
  `RunSnapshot` / `DrawingSnapshot`, and include them in `appliedTo` — otherwise the
  `alreadyBack` check (`snapshot.appliedTo(run) == run`) calls a run "already back" whose joints
  are not, which is exactly the trap its own comment describes for typed footage.
* **Office** — `reapprovalRestoreState`, `website/dashboard.html`:
  `if (parts.length !== 3 && parts.length !== 6) return { kind: 'unreadable' }`. It must accept 7,
  validate each value as empty-or-uuid with the same strictness it already applies to the flags and
  the typed figures, ignore an unknown key with a well-formed value (so a later flag does not
  break an older reader), and add the two columns to its `patch`.

**The order is readers first, writer second.** Ship PART B before the readers and every snapshot
written for a joined run comes back "unreadable" on both — the restore button dies on exactly the
rows that need it. It fails safe, and it fails. An old phone meeting a seven-part snapshot refuses
it, which is the right way round: that row cannot be restored from that phone, rather than being
half-restored. `supabase_a56_join_reapproval_fingerprint.sql` carries PART B behind a
*do-not-apply* marker and `tests/a56-join-decision-fingerprint.test.mjs` holds the order from both
sides — red if the marker goes while a reader still refuses seven, red if both readers accept
seven and the marker is still there.

**One stale check this creates, in a file this phase does not own.**
`supabase_r8_drawing_versions_full_snapshot.sql` has a proof row asserting that every live run's
snapshot splits into exactly **6** parts. The day a run is joined that row reads false for a
perfectly correct snapshot — a check that can only fail, which is how a good build was thrown away
before (`CLAUDE.md`: "A check against UI text rots into a check that cannot pass"). It needs
`in (6, 7)`. Whoever owns that file must relax it; it is a one-word change and it is harmless to
make before PART B.

### 11.4 No backfill. Confirmed by probe, and a tolerance would have moved a real quote.

**Runs whose ends already coincide must not become joined.** A join removes a post from a price,
and doing it behind him changes quotes he has already sent — and it is the opposite of what he
said: a post is a corner *because he connected it*.

Probed read-only on his company, aggregates only, with a positive control planted **inside** the
matcher (two synthetic runs sharing an end exactly and two more 2 px apart, in a job of their own)
so a zero on the real data could not be an empty-query artefact:

| | |
|---|---|
| control: pairs exactly coincident | **1**, as planted |
| control: pairs within 3 px | **2**, as planted |
| his drawn, non-deleted runs / jobs holding them | 12 in 8 jobs (16 non-deleted runs in all) |
| **pairs of ends exactly coincident** | **0** |
| pairs of ends within 60 px | 0 |
| closest pair of ends anywhere | 63.81 px |
| **pairs within 1 ft at that job's own scale** | **1** — 63.81 px at 80 px/ft, **0.798 ft apart** |

So **nothing of his would be joined by a backfill, and nothing is hidden.** The last row is the
interesting one and it is an argument, not a footnote: a backfill with a *tolerance in feet* —
which is the only honest unit, since 26 px is 1.3 ft on the grid and 6.5 ft on a satellite photo
(1.2) — would have joined **one real pair on one real job**, removing a post from a quote he had
already produced. One pair in twelve runs is not a rounding error; it is the feature doing the
wrong thing on its first day. `supabase_a32_join_runs.sql` writes no row, and the new file writes
no row; both carry a proof that no run is joined after they run.

Also read while there, and worth his knowing: of the 8 jobs with drawn runs, **0 are approved
right now**, 2 are already flagged needs-reapproval and 5 are signed. The canary confirms the zero
is real (all 8 read as not-approved, so the count is not vacuous). That means the hazard in 11.2
is not firing on live data **today** — it is a trap set for the first approved job someone joins
runs on, which is why the fix goes in before the gesture and not after it.

### 11.5 What the next phase needs from this one

1. Apply `supabase_a32_join_runs.sql`, then
   `supabase_a56_join_reapproval_fingerprint.sql` **PART A** — dev first, read the proof rows.
   Do not build the gesture before PART A is live.
2. Widen both snapshot readers to 3 / 6 / 7 per 11.3, ship them, **then** apply PART B.
3. Relax `supabase_r8_drawing_versions_full_snapshot.sql`'s 6-part proof row to `in (6, 7)`.
3b. **One red check, caused by this phase, one line to fix.** `tests/a33-join-arithmetic-posts.test.mjs`
   check `7k-proposed` requires the header of `FenceGeometry.kt` to name every unapplied `.sql`
   that mentions a joint column. The new file is one, and the header does not name it, so the
   suite reads **124 ok, 1 FAIL** instead of 125 ok. The fix is to add
   `supabase_a56_join_reapproval_fingerprint.sql` to the list of files that header already names
   beside `supabase_a32_join_runs.sql`. **Not done here**: `FenceGeometry.kt` is not this phase's
   to edit and a release build is queued. The check is right and worth keeping — a person reading
   `RunJoinArithmetic` does need to know the fingerprint file exists.
4. Engine wave: drop `sort_order` from the ownership tie-break (tallest, then lowest `sync_id`),
   then delete the `|jso=` line from PART A. One line in `RunJoinArithmetic`, one in Appendix A's
   `byOrder`, one policy test.
5. Retire `run_joins` per the table in 11.1 — including the `SchemaV50` `DROP TABLE` migration,
   which is not optional.
6. Everything in 7.1, 7.3, 7.4 and 7.6 still stands; 7.2 is now written rather than proposed.
7. Ask him Q4 (is there a transition product?) before any of section 6 is built.

---

## Appendix A. The reference algorithm (prototype, validated)

```ts
// joins.ts -- pure: no clock, no database, no catalog.
import { f32 } from "./f32.ts";
import { CORNER_ANGLE_THRESHOLD_DEGREES, decodePoints } from "./geometry.ts";
import type { FencePoint } from "./geometry.ts";
import { resolveGeometry } from "./takeoff.ts";
import type { FenceRun } from "./types.ts";

export type EndKind = "FREE" | "OWNS_LINE" | "OWNS_CORNER" | "SHARED";
export interface JoinedEnds { start: EndKind; end: EndKind }
type Which = "START" | "END";
interface Member { run: FenceRun; which: Which }

const RADIANS_TO_DEGREES = 57.29577951308232;   // as analyze() uses it

export function runHeightFt(run: FenceRun): number {
  if (run.fenceType === "CHAIN_LINK") return run.fabricHeightFt;
  if (run.fenceType === "SPLIT_RAIL") return 0;
  return run.panelHeightFt;
}

// 1.4: open, not coming out, and it prices some footage.
function eligible(run: FenceRun, pixelsPerFoot: number): boolean {
  if (run.isTeardown || run.closedLoop) return false;
  return resolveGeometry(run, pixelsPerFoot).totalLinearFeet > 0;
}

// The run's own segment at this end, [from, to], in the direction of TRAVEL.
function segment(run: FenceRun, which: Which, direction: "INTO" | "AWAY"): [FencePoint, FencePoint] | null {
  if (run.manualLinearFeet !== null && run.manualLinearFeet > 0) return null;   // typed: no heading
  const p = decodePoints(run.pointsEncoded);
  if (p.length < 2) return null;
  const [end, next] = which === "START" ? [p[0], p[1]] : [p[p.length - 1], p[p.length - 2]];
  if (end.x === next.x && end.y === next.y) return null;
  return direction === "INTO" ? [next, end] : [end, next];
}

// analyze()'s own angle arithmetic, so a joint classifies like the same legs as one polyline.
function turnDegrees(first: Member, second: Member): number | null {
  const a = segment(first.run, first.which, "INTO");
  const b = segment(second.run, second.which, "AWAY");
  if (a === null || b === null) return null;
  const angleIn = Math.atan2(f32(a[1].y - a[0].y), f32(a[1].x - a[0].x));
  const angleOut = Math.atan2(f32(b[1].y - b[0].y), f32(b[1].x - b[0].x));
  let turnRad = angleOut - angleIn;
  while (turnRad > Math.PI) turnRad -= 2 * Math.PI;
  while (turnRad < -Math.PI) turnRad += 2 * Math.PI;
  return f32(Math.abs(turnRad) * RADIANS_TO_DEGREES);
}

const byOrder = (a: Member, b: Member): number =>
  (a.run.sortOrder - b.run.sortOrder) ||
  (a.run.syncId < b.run.syncId ? -1 : a.run.syncId > b.run.syncId ? 1 : 0) ||
  (a.which < b.which ? -1 : a.which > b.which ? 1 : 0);

function jointKind(members: Member[]): "LINE" | "CORNER" {
  if (members.length >= 3) return "CORNER";                 // a T
  const [first, second] = [...members].sort(byOrder);
  const turn = turnDegrees(first, second);
  if (turn === null) return "CORNER";                       // no angle to measure
  return turn >= CORNER_ANGLE_THRESHOLD_DEGREES ? "CORNER" : "LINE";
}

function owner(members: Member[]): Member {                 // tallest, then sort_order, then sync_id
  return [...members].sort((a, b) => (runHeightFt(b.run) - runHeightFt(a.run)) || byOrder(a, b))[0];
}

export function planJoins(runs: readonly FenceRun[], pixelsPerFoot: number): Map<string, JoinedEnds> {
  const plan = new Map<string, JoinedEnds>();
  for (const r of runs) plan.set(r.syncId, { start: "FREE", end: "FREE" });

  const groups = new Map<string, Member[]>();
  for (const run of runs) {
    if (!eligible(run, pixelsPerFoot)) continue;
    for (const which of ["START", "END"] as const) {
      const id = (which === "START" ? run.startJoint : run.endJoint).trim();
      if (id === "") continue;
      const g = groups.get(id);
      if (g === undefined) groups.set(id, [{ run, which }]); else g.push({ run, which });
    }
  }

  for (const members of groups.values()) {
    // A run carrying the same joint at BOTH ends is not trusted in it at all.
    const seen = new Map<string, number>();
    for (const m of members) seen.set(m.run.syncId, (seen.get(m.run.syncId) ?? 0) + 1);
    const clean = members.filter((m) => seen.get(m.run.syncId) === 1);
    if (new Set(clean.map((m) => m.run.syncId)).size < 2) continue;   // a lone id is a free end

    const kind = jointKind(clean);
    const own = owner(clean);
    for (const m of clean) {
      const ends = plan.get(m.run.syncId)!;
      const value: EndKind = m === own ? (kind === "CORNER" ? "OWNS_CORNER" : "OWNS_LINE") : "SHARED";
      if (m.which === "START") ends.start = value; else ends.end = value;
    }
  }
  return plan;
}
```

And in `computePostCounts`, after `linePosts` is computed as today (call it `baseLine`):

```ts
let freeEnds = endPosts, ownedCorner = 0, ownedLine = 0;
if (joined !== undefined && endPosts === 2) {
  for (const e of [joined.start, joined.end]) {
    if (e === "FREE") continue;
    freeEnds -= 1;                                   // this end no longer bills an END post
    if (e === "OWNS_CORNER") ownedCorner += 1;       // ... the owner bills the shared post
    else if (e === "OWNS_LINE") ownedLine += 1;
  }
}
linePosts   = baseLine + ownedLine;
cornerPosts = cornerPosts + ownedCorner;
endPosts    = freeEnds;
totalPosts  = linePosts + cornerPosts + endPosts + gatePosts;
terminalPosts = cornerPosts + endPosts + gatePosts;
```

With no joints every value is what it is today (`freeEnds` = 2, nothing owned), which is why
nothing already priced can move.

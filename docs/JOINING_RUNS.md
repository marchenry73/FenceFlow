# Joining runs, and the 6-to-4 transition

Written 2026-10-01 from the code and the live schema, read-only. **Nothing here is
implemented and nothing was applied.** Line numbers are as of that day; the pricing files
are being edited by other work, so function names are the stable reference.

Owner's asks this settles (`FIELD_FEEDBACK_2026-10-01.md` C2 and C6):

> "connect the sides together ... connect the whole fence together not necessarily close
> perimeter I still want that option" and "the 6ft high fence to go from 6ft to 4ft ...
> slanted diagonally to the 4 ft and then continue on."

What this track produced, and what it deliberately did not touch:

| File | What |
|---|---|
| `docs/JOINING_RUNS.md` | this document |
| `supabase_a32_join_runs.sql` | PART 1: two additive joint columns on `fence_runs`. PART 2 (contested): the transition flag. **Unapplied.** |
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
  UI must not ship before the database follow-up in 7.2.
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

**Recommendation: columns.** The deciding facts are the first two data rows and the re-approval row:
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
  engine reads is `fabric_height_ft`, for chain link. So a run cannot change height along its length,
  and nothing about a run's height changes its price today.
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
panel is chosen by nearest width, then cheapest, then sync id, and `panel_height_ft` is read by no
pricing code, so a 6 ft ornamental iron run is priced with the cheaper 4'H panel (the shipped
`template-08-ornamental-iron-6ft.json` fixture expects it). What it means for this track:

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

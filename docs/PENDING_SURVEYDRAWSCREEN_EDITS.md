# Edits snap-to-connect could not make itself

It was forbidden SurveyDrawScreen.kt because the house-anchor wave owned it.
Apply these once that wave lands, then build.

---

All Node tests pass. Here is the result.

## CONFIRMED (verified, not trusted)

| Claim | Verdict |
|---|---|
| `SurveyViewModel.snapTargets` collects vertices from **every** run of the job and feeds them to `snapDrawPoint` as `otherVertices` | **Confirmed**, `SurveyViewModel.kt:637`. The doc comment names the exact problem. |
| A vertex snap lands the point **exactly** on the other run's corner | **Confirmed** and stronger than stated: `snapDrawPoint` returns `SnapResult(nearestVertex, SnapKind.VERTEX)` — the existing corner **object**, so the two are bit-identical. That is what makes float equality the correct filter. |
| Only the point being placed ever moves | **Confirmed**, in `snapDrawPoint`'s own contract. |
| Two coincident ends with no joint still bill two end posts | **Confirmed** — `tests/a33-join-arithmetic-posts.test.mjs` check `5a-coincident-no-id`: total 10, end 4, `changesNothing`. |
| Everything behind the join is built and shipped; all three gates true | **Confirmed**: `JOIN_STORAGE_READY = true`, `JOIN_PRICING_READY = true`, `EntitySync.JOIN_COLUMNS_LIVE = true`; Room 50 + `MIGRATION_49_50` registered; `RunJoinGesture`/`RunJoinArithmetic` present; write seam `writeJointIds` → `Repository.setRunJointIds`, read back by `jointIdsOf`. |
| `adjustJoins` groups by joint id and never consults position | **Confirmed** — `RunJoinArithmetic.adjust` reads positions only for `turnDegrees` (line vs corner post), after membership is decided. |
| A joint is honoured at any distance | **Confirmed in live data, far worse than the brief says.** |

**New finding, from read-only probes (positive control + canary in each, all canaries returned 0):**

- Columns exist on `public.fence_runs` (control 2, canary 0). 6 run rows carry a joint.
- Three live joints. Gaps between their two ends: **0.00 ft**, **0.80 ft**, and **110.63 ft** (4425.3534 drawing units ÷ 79.75 px/ft, that job's own calibration).
- The 110 ft one is **live**: both members open, not teardown, 4 and 2 points → `endCount >= 2` → `isLive` true. So the arithmetic is billing **one shared corner post** for a corner the plan draws twice, 110 feet apart. That is the strongest possible case for Part B, and it was made by the Attach-mode path.
- `coincident_but_not_jointed` = **0** across 68 end pairs: there are no coincident-unjointed pairs left in production (`supabase_a78_join_makayla_corners.sql` was applied).

## REFUTED / CORRECTED

1. **"roughly 8 inches" / "about 0.6 ft"** — the second corner's real gap is **0.80 ft** (9.6 in), not 0.6 ft. `tests/a80` check 8c/8d is written to the real number.
2. **"If the only re-price is a manual Suggest, say so loudly"** — not the case. `TakeoffRefresher.pricingSignature` is a whole-row copy minus id/syncId/jobId/label/sortOrder/buildTemplateSyncId/updatedAt, so `startJoint`/`endJoint` **are** in the signature and an attach already re-priced both written rows. But there were three real holes, now closed (see Part C).
3. **The `RunJoinGesture` and `RunJoinArithmetic` header comments are stale** — they still say "NOTHING HERE IS STORED YET", "columns that do not exist", "NO PRICE HAS MOVED YET", "supabase_a32_join_runs.sql … NOT APPLIED". All three are false as of today's flags. I left them (not my wave's claim to rewrite) but they are actively misleading; `a59` check 2c still asserts the Postgres half is unapplied and passes, which means that test is now pinning a false premise about the repo `.sql` file rather than the database.
4. **`attach_gap` is now a lie in all three locales** — "Attaching them moves neither one; line them up with Adjust." I cannot edit `strings.xml`; the screen edit below removes its only use site, leaving it dead.

## THE SEVEN DECISIONS

**1. Which snaps qualify.** Only `SnapKind.VERTEX`, only onto **another** run's **first or last** point, only when that end is **free**, and only when `RunJoinGesture.decide` allows it. Implemented as four silent-refusal clauses in `offerFromSnap`:
- *One point, exactly* — float equality, no tolerance. A vertex snap returns the existing corner; an angle or whole-foot snap returns a point computed from a heading and a distance, which is not bit-identical except by accident. A tolerance here would be proximity deciding a join.
- *An end, not a bend* — `endAtVertex` answers only index 0 or `lastIndex`. A middle corner has nowhere to be stored (two columns, start and end) and is already a corner post, so there is nothing to save.
- *Free* — a T is refused. Three ends at one post are coincident, so "the end I landed on" cannot name which member he meant. Two deliberate taps are what the Attach tool is for.
- *`decide` has the last word* — re-derived, never re-written, so the offer can never be made for something the write would refuse (teardown mismatch, closed loop, typed footage, already attached).

**2. When to ask.** A **standing, ignorable offer with one tap to accept** — not a confirm, not an undoable auto-join. Argued from what he does next: the next thing is almost always another tap, and a dialog in front of it costs a dismissal every time he traces beside a neighbour's fence; a question dismissed by reflex gets answered by reflex. "Joined — undo" is rejected outright because it attaches first and asks after, which rule 7 forbids. Carrying on drawing is never a yes: the offer writes nothing, `acceptSnapJoinOffer` re-reads the database and re-derives the whole decision, and re-checks the two ends are **still** one point before writing.

**3. What it says.** In his terms — "These two sides meet here. Make it one post?" / "One post instead of two: a post, its cap and its concrete come off the order." Never "create joint". Three locales, in **new** files `res/values*/strings_join_offer.xml`.

**4. Which end moves (draw path).** The one in his hand — and it has **already** moved, because the snap moved it before the offer existed. `acceptSnapJoinOffer` moves **no** point and asserts so (`tests/a80` check 1n). That is why Part B is free on this path: the line moved, he watched it move, and the footage change was the edit he made, not a surprise the join sprang afterwards.

**5. What it costs in feet.** Draw path: **exactly 0.00 ft** by construction — `gapCloserFor` returns null for two ends already on one point — so nothing is said, because there is nothing to say. Attach path: the side that moves is named, with its **whole-run footage before and after**, because labour is charged on run footage. The sign is not guessable: on his own job closing the gap makes that side 0.8 ft **shorter**, so labour comes **off**. Printing only the gap would not say which way the money goes.

**6. Attach mode.** It **does** close the gap now, up to `RunJoinGesture.CLOSE_GAP_MAX_FT = 2.0f`; beyond that the join is **refused** as `JoinRefusal.TOO_FAR_APART` rather than recorded. 2 ft is shorter than the shortest panel quoted and shorter than one post spacing, so a corner moved that far is being tidied onto the corner it was aiming at; past it the two ends are in different places in the yard and moving one is a redraw. Refusing rather than joining-without-closing is what stops the 110 ft joint ever being created again, and it is what makes the two paths agree: after he drags the end over, the snap lands it exactly and the draw-time offer comes to him there. Which end moves: **the free end**; both free, **the first-tapped** — which matches the shipped hint strings ("Tap the end of a side to attach it" / "Now tap the end it joins"), matches English, and is the end already drawn highlighted under his finger. Moving an end that is already at a shared post would leave the other members where they are and re-open the post it was at.

**7. Undo.**
- **Detach does not put the point back, and says so** (`attach_detach_keeps_drawing`). By the time he detaches, the corner may have been dragged, typed, undone and redone; restoring a coordinate from an unknown history would overwrite later work. `a57` pins attach/detach as equal and opposite about the **joint**; the geometry is his.
- **Undoing the drawing step that caused the join frees the joint.** `DrawingSnapshot` carries points, gates and the closed flag only, so Undo/Redo restore a drawing *without* restoring joints — undo the point a join was made on and the joint stays on what is now a different corner. `freeJointsAtVanishedEnds` frees an end whose point is not the same point after the restore, through `writeJointIds` (the one write path `a59` check 7 holds), and re-prices every run. An end whose point is unchanged keeps its joint, so undoing a gate does not take a corner post apart. It fails in the only safe direction: a stranded id reads as a free end, i.e. one post **more**.
- **Known, stated limit:** a plain **drag** of a joined end still does not clear the joint. Clearing it would be un-joining without a yes. The plan already shows the drift — `JointMarker.openByFeet` — and `markers()` is built from `JoinAdjustment.posts`, so it can never draw a shared post the price is not counting.

## PART C — the price follows

`watchDrawingForRepricing` compares each run's own signature, so it refreshes only rows that changed. Three holes, all closed by routing both join paths through a new `repriceEveryRun()`:

- **Detach** writes **one** end blank. Only that run re-prices; the run that **owned** the shared post keeps `corner +1 / end −1` in its stored line items for a post that no longer exists.
- **A T-join** writes only the two tapped ends. The third run already at that post can lose or gain ownership (taller wins) with its own row untouched.
- **`freeJointsAtVanishedEnds`** frees one end; the stranded partner loses its shared post with its row untouched.

`repriceEveryRun` keeps every existing gate: `repriceOnDrawingChange`, `viewerMayReprice()` (crew phones still may not), `CrashReporter`, and the `repriceFailed` canvas banner. `repriceAfterScaleChange()` now delegates to it, so there is one list of runs. `TakeoffRefresher.refreshRun` already calls `EstimateEngine.joinAdjustments` over every run of the job, so this is a refresh that actually changes something.

## FILES CHANGED

- `C:/Users/march/AndroidProjects/FenceEstimator/app/src/main/java/com/fenceestimator/app/geometry/FenceGeometry.kt` — `JoinRefusal.TOO_FAR_APART`; `RunJoinGesture.CLOSE_GAP_MAX_FT`, `SnapJoinOffer`, `JoinGapCloser`, `endAtVertex`, `offerFromSnap`, `gapCloserFor`.
- `C:/Users/march/AndroidProjects/FenceEstimator/app/src/main/java/com/fenceestimator/app/ui/survey/SurveyViewModel.kt` — `JoinOffer.gapCloser`; `snapJoinOffer` / `offerJoinFromSnap` / `offerJoinAfterDraw` / `acceptSnapJoinOffer` / `dismissSnapJoinOffer`; `candidateOf`; `joinTooFarFeet`; `TOO_FAR_APART` refusal in `tapJoinEnd`; `moveJoinedEnd`; `repriceEveryRun`; `freeJointsAtVanishedEnds` wired into `undoLast` and `redo`; `LAST_POINT`.
- `C:/Users/march/AndroidProjects/FenceEstimator/app/src/main/res/values/strings_join_offer.xml` (new)
- `C:/Users/march/AndroidProjects/FenceEstimator/app/src/main/res/values-es/strings_join_offer.xml` (new)
- `C:/Users/march/AndroidProjects/FenceEstimator/app/src/main/res/values-fr/strings_join_offer.xml` (new)
- `C:/Users/march/AndroidProjects/FenceEstimator/tests/a80-snap-to-connect.test.mjs` (new)
- `C:/Users/march/AndroidProjects/FenceEstimator/tests/a57-join-gesture-decision.test.mjs` — check `2g` widened from 3 to 5 state names **and made stricter** (the old `_join\w+` pattern could not see `_snapJoin*` at all; new `2g-teeth` / `2g-teeth2` assert none of that state is a collection standing in for storage, with a planted positive).

Nothing committed, staged, stashed or checked out. No SQL applied. Nothing deployed. `SurveyDrawScreen.kt` and `website/quote.html` untouched.

## EXACT EDITS NEEDED IN SurveyDrawScreen.kt

All five anchors verified unique (`grep -cF` = 1). **Edit 3 is mandatory for compilation** — the `when (reason)` is used as an expression over an exhaustive enum, so adding `TOO_FAR_APART` to `JoinRefusal` breaks the build without it.

**EDIT 1 — imports.** ANCHOR:
```
import androidx.compose.material3.SnackbarHostState
```
REPLACEMENT:
```
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarResult
```

**EDIT 2 — offer the corner after a point is DRAWN.** ANCHOR:
```
                                            SurveyMode.DRAW -> {
                                                val snap = viewModel.snapForDraw(imgPoint, snapOn)
                                                lastSnap = snap.takeIf { it.snapped }
                                                viewModel.addDrawPoint(snap.point)
                                            }
```
REPLACEMENT:
```
                                            SurveyMode.DRAW -> {
                                                val snap = viewModel.snapForDraw(imgPoint, snapOn)
                                                lastSnap = snap.takeIf { it.snapped }
                                                viewModel.addDrawPoint(snap.point)
                                                // The snap has already put this
                                                // point exactly on another
                                                // side's corner if it was
                                                // aiming at one. Ask whether
                                                // the two sides MEET -- which
                                                // is the half nothing used to
                                                // ask, so two ends sat on one
                                                // another and the takeoff
                                                // still bought two end posts.
                                                // It is a question and nothing
                                                // else: carrying on tapping is
                                                // not a yes.
                                                viewModel.offerJoinAfterDraw(snap.kind)
                                            }
```

**EDIT 3 — the refusal, and its one number.** ANCHOR:
```
    val joinRefusedNoStorage = stringResource(R.string.attach_refused_no_storage)
    LaunchedEffect(Unit) {
        viewModel.joinRefused.collect { reason ->
            snackbarHostState.showSnackbar(
                when (reason) {
                    JoinRefusal.SAME_RUN -> joinRefusedSameRun
                    JoinRefusal.CLOSED_LOOP -> joinRefusedClosed
                    JoinRefusal.TYPED_FOOTAGE -> joinRefusedTyped
                    JoinRefusal.TEARDOWN_MISMATCH -> joinRefusedTeardown
                    JoinRefusal.ALREADY_ATTACHED -> joinRefusedAlready
                    JoinRefusal.AT_ANOTHER_POINT -> joinRefusedElsewhere
                    JoinRefusal.NOT_FOUND -> joinRefusedGone
                    JoinRefusal.NO_STORAGE -> joinRefusedNoStorage
                }
            )
        }
    }
```
REPLACEMENT:
```
    val joinRefusedNoStorage = stringResource(R.string.attach_refused_no_storage)
    // The one refusal that carries a number: how far apart the two ends are.
    // Read from the view model inside the collector for that emit, which is
    // where it was written (SurveyViewModel.joinTooFarFeet) -- joinRefused is a
    // bare enum by design and seven of the eight messages need no payload.
    val joinTooFarTemplate = stringResource(R.string.attach_refused_too_far, "%1\$s")
    LaunchedEffect(Unit) {
        viewModel.joinRefused.collect { reason ->
            snackbarHostState.showSnackbar(
                when (reason) {
                    JoinRefusal.SAME_RUN -> joinRefusedSameRun
                    JoinRefusal.CLOSED_LOOP -> joinRefusedClosed
                    JoinRefusal.TYPED_FOOTAGE -> joinRefusedTyped
                    JoinRefusal.TEARDOWN_MISMATCH -> joinRefusedTeardown
                    JoinRefusal.ALREADY_ATTACHED -> joinRefusedAlready
                    JoinRefusal.AT_ANOTHER_POINT -> joinRefusedElsewhere
                    JoinRefusal.NOT_FOUND -> joinRefusedGone
                    JoinRefusal.NO_STORAGE -> joinRefusedNoStorage
                    JoinRefusal.TOO_FAR_APART -> joinTooFarTemplate.format(
                        FeetInches.formatCompact(viewModel.joinTooFarFeet.value)
                    )
                },
                duration = SnackbarDuration.Long
            )
        }
    }
```

**EDIT 4 — offer the corner after a point is DRAGGED, and the standing offer itself.** ANCHOR:
```
    // Leaving the tool puts down anything half-attached: a lifted end that
    // survived a trip through Draw would attach itself to whatever was tapped
    // next, which is the thing he must never have happen.
    LaunchedEffect(mode) {
        if (mode != SurveyMode.JOIN) viewModel.clearJoinPick()
    }
```
REPLACEMENT:
```
    // Leaving the tool puts down anything half-attached: a lifted end that
    // survived a trip through Draw would attach itself to whatever was tapped
    // next, which is the thing he must never have happen.
    LaunchedEffect(mode) {
        if (mode != SurveyMode.JOIN) viewModel.clearJoinPick()
    }

    // "THESE TWO SIDES MEET HERE. MAKE IT ONE POST?"
    //
    // A standing offer beside the drawing, never a dialog in front of the next
    // tap. He is in a yard, one-handed, and the next thing he does is almost
    // always another tap -- a question there costs a dismissal every time he
    // traces beside a neighbour's fence, and a question dismissed by reflex is
    // one that eventually gets answered by reflex.
    //
    // ONLY THE ACTION IS A YES. A snackbar that times out, is swiped away, or
    // is pushed off by the next one attaches nothing: SnackbarResult.Dismissed
    // falls through to dismissSnapJoinOffer. And the yes itself is re-derived
    // from the database before it writes (SurveyViewModel.acceptSnapJoinOffer),
    // so a tap that arrives late lands on today's drawing or on nothing.
    val snapJoinOffer by viewModel.snapJoinOffer.collectAsState()
    val snapJoinLine = stringResource(R.string.snap_join_offer_line)
    val snapJoinAction = stringResource(R.string.snap_join_offer_action)
    LaunchedEffect(snapJoinOffer) {
        if (snapJoinOffer == null) return@LaunchedEffect
        val result = snackbarHostState.showSnackbar(
            message = snapJoinLine,
            actionLabel = snapJoinAction,
            withDismissAction = true,
            duration = SnackbarDuration.Long
        )
        if (result == SnackbarResult.ActionPerformed) viewModel.acceptSnapJoinOffer()
        else viewModel.dismissSnapJoinOffer()
    }
    // A standing offer belongs to Draw and Adjust. Anywhere else it would be a
    // question about a gesture he has stopped making.
    LaunchedEffect(mode) {
        if (mode != SurveyMode.DRAW && mode != SurveyMode.ADJUST) viewModel.dismissSnapJoinOffer()
    }
```
*(If `SurveyMode` has no `ADJUST` member, drop that second `LaunchedEffect` — the drag lives in the same block as `draggingIndex`; name the real mode constant instead.)*

**EDIT 5 — offer the corner after a DRAG.** ANCHOR:
```
                                                            val snap = viewModel.snapForMove(idx, finalPoint, snapOn)
                                                            lastSnap = snap.takeIf { it.snapped }
                                                            viewModel.movePoint(idx, snap.point)
```
REPLACEMENT:
```
                                                            val snap = viewModel.snapForMove(idx, finalPoint, snapOn)
                                                            lastSnap = snap.takeIf { it.snapped }
                                                            viewModel.movePoint(idx, snap.point)
                                                            // Dragging an end
                                                            // onto another
                                                            // side's corner is
                                                            // the same event as
                                                            // drawing onto it,
                                                            // and it is how he
                                                            // closes a gap on
                                                            // purpose after a
                                                            // join was refused
                                                            // for being too far
                                                            // apart.
                                                            viewModel.offerJoinFromSnap(idx, snap.kind)
```

**EDIT 6 — the dialog tells the truth about the line moving.** ANCHOR:
```
                        // Open by more than half a foot: the attachment stands
                        // either way -- it is his decision and not the pixels'
                        // -- but a post he thinks is in one place and the crew
                        // will set in another is worth a sentence.
                        if (effect.gapFeet > 0.5f) {
                            Text(
                                stringResource(
                                    R.string.attach_gap,
                                    FeetInches.formatCompact(effect.gapFeet)
                                ),
                                color = warning
                            )
                        }
                    }
                }
```
REPLACEMENT:
```
                    }
                }
                // ATTACHED MEANS ONE POINT. His words on seeing the first
                // version: "When I attach them together, I need to see the line
                // move there too so there is no confusion." So the dialog no
                // longer says the attachment moves neither end -- R.string
                // .attach_gap, which said exactly that, is retired here -- it
                // names the side that MOVES, how far, and what that does to its
                // footage, because footage is labour. A gap too wide to close
                // never reaches this dialog at all: tapJoinEnd refuses it as
                // TOO_FAR_APART.
                val closer = offer.gapCloser
                if (!offer.detach) {
                    if (closer == null) {
                        Text(stringResource(R.string.attach_already_together))
                    } else {
                        Text(
                            stringResource(
                                R.string.attach_moves,
                                joinRunName(runs, closer.end.runId),
                                FeetInches.formatCompact(closer.distanceFeet)
                            ),
                            color = warning
                        )
                        Text(
                            stringResource(
                                R.string.attach_moves_footage,
                                joinRunName(runs, closer.end.runId),
                                FeetInches.formatCompact(closer.runFeetBefore),
                                FeetInches.formatCompact(closer.runFeetAfter)
                            ),
                            color = warning
                        )
                    }
                } else {
                    // Detaching is the opposite of attaching about the POST,
                    // not about the drawing. Said before it happens rather
                    // than discovered afterwards.
                    Text(stringResource(R.string.attach_detach_keeps_drawing))
                }
```

Also add `import com.fenceestimator.app.geometry.JoinRefusal` only if not already present (it is), and nothing else. `FeetInches` and `joinRunName` are already in scope.

## TEST RESULT

```
tests/a80-snap-to-connect.test.mjs      PASS  89 passed, 0 failed
```

**Both canaries failed as required:**
- `9a-canary` — a version of `offerFromSnap` that writes the joint itself is caught by the no-joint-without-yes assertion (7b).
- `9b-canary` — a version that drags the corner itself is caught by the no-point-moves-without-yes assertion (7c).
- `9c` — the real `offerFromSnap`, on the same fixture, neither joins nor moves, and does not even offer, because the ends are 40 px apart rather than one point.

Positive controls throughout: `6b` (a good case offers), plus controls proving each negative refused for the *right* reason — `6a-control` (the tap really was off the corner), `6c-control`/`6d-control` (a heading and a whole-foot snap really did fire), `6e-control` (the two points really are identical), `6f-control` (the middle vertex really is on the corner), `6g-control` (the blocking joint really is live), `6h-control` (`decide` names TEARDOWN_MISMATCH), `8e-control` (`decide` itself allowed the 110 ft join, so TOO_FAR_APART is the new rule and not an old one), `1a-canary`, `3d-canary`, `4a-canary`, `5g-canary`.

Regression sweep, all green: `a57` (83 ok), `a59` (9/9), `a56`, `a33`×2, `a32-join-posts`, `a61`×2, `a26-join-door`, `a41`, `a29`, `a21`.

Two suites are red **and were red before this work**, for reasons in files I did not touch:
- `a65-run-selection-and-input-guards` — every failure is a `git show HEAD:` canary ("RED on pre-fix vm, as it must be") plus `9q3-canary` on `RunEditScreen`. HEAD now contains the fixes those canaries expect to be absent, so the canaries can only fail. Classic stale-canary; not mine.
- `a32-join-transition` — "Red on purpose: 3 case(s) wait for joining and the transition item. CONTESTED."

## UNVERIFIED, SAID AS UNVERIFIED

- **The Kotlin is unverified by compilation.** No Gradle was run. Risk points I could not check: `RunJoinGesture.SnapJoinOffer` / `JoinGapCloser` as nested data classes in an `object`; `offerJoinAfterDraw`'s expression body returning `Unit`; whether `SurveyMode` has an `ADJUST` member (used only in proposed Edit 4); whether `FeetInches.formatCompact` is the right formatter for a run's total footage as opposed to a side length.
- **The screen edits are not applied**, so nothing above is reachable from a phone yet, and the build will not compile until Edit 3 lands (exhaustive `when`).
- **Snackbar queueing behaviour is unverified by running the app.** If the refusal snackbar and the offer snackbar collide, Material 3 queues them; the offer's `SnackbarResult.Dismissed` path attaches nothing either way, so the failure mode is a missed offer, not an unasked-for join.
- **`CLOSE_GAP_MAX_FT = 2.0f` is a judgement, not a measurement.** I can defend it (shorter than the shortest panel, shorter than one post spacing) but he has not been asked, and the 110 ft live joint it would now refuse is one he presumably made deliberately. It is a refusal, so it cannot cost money silently — but it will stop a join he could previously make, and he should be told that.
- **The existing 110 ft live joint is untouched.** I applied no SQL. It is still billing one shared corner post for two ends 110 ft apart, on a job I did not identify further. Worth his decision: close the gap, or detach.
- **`attach_gap` becomes dead in all three locales** after Edit 6, and `supabase_a32_join_runs.sql` / the `RunJoinArithmetic` and `RunJoinGesture` header comments / `a59` check 2c all still describe the pre-flip world. None of that is load-bearing today, and none of it is this wave's file to fix.

===== ATTACK =====

No forbidden file touched; both mutated files restored byte-identically (md5 confirmed). Report below.

**VERDICT: do not ship as a unit. One blocker (an unasked line-move if the screen edits land partially), one stale-price race, two false premises in the report, and the suite cannot see an auto-join.**

## 1. SILENT JOIN / SILENT MOVE

**BLOCKER — `confirmJoinOffer` moves a corner, and the dialog on disk says it does not.** `SurveyViewModel.kt:1595` runs `offer.gapCloser?.let { moveJoinedEnd(it) }`. The only thing that makes that a yes is EDIT 6, which is unapplied — and EDIT 6 is the **only edit not required to compile** (EDIT 3 is). `SurveyDrawScreen.kt:2458` still renders `R.string.attach_gap`: *"These two ends are %1$s apart. Attaching them moves neither one; line them up with Adjust if they should meet."* Apply EDITs 1–5 and skip 6, or apply 3 alone to unbreak the build, and tapping Attach drags his corner up to 2 ft while the dialog promises in writing that nothing moves. **EDITs 1–6 are one atomic unit, or revert the `moveJoinedEnd` call.** `noteFootageChange` writes nothing on an owner's own phone (`editorName` is null), so the dialog is his only notice.

**No silent-join path found in the Kotlin.** I traced every route to `writeJointIds`: `confirmJoinOffer` (dialog), `acceptSnapJoinOffer` (snackbar action only), `freeJointsAtVanishedEnds` (blanks only). Specifically tested and all **safe**:
- Fast double tap on one corner → offer re-raised, re-derived, no write.
- Snackbar timeout / swipe / superseded → `Dismissed` → `dismissSnapJoinOffer`; a new offer cancels `LaunchedEffect`, and cancellation throws out of `showSnackbar` before the `ActionPerformed` branch.
- Offer surviving into the next drawn point → `offerJoinFromSnap` nulls synchronously at entry before any early return.

**But the safety is the re-derivation, not the clearing — and the comment claiming otherwise is wrong.** "The offer is dropped by the next drawing edit" (`SurveyViewModel.kt:1380`) is **false**. Five edits leave it standing: the nudge control (`SurveyDrawScreen.kt:1977`, calls `movePoint` with no snap and no `offerJoinFromSnap`), `setSegmentLengthFeet` (2032), `clearPoints` (2092), `toggleClosedLoop` (1949), `undoLast`/`redo` (1768/1778). Each is caught downstream by `acceptSnapJoinOffer`'s re-check that the two ends are still one point. So: harmless today, **and the comment invites the next author to delete the re-check as redundant.** Fix the comment or clear the offer in `editRun`.

**Minor:** `addDrawPoint` drops a non-finite point and returns (`:776`), but the screen calls `offerJoinAfterDraw` regardless; `LAST_POINT` then resolves to a pre-existing corner, so the offer can describe an end he did not just place. Needs a degenerate canvas transform. Re-derivation still gates the write.

## 2. FOOTAGE AND THE DOLLAR FIGURE — his real 0.80 ft corner

Probed read-only (control `2`, three canaries `0`): job dials are **$6.00/ft labour, $0 flat, $200 labour floor, 0% markup, 7% tax (materials only), 80 px/ft, 6 ft post spacing**.

The side that moves (both ends free → first-tapped) is the 72 ft run at `5995.1436:6499.2954 → 6000.3374:739.2977`:

| | before | after |
|---|---|---|
| run footage | **72.0000 ft** | **71.2024 ft** |
| bays `ceil(ft/6)` | 12 | **12** |

- Corner moves 63.8062 px ÷ 80 = **0.7976 ft (9.6 in)**, confirming the report's 0.80 ft.
- Labour: 0.7976 × $6 = **−$4.79**. Floor does not bite (job is ~196 ft → $1,176 raw). Markup 0%, labour untaxed. **Quote falls $4.79**, on top of the shared post.
- **No panel, post, cap or rail changes** — 72.0000 ft is exactly 12 bays and 71.20 still ceils to 12.

**But that is luck, and the dialog cannot say so.** `bays = ceil(netFt / postSpacingFt)` (`EstimateEngine.kt:794`); `railQty = bays × woodRailCount` (`:852`). At his own dials a **72.1 ft** side shortened 0.80 ft goes 13 bays → 12: **one line post, one post cap, and 2–3 wood rails come off.** `attach_moves_footage` says only *"so its labour follows"* — materials are never mentioned, and the `effect` block above it reports only the shared-post saving. **Was he told? Partially: feet yes, dollars no, vanishing bay no.**

## 3. THE WRONG END — a real gap

`offerFromSnap` (`FenceGeometry.kt:1424`) returns the **first qualifying partner in `sortedBy { it.runId }`**, and `runId` is a random UUID. Condition (3) only checks that *the candidate's* end is free, not that it is the **only** free end at that point. Reach it in four taps: draw side B's end onto side A's corner, **decline** the offer, draw side C's end onto the same corner. Two free ends now sit on one point; the offer names one of them **by UUID order, i.e. arbitrarily** — and `snap_join_offer_line` carries **no run names at all**, so he cannot see which. Accept and you get 1 corner post + 1 orphan end post at one physical spot: wrong price, wrong pair, no way to tell. The code comment asserts this case "is the T case (3) says a snap cannot resolve" — (3) does not resolve it, it just picks. **Either refuse when ≥2 free ends are coincident, or name the side in the offer string.**

Scoping is sound: `repository.getFenceRuns(jobId)` excludes other jobs and deleted runs; `decide` re-checks membership.

## 4. UNDO — one backwards case

- **Joint left on a vanished point: fixed.** `freeJointsAtVanishedEnds` compares stored first/last by exact coordinates and blanks through `writeJointIds`. Fails toward one post *more*. Good.
- **BUG, new: undo of a drag frees a joint whose corner came back.** `undoLast` (`:936–944`) passes `before = run` (dragged) and `after = restored` (original). Drag a joined end away, tap Undo: the corner returns **exactly to where the joint was made**, the comparison sees first/last changed, and the joint is destroyed. The price silently rises by a post for restoring the geometry that justified it, with no message.
- **Asymmetry:** the forward actions do not clear. Dragging a joined end keeps the joint at any distance; **extending** a joined end silently migrates the joint to the new last point (`JoinEnd` names the end, not the index). So **the 110-ft-joint class is not closed** — `TOO_FAR_APART` only blocks *creating* one through Attach. Only `JointMarker.openByFeet > 0.5f` amber ring (`SurveyDrawScreen.kt:1648`) shows the drift; no text, no refusal.
- **Detach:** does not restore the point and says so (`attach_detach_keeps_drawing`). Correct and stated.

## 5. THE TWO PATHS — agree

Attach closes the gap and says which side moves; the snap offer moves nothing because the snap already made it one point (`acceptSnapJoinOffer` calls no `movePoint`/`writePoints`/`moveJoinedEnd` — check `1n`, and I confirmed it has teeth). `attach_already_together` vs `attach_moves` covers the difference. Guest gate is symmetric (`viewerIsGuestDemo` on both). Crew: both paths equally ungated for the joint write — unchanged, not weakened.

## 6. DOES THE PRICE FOLLOW — yes, with a race

- **Established, not taken:** `pricingSignature` (`TakeoffRefresher.kt:103`) is `run.copy(...)` subtracting only id/syncId/jobId/label/sortOrder/buildTemplateSyncId/updatedAt, so `startJoint`/`endJoint` **are** in it. The watcher fires on a joint write. No manual Suggest needed. Office engine also reads them: `price-job` `JOIN_COLUMNS_LIVE = true`, joints in `RUN_COLUMNS`.
- **RACE, new:** `moveJoinedEnd` → `editRun` → `viewModelScope.launch{...}`, fire-and-forget; `repriceEveryRun()` runs on the **next line** of the already-running coroutine and wins. So every run is priced against **pre-move** geometry, then the watcher re-prices **only the moved run**. `RunJoinArithmetic.kindOf` reads *both* members' headings (`turnDegrees`, threshold **15°**), so the shared post's **owner — if it is the run that did not move — keeps a CORNER-vs-LINE decision made from the old angle**, in its own stored line items, with no further refresh. A 0.8 ft move on a short last segment shifts that heading by tens of degrees. **Fix: make `moveJoinedEnd` suspend and await it before `repriceEveryRun()`.**
- `repriceEveryRun` keeps `repriceOnDrawingChange`, `viewerMayReprice()`, `CrashReporter`, `_repriceFailed`. `repriceAfterScaleChange` delegates. Confirmed.

## 7. DOES THE TEST HAVE TEETH — **no, for the one failure that must not ship**

Mutated the real files on disk, ran, restored, proved byte-identical (`cmp` → identical; md5 `459258bc…` / `cd8e3b54…`).

| mutation | a80 | a57 |
|---|---|---|
| **A — auto-join.** One line in `offerJoinFromSnap`: `if (_snapJoinOffer.value != null) acceptSnapJoinOffer()` | **PASS 89/0** | **83 ok, 0 FAIL** |
| **B — auto-move** via `moveJoinedEnd` in `acceptSnapJoinOffer` | **FAIL, 1n** | — |
| **B2 — auto-move** writing points straight through `repository.updateFenceRun` | **PASS 89/0** | — |

**Mutation A is the exact scenario the brief said must not ship — every snap-landed point joins itself, a post leaves the bill with no yes — and all 172 checks are green.** The suite's canaries (`9a`/`9b`) mutate the test's own *transcription*, never the Kotlin, so they prove the model has teeth, not the code. `1n` catches a move only by the three names it greps (`movePoint`, `writePoints`, `moveJoinedEnd`); B2 walks past it. **Needed: a static assertion that `offerJoinFromSnap`'s body does not call `acceptSnapJoinOffer`/`writeJointIds`, and that `acceptSnapJoinOffer` contains no `updateFenceRun`.**

## 8. FILE DISCIPLINE — clean

`git diff SurveyDrawScreen.kt` is **empty**. `quote.html` is modified, but its diff is the a79 house-anchor/3D-preview wave (`mapNote`, `posFromHouse`, `scenePlanRun`) — not this one. Strings are in `res/values*/strings_join_offer.xml`, not `strings.xml`. All six anchors `grep -cF` = 1. `SurveyMode.ADJUST` exists, so EDIT 4's second effect is valid. `FeetInches.formatCompact(Float)` and `joinRunName` are both in scope.

**Display-text assertions do exist:** a80 `5e` matches `/post, its cap and its concrete/` and `5f` matches `/drag the end over/i` against the English XML. A reword by him turns these red — the "canary made of content someone else may edit" class that cost 31 minutes of a Ledger build.

## REPORT CLAIMS: CONFIRMED / REFUTED

**CONFIRMED:** snap collects across runs and returns the existing corner object (so exact equality is right); only the placed point moves; coincident-no-joint still bills two end posts; all three gates true (`JOIN_STORAGE_READY`, `JOIN_PRICING_READY`, `EntitySync.JOIN_COLUMNS_LIVE = true`); `adjust` groups by id and reads position only for `turnDegrees`; joints are in `pricingSignature`; the real gap is **0.80 ft**, not 0.6; `a65`'s 18 failures are all pre-existing `git show HEAD:` stale canaries; `a32-join-transition` red on purpose; the header comments in `FenceGeometry.kt:765+` ("NO PRICE HAS MOVED YET", "no run anywhere carries a joint id") and `writeJointIds`' own doc ("start_joint / end_joint do not exist in Postgres yet… JOIN_COLUMNS_LIVE is false") are **false**; `a59` check `2c` passes while asserting "the Postgres half… is still unapplied" — it pins a premise the database refutes; `attach_gap` is now a lie.

**REFUTED — the report's headline evidence:**
1. **"110.63 ft"** — the gap is 4425.3534 px ÷ **80** px/ft (the stored calibration; the report used 79.75) = **55.3 ft**. Even at 79.75 the report's own division gives 55.5, not 110.63. Off by 2×.
2. **"It is live… both members open, not teardown"** — **both of its runs are soft-deleted.** Probed: 6 jointed rows, **3 live and 3 `deleted_at is not null`**, 4 distinct joint ids. Both engines filter `deleted_at is null`, so that joint is never loaded and **bills nothing**. The report read the rows without the filter the engines apply and called it "the strongest possible case for Part B."
3. **"Three live joints"** — there are **two**: gaps **0.00 ft** and **0.7976 ft**. A fourth id (`beecb464`) is an orphan on one deleted end.

Nothing in production is mispriced by distance today. `TOO_FAR_APART` is still the right rule — the 55 ft joint *was* created by the Attach path, which proves the path could do it — but the justification as written would not survive him checking it.

## WHAT I FIXED MYSELF

Nothing. Rules 4 and 1 forbid committing and forbid `SurveyDrawScreen.kt`, and the two live defects (the `moveJoinedEnd` await, the undo-restores-then-frees comparison) are in `SurveyViewModel.kt`, which the orchestrator is mid-wave on. Both are small:
- `private suspend fun moveJoinedEnd(...)` taking the fresh run itself, awaited before `repriceEveryRun()`.
- In `freeJointsAtVanishedEnds`, compare the restored end against the point the joint was **made** at, not against the pre-undo point — which needs the joint's own anchor stored, or else accept that undo frees it and say so in a message.
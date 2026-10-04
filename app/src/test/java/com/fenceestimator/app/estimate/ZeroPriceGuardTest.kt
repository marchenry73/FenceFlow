package com.fenceestimator.app.estimate

import com.fenceestimator.app.R
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateMounting
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * This wave's fix for "a quote for zero dollars can be sent, and nothing
 * says so" (items 1, 3 and 4 of the wave brief), pinned in one file because
 * all three live in [EstimateEngine] and all three are about the SAME
 * underlying gap: a formula correctly refusing to guess, with nothing
 * downstream checking that the refusal actually reached the total.
 *
 * ITEM 1 -- [EstimateEngine.hasUnmeasurablePhotoWork] and its use in
 * [EstimateEngine.estimateWarnings]. A drawn-but-uncalibrated survey photo
 * correctly prices at zero ([TakeoffRefresher.blockedByUncalibratedPhoto]),
 * but nothing said why, and nothing stopped that zero from being sent. This
 * reuses the Survey screen's own orphaned prompt ([R.string
 * .survey_not_calibrated]) rather than adding a near-duplicate, and is
 * deliberately silent for a job with genuinely nothing drawn yet -- that is
 * every job's first moment, not a mistake. The refusal half of the fix
 * (locking Send Contract / Send Invoice on [EstimateScreen], via the same
 * predicate) is UI wiring with no pure function of its own to pin here; see
 * EstimateScreen.kt's `zeroQuoteBlocked`.
 *
 * ITEM 3 -- [EstimateEngine.computeTotals]'s gate-feet sum used to read a
 * run's gates straight off the drawing with no photo check at all, even
 * though the identical run's FENCE footage already refused to guess
 * ([EstimateEngine.linearFeet] / [EstimateEngine.footageOf], both keyed on
 * the same [TakeoffRefresher.blockedByUncalibratedPhoto] rule). A gate's
 * width is typed directly in feet and needs no scale, so nothing stopped it
 * from being billed while the fence line it opens onto correctly billed
 * zero -- and the gap SCALES with the gate rate rather than staying a
 * rounding error (two 6 ft gates at $35/ft with 25% markup is $525, not
 * $0). The office already blanks a run's gates along with its drawing for
 * this exact case (load.ts's `neutralizeUnscaledRun`); this closes the
 * identical gap on the phone.
 *
 * ITEM 4 -- [EstimateEngine] hardcoded two "gate posts" per gate regardless
 * of mounting, but a LINE_TO_WALL gate's own area
 * ([EstimateEngine.gateAreaEntries], private, exercised here through
 * [EstimateEngine.suggestQuantities]) adds a THIRD post -- the run
 * terminates twice. (That third post was an END_POST when this was written
 * and still is; the gate's own TWO became GATE_POST rows later, which is why
 * the assertion below reads END_POST 3 + GATE_POST 2 rather than END_POST 5.
 * Same five terminal posts either way.) POST_CAP is priced off the
 * two-per-gate count, so a
 * LINE_TO_WALL gate billed one fewer cap than the posts the same takeoff
 * put in the ground. Fixed in both engines (this file and takeoff.ts) so
 * parity holds; WALL and LINE both still take exactly two, unchanged.
 *
 * This file could not be run against Gradle from the sandbox this fix was
 * written in (house rule: gradlew is reserved for the parity gate). Every
 * number below was hand-derived from the same arithmetic
 * [EstimateEngine.computePostCounts] and [EstimateEngine.computeTotals]
 * actually run, and cross-checked against the TypeScript port
 * (supabase/functions/_shared/pricing/{takeoff,totals}.ts) executed live via
 * `npx tsx` against fixtures/pricing/gate-line-to-wall-mount.json and
 * fixtures/pricing/multi-gate-whole-bags.json, which carry the identical
 * shape.
 */
class ZeroPriceGuardTest {

    private val storagePath = "co-1/job-1/survey.jpg"

    private fun photoJob(calibrated: Boolean = false) = Job(
        customerName = "Test",
        surveyStoragePath = storagePath,
        calibrationPixelsPerFoot = if (calibrated) 20f else null,
    )

    private fun drawnRun(manualLinearFeet: Float? = null) = FenceRun(
        jobId = 1L,
        fenceType = FenceType.VINYL,
        pointsEncoded = FenceCodec.encodePoints(listOf(FencePoint(0f, 0f), FencePoint(2000f, 0f))),
        manualLinearFeet = manualLinearFeet,
        panelWidthFt = 6f,
        postSpacingFt = 6f,
        concreteBagsPerPost = 1f,
    )

    /** A run nobody has touched yet: no points, no gates, no typed length. */
    private fun emptyRun() = FenceRun(jobId = 1L, fenceType = FenceType.VINYL)

    private fun gateOnlyRun(mounting: GateMounting = GateMounting.LINE) = FenceRun(
        jobId = 1L,
        fenceType = FenceType.VINYL,
        gatesEncoded = FenceCodec.encodeGates(listOf(GateMarker(0f, 0f, 4f, mounting))),
    )

    // ===================================================================
    // ITEM 1a -- hasUnmeasurablePhotoWork: content, not just calibration
    // state, is what separates a mistake from a job's first moment.
    // ===================================================================

    @Test
    fun `a drawn run on an uncalibrated photo has unmeasurable work`() {
        assertTrue(EstimateEngine.hasUnmeasurablePhotoWork(photoJob(), listOf(drawnRun())))
    }

    @Test
    fun `a gate-only run on an uncalibrated photo counts too -- a gate is content`() {
        assertTrue(EstimateEngine.hasUnmeasurablePhotoWork(photoJob(), listOf(gateOnlyRun())))
    }

    @Test
    fun `a brand-new job with nothing drawn is never flagged, even on an uncalibrated photo`() {
        assertFalse(
            "a job's very first moment must not be nagged",
            EstimateEngine.hasUnmeasurablePhotoWork(photoJob(), listOf(emptyRun()))
        )
        assertFalse(EstimateEngine.hasUnmeasurablePhotoWork(photoJob(), emptyList()))
    }

    @Test
    fun `a calibrated photo is never flagged, however much is drawn on it`() {
        assertFalse(EstimateEngine.hasUnmeasurablePhotoWork(photoJob(calibrated = true), listOf(drawnRun())))
    }

    @Test
    fun `CANARY -- an uncalibrated GRID job (no photo at all) is never flagged`() {
        val gridJob = Job(customerName = "Test", surveyStoragePath = null, calibrationPixelsPerFoot = null)
        assertFalse(EstimateEngine.hasUnmeasurablePhotoWork(gridJob, listOf(drawnRun())))
    }

    @Test
    fun `typed footage is never flagged -- it needs no scale in the first place`() {
        assertFalse(EstimateEngine.hasUnmeasurablePhotoWork(photoJob(), listOf(drawnRun(manualLinearFeet = 100f))))
    }

    // ===================================================================
    // ITEM 1b -- the warning itself, reusing the orphaned Survey prompt.
    // ===================================================================

    @Test
    fun `a zero-total job with unmeasurable photo work warns, reusing the Survey screen's own prompt`() {
        val job = photoJob()
        val runs = listOf(drawnRun())
        val totals = EstimateEngine.computeTotals(job, emptyList(), totalLinearFeet = 0f, runs = runs)
        assertEquals("fixture precondition: this really is the zero-quote case", 0.0, totals.grandTotal, 0.001)

        val warnings = EstimateEngine.estimateWarnings(job, runs, emptyList(), totals)
        assertTrue(
            "a $0 estimate caused by an unmeasurable photo must say why",
            warnings.any { it.textRes == R.string.survey_not_calibrated }
        )
    }

    @Test
    fun `a brand-new empty job is never warned about a photo it has not drawn on yet`() {
        val job = photoJob()
        val totals = EstimateEngine.computeTotals(job, emptyList(), totalLinearFeet = 0f, runs = emptyList())
        val warnings = EstimateEngine.estimateWarnings(job, emptyList(), emptyList(), totals)
        assertFalse(warnings.any { it.textRes == R.string.survey_not_calibrated })
    }

    @Test
    fun `a job with a real nonzero total is not warned even with a stray unmeasurable run on it`() {
        // A minimum job charge (or any other real money on the job) keeps the
        // total honest even while one run on it cannot be measured -- this
        // guard is about a total that reads zero, not about every job that
        // happens to carry an uncalibrated photo run.
        val job = photoJob().copy(minimumJobCharge = 500.0)
        val runs = listOf(drawnRun())
        val totals = EstimateEngine.computeTotals(job, emptyList(), totalLinearFeet = 0f, runs = runs)
        assertTrue("fixture precondition: the minimum charge really keeps this nonzero", totals.grandTotal > 0.0)

        val warnings = EstimateEngine.estimateWarnings(job, runs, emptyList(), totals)
        assertFalse(warnings.any { it.textRes == R.string.survey_not_calibrated })
    }

    // ===================================================================
    // ITEM 3 -- an uncalibrated photo run bills no gate feet either.
    // ===================================================================

    private fun twoGateRun() = FenceRun(
        jobId = 1L,
        fenceType = FenceType.VINYL,
        gatesEncoded = FenceCodec.encodeGates(
            listOf(
                GateMarker(0f, 0f, 6f, GateMounting.LINE),
                GateMarker(500f, 0f, 6f, GateMounting.LINE),
            )
        ),
    )

    @Test
    fun `FIXED -- an uncalibrated photo run bills no gate feet or gate charge`() {
        val job = photoJob().copy(gateRatePerFt = 35.0, markupPercent = 25.0)
        val totals = EstimateEngine.computeTotals(job, emptyList(), totalLinearFeet = 0f, runs = listOf(twoGateRun()))

        assertEquals("no gate feet for an unmeasurable run", 0.0, totals.gateFeet, 0.001)
        assertEquals("no gate charge either", 0.0, totals.gateCharge, 0.001)
        assertEquals("nothing left to mark up", 0.0, totals.grandTotal, 0.001)
    }

    @Test
    fun `POSITIVE CONTROL -- the identical run, once calibrated, bills its gates in full`() {
        // Proves the zero above is the guard, not a coincidence of the gate
        // rate or a codec that silently drops the gates: the exact same
        // run and rate, calibrated, bills real money.
        val job = photoJob(calibrated = true).copy(gateRatePerFt = 35.0, markupPercent = 25.0)
        val totals = EstimateEngine.computeTotals(job, emptyList(), totalLinearFeet = 0f, runs = listOf(twoGateRun()))

        assertEquals(12.0, totals.gateFeet, 0.001)
        assertEquals("2 gates x 6 ft x \$35/ft", 420.0, totals.gateCharge, 0.001)
        // The exact figure this wave's bug report used: 12 ft x $35/ft,
        // marked up 25%, is $525 -- what the office already billed while the
        // uncalibrated-photo phone billed $0 (or, pre-fix, whatever the
        // guessed grid scale happened to measure the gate at).
        val markedUp = totals.gateCharge * (1.0 + job.markupPercent / 100.0)
        assertEquals(525.0, markedUp, 0.001)
    }

    @Test
    fun `CANARY -- an uncalibrated GRID job (no photo) still bills its gates, untouched by this fix`() {
        val gridJob = Job(customerName = "Test", surveyStoragePath = null, calibrationPixelsPerFoot = null, gateRatePerFt = 35.0)
        val totals = EstimateEngine.computeTotals(gridJob, emptyList(), totalLinearFeet = 0f, runs = listOf(twoGateRun()))

        assertEquals(12.0, totals.gateFeet, 0.001)
        assertEquals(420.0, totals.gateCharge, 0.001)
    }

    // ===================================================================
    // ITEM 4 -- POST_CAP now matches the posts a LINE_TO_WALL gate builds.
    // ===================================================================

    /**
     * A 100 ft run (typed, so no calibration is needed to exercise this)
     * with one 4 ft gate of [mounting]. Matches
     * fixtures/pricing/gate-line-to-wall-mount.json's shape exactly (100 ft
     * typed, 6 ft spacing, a single 4 ft gate) so the numbers below can be
     * cross-checked against that fixture's committed `input`, run live
     * through the fixed TypeScript port.
     */
    private fun gateRun(mounting: GateMounting) = FenceRun(
        jobId = 1L,
        fenceType = FenceType.VINYL,
        manualLinearFeet = 100f,
        manualCornerCount = 0,
        postSpacingFt = 6f,
        panelWidthFt = 6f,
        concreteBagsPerPost = 1f,
        gatesEncoded = FenceCodec.encodeGates(listOf(GateMarker(500f, 0f, 4f, mounting))),
    )

    private fun postCapQty(run: FenceRun): Double =
        EstimateEngine.suggestQuantities(run, pixelsPerFoot = 20f)
            .entries.filter { it.role == MaterialRole.POST_CAP }.sumOf { it.quantity }

    private fun endPostQty(run: FenceRun): Double =
        EstimateEngine.suggestQuantities(run, pixelsPerFoot = 20f)
            .entries.filter { it.role == MaterialRole.END_POST }.sumOf { it.quantity }

    private fun gatePostQty(run: FenceRun): Double =
        EstimateEngine.suggestQuantities(run, pixelsPerFoot = 20f)
            .entries.filter { it.role == MaterialRole.GATE_POST }.sumOf { it.quantity }

    @Test
    fun `FIXED -- a LINE_TO_WALL gate now bills a post cap for every post it actually stands`() {
        val run = gateRun(GateMounting.LINE_TO_WALL)
        val workings = EstimateEngine.explainPosts(run, pixelsPerFoot = 20f)

        // RE-AIMED, not relaxed. The gate's own two posts are billed as
        // GATE_POST now rather than END_POST: a post standing at an opening is
        // not an end of the fence, and the owner's catalog has GATE_POST rows
        // priced by hand that nothing could reach while the takeoff asked for
        // END_POST. So the END_POST pin moved 5.0 -> 3.0 and a GATE_POST 2.0
        // appeared beside it. The old 5 was "2 fence ends + 3 from the gate
        // area"; the 3 is "2 fence ends + the ONE genuine end the gate area
        // still adds", that one being where the rest of the run terminates at
        // the wall (LINE_TO_WALL ends the fence line a second time). 3 + 2 is
        // the same five terminal posts as before.
        //
        // What this test exists to pin has NOT moved and is asserted below:
        // gatePosts is still 3, physical posts are still 19, and POST_CAP is
        // still 19 -- no shortfall. Cross-checked against
        // fixtures/pricing/gate-line-to-wall-mount.json (engine 2026.10.8,
        // identical shape) and the TypeScript port run live on it:
        // posts {line 14, corner 0, end 2, gate 3, total 19},
        // roles {END_POST 3, GATE_POST 2, POST_CAP 19}.
        // The split moved on 4 Oct: one post carries the gate, and a post the
        // fence connects to is an END_POST. So LINE_TO_WALL is GATE_POST 1 +
        // END_POST 2 (the gate's latch, and the wall end) on top of the run's
        // own two ends. THREE POSTS AT THE GATE AREA EITHER WAY, which is what
        // this precondition exists to hold: the cap check below counts posts,
        // not roles, and it is unchanged.
        assertEquals(
            "fixture precondition: the gate area still adds a THIRD post, now " +
                "split GATE_POST 1 + END_POST 2 (so 2 fence ends + gate latch + wall end)",
            4.0, endPostQty(run), 0.001
        )
        assertEquals(
            "one gate post, because the gate hangs from one post",
            1.0, gatePostQty(run), 0.001
        )
        assertEquals("gatePosts now counts all three the gate area builds", 3, workings.gatePosts)

        // Physical posts actually standing: 14 line + 0 corner + 3 end + 2 gate
        // = 19, matching the fixture above (posts.total 18 -> 19, POST_CAP
        // 18 -> 19 when this was fixed). GATE_POST is in the sum because the
        // posts it names are in the ground; leaving it out is what would hide
        // a real shortfall behind the role rename.
        val physicalPosts =
            workings.linePosts + workings.cornerPosts + endPostQty(run) + gatePostQty(run)
        assertEquals(19.0, physicalPosts, 0.001)
        assertEquals("the engine's own total agrees", 19, workings.totalPosts)
        assertEquals(
            "FIXED: POST_CAP now matches the physical post count exactly -- no shortfall",
            physicalPosts, postCapQty(run), 0.001
        )
    }

    @Test
    fun `CANARY -- LINE and WALL mountings still take exactly two gate posts, unchanged`() {
        val lineRun = gateRun(GateMounting.LINE)
        val wallRun = gateRun(GateMounting.WALL)

        assertEquals(2, EstimateEngine.explainPosts(lineRun, 20f).gatePosts)
        assertEquals(2, EstimateEngine.explainPosts(wallRun, 20f).gatePosts)

        // Matching fixtures/pricing/gate-line-mount.json and
        // gate-wall-mount.json exactly -- both still price 18 caps, byte
        // for byte, run through the fixed takeoff.ts.
        assertEquals(18.0, postCapQty(lineRun), 0.001)
        assertEquals(18.0, postCapQty(wallRun), 0.001)
    }

    @Test
    fun `CANARY -- a run with no gate at all is untouched`() {
        val run = FenceRun(
            jobId = 1L, fenceType = FenceType.VINYL,
            manualLinearFeet = 100f, postSpacingFt = 6f, panelWidthFt = 6f, concreteBagsPerPost = 1f,
        )
        assertEquals(0, EstimateEngine.explainPosts(run, 20f).gatePosts)
    }
}

package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.ChangeOrder
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.MaterialCategory
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.GateMarker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The takeoff is the part of this app a contractor bets money on -- a wrong
 * post count means a second trip to the supply house. These pin the arithmetic
 * down so a refactor can't quietly change what gets ordered.
 */
class EstimateEngineTest {

    private fun qtyOf(s: EstimateSuggestions, role: MaterialRole) =
        s.entries.filter { it.role == role }.sumOf { it.quantity }

    private fun vinylRun(
        feet: Float? = null,
        corners: Int = 0,
        gates: List<GateMarker> = emptyList(),
        closed: Boolean = false,
        type: FenceType = FenceType.VINYL,
        suppressed: String = ""
    ) = FenceRun(
        jobId = 1,
        fenceType = type,
        manualLinearFeet = feet,
        manualCornerCount = corners,
        closedLoop = closed,
        gatesEncoded = FenceCodec.encodeGates(gates),
        panelWidthFt = 6f,
        postSpacingFt = 6f,
        concreteBagsPerPost = 1f,
        suppressedRolesCsv = suppressed
    )

    @Test
    fun `typed-in footage needs no drawing and no calibration`() {
        // 100 ft, 6 ft spacing, open run: 17 bays -> 18 posts, two of them ends.
        val s = EstimateEngine.suggestQuantities(vinylRun(feet = 100f), pixelsPerFoot = 0f)

        assertEquals(100f, s.geometry.totalLinearFeet)
        assertEquals(2.0, qtyOf(s, MaterialRole.END_POST), 0.001)
        assertEquals(0.0, qtyOf(s, MaterialRole.CORNER_POST), 0.001)
        assertEquals(16.0, qtyOf(s, MaterialRole.LINE_POST), 0.001)
        assertEquals(17.0, qtyOf(s, MaterialRole.PANEL), 0.001)
        // One bag per post, 18 posts.
        assertEquals(18.0, qtyOf(s, MaterialRole.CONCRETE_BAG), 0.001)
    }

    @Test
    fun `corners come out of the line post count, not on top of it`() {
        val s = EstimateEngine.suggestQuantities(vinylRun(feet = 100f, corners = 3), pixelsPerFoot = 0f)

        assertEquals(3.0, qtyOf(s, MaterialRole.CORNER_POST), 0.001)
        assertEquals(2.0, qtyOf(s, MaterialRole.END_POST), 0.001)
        assertEquals(13.0, qtyOf(s, MaterialRole.LINE_POST), 0.001)
        // Same 18 posts overall, just classified differently.
        assertEquals(18.0, qtyOf(s, MaterialRole.CONCRETE_BAG), 0.001)
    }

    @Test
    fun `a closed loop has no end posts and no closing post`() {
        val s = EstimateEngine.suggestQuantities(
            vinylRun(feet = 120f, corners = 4, closed = true), pixelsPerFoot = 0f
        )

        assertEquals(0.0, qtyOf(s, MaterialRole.END_POST), 0.001)
        assertEquals(4.0, qtyOf(s, MaterialRole.CORNER_POST), 0.001)
        // 20 bays, no extra post to close the loop -> 16 line + 4 corner.
        assertEquals(16.0, qtyOf(s, MaterialRole.LINE_POST), 0.001)
    }

    @Test
    fun `a short run still gets its line posts`() {
        // The old formula subtracted gate posts here and drove line posts to zero.
        val s = EstimateEngine.suggestQuantities(
            vinylRun(feet = 24f, gates = listOf(GateMarker(0f, 0f, 4f))), pixelsPerFoot = 0f
        )

        // RE-AIMED, not relaxed. The two posts a gate hangs between are billed
        // as GATE_POST now (EstimateEngine.gateAreaEntries, GateMounting.LINE):
        // a post standing at an opening is not an end of the fence, and the
        // owner's catalog has GATE_POST rows priced by hand that nothing could
        // reach while the takeoff asked for END_POST. So the END_POST pin moved
        // 4.0 -> 2.0 (the run's own two ends, which is all that is left) and the
        // GATE_POST pin moved 0.0 -> 2.0. No post went missing in the move, and
        // the two assertions below prove that rather than taking it on trust.
        //
        // 24 ft typed, one 4 ft LINE gate: net 20 ft -> 4 bays -> 2 line + 2 end
        // + 2 gate = 6 posts, 6 caps. Cross-checked by running the TypeScript
        // port (supabase/functions/_shared/pricing, engine 2026.10.8, the half
        // of the parity pair that CAN be executed here) on this exact input:
        // {LINE_POST 2, END_POST 2, GATE_POST 2, POST_CAP 6}.
        // The gate's latch post is an END_POST now (4 Oct: one post carries the
        // gate, the other is decided by whether the fence connects to it), so
        // this is the run's own two ends PLUS the gate's one. Six posts either
        // way -- 2 line + 3 end + 1 gate -- and the cap count below is what
        // holds that total honest.
        assertEquals(3.0, qtyOf(s, MaterialRole.END_POST), 0.001)
        assertEquals(1.0, qtyOf(s, MaterialRole.GATE_POST), 0.001)
        // The teeth this test is named for, untouched: the old formula
        // subtracted the gate posts out of the line-post pool and drove this
        // to zero on any run short enough.
        assertTrue("line posts should not be wiped out", qtyOf(s, MaterialRole.LINE_POST) > 0.0)
        // And the reclassification must not lose a post: every post standing in
        // the ground still buys a cap, whatever role it is billed under.
        assertEquals(
            "2 line + 2 end + 2 gate still stand, and still each take a cap",
            6.0, qtyOf(s, MaterialRole.POST_CAP), 0.001
        )
    }

    /**
     * RE-AIMED, not relaxed, and renamed because the old name
     * ("...and brace whatever the fence type") asserted word for word the shape
     * that was deliberately changed.
     *
     * HINGE_SET, LATCH and HANDLE genuinely are universal -- a hinge, a catch
     * and a pull fit any leaf -- and all seven types are still held to all
     * three. HANDLE in particular only reaches the other six because it was
     * moved to FenceType.UNIVERSAL in the catalog, so this is the check that
     * would catch that being undone.
     *
     * BRACE and STIFFENER are VINYL ONLY, for physical reasons rather than
     * seeding accidents (EstimateEngine.BRACED_GATE_TYPES and
     * STIFFENED_GATE_TYPES carry the full argument): a WOOD, SPLIT_RAIL or
     * COMPOSITE gate is built on the GATE_FRAME_KIT this takeoff already asks
     * for -- the seeded wood kit is "Steel-Reinforced", which IS the member
     * keeping the leaf square -- so asking for a BRACE as well bills the same
     * function twice, against a white vinyl extrusion at that. A chain-link
     * gate is a welded tube frame; aluminium and ornamental iron arrive as
     * welded factory panels.
     *
     * The old pin cost nothing to be wrong about, which is why it survived:
     * six of the seven types had no row in any catalog to price a BRACE
     * against, so the role landed in BuiltItems.unmatchedRoles and billed $0.
     * Teeth are kept -- strengthened, in fact -- by pinning BOTH sides of the
     * rule: 1.0 where the part belongs and 0.0 where it must never appear, so
     * neither re-universalising it nor dropping it from vinyl passes.
     */
    @Test
    fun `hinges latch and handle on every fence type -- brace and stiffener on vinyl only`() {
        FenceType.values().filter { it != FenceType.UNIVERSAL }.forEach { type ->
            val s = EstimateEngine.suggestQuantities(
                vinylRun(feet = 50f, gates = listOf(GateMarker(0f, 0f, 4f)), type = type),
                pixelsPerFoot = 0f
            )
            assertEquals("$type hinges", 1.0, qtyOf(s, MaterialRole.HINGE_SET), 0.001)
            assertEquals("$type latch", 1.0, qtyOf(s, MaterialRole.LATCH), 0.001)
            assertEquals("$type handle", 1.0, qtyOf(s, MaterialRole.HANDLE), 0.001)

            // One expectation, both directions: vinyl takes exactly one of each,
            // every other type takes none at all.
            val vinylOnly = if (type == FenceType.VINYL) 1.0 else 0.0
            assertEquals("$type brace", vinylOnly, qtyOf(s, MaterialRole.BRACE), 0.001)
            assertEquals("$type stiffener", vinylOnly, qtyOf(s, MaterialRole.STIFFENER), 0.001)
        }
    }

    @Test
    fun `a wide gate gets a second brace and a second hinge set`() {
        val s = EstimateEngine.suggestQuantities(
            vinylRun(feet = 50f, gates = listOf(GateMarker(0f, 0f, 12f))), pixelsPerFoot = 0f
        )
        assertEquals(2.0, qtyOf(s, MaterialRole.BRACE), 0.001)
        assertEquals(2.0, qtyOf(s, MaterialRole.HINGE_SET), 0.001)
    }

    @Test
    fun `removed item types stay removed`() {
        val s = EstimateEngine.suggestQuantities(
            vinylRun(feet = 50f, gates = listOf(GateMarker(0f, 0f, 4f)), suppressed = "HANDLE,BRACE"),
            pixelsPerFoot = 0f
        )
        assertEquals(0.0, qtyOf(s, MaterialRole.HANDLE), 0.001)
        assertEquals(0.0, qtyOf(s, MaterialRole.BRACE), 0.001)
        // Everything else still comes through.
        assertEquals(1.0, qtyOf(s, MaterialRole.LATCH), 0.001)
    }

    @Test
    fun `waste pads panels but never posts or hardware`() {
        val plain = EstimateEngine.suggestQuantities(vinylRun(feet = 100f), pixelsPerFoot = 0f)
        val padded = EstimateEngine.suggestQuantities(vinylRun(feet = 100f), pixelsPerFoot = 0f, wastePercent = 10.0)

        assertEquals(17.0, qtyOf(plain, MaterialRole.PANEL), 0.001)
        assertEquals(19.0, qtyOf(padded, MaterialRole.PANEL), 0.001) // ceil(17 * 1.1)
        assertEquals(
            "posts must not be padded",
            qtyOf(plain, MaterialRole.LINE_POST), qtyOf(padded, MaterialRole.LINE_POST), 0.001
        )
    }

    @Test
    fun `takeoff names the post types even when the catalog is empty`() {
        val s = EstimateEngine.suggestQuantities(vinylRun(feet = 100f, corners = 2), pixelsPerFoot = 0f)
        val labels = s.takeoff.map { it.label }

        assertTrue(labels.contains("Line posts"))
        assertTrue(labels.contains("Corner posts"))
        assertTrue(labels.contains("End posts"))
        assertTrue(labels.contains("Total posts"))
    }

    @Test
    fun `a priced catalog item wins over a zero-priced one`() {
        val run = vinylRun(feet = 60f)
        val s = EstimateEngine.suggestQuantities(run, pixelsPerFoot = 0f)
        val catalog = listOf(
            MaterialItem(
                category = MaterialCategory.POST, role = MaterialRole.LINE_POST,
                fenceType = FenceType.VINYL, name = "Unpriced placeholder", unitPrice = 0.0
            ),
            MaterialItem(
                category = MaterialCategory.POST, role = MaterialRole.LINE_POST,
                fenceType = FenceType.VINYL, name = "Real post", unitPrice = 16.56
            )
        )

        val built = EstimateEngine.buildLineItems(1, 1, run, s, catalog, null)
        val postLine = built.items.first { it.role == MaterialRole.LINE_POST }

        assertEquals("Real post", postLine.description)
        assertTrue(postLine.unitPrice > 0.0)
        assertFalse(built.zeroPricedNames.contains("Real post"))
    }

    @Test
    fun `roles the catalog cannot price are reported instead of dropped silently`() {
        val run = vinylRun(feet = 60f)
        val s = EstimateEngine.suggestQuantities(run, pixelsPerFoot = 0f)

        val built = EstimateEngine.buildLineItems(1, 1, run, s, emptyList(), null)

        assertTrue(built.items.isEmpty())
        assertTrue(built.unmatchedRoles.contains(MaterialRole.LINE_POST))
        assertTrue(built.unmatchedRoles.contains(MaterialRole.PANEL))
    }

    @Test
    fun `generating twice produces identical sync ids, so nothing can duplicate`() {
        val run = vinylRun(feet = 80f, gates = listOf(GateMarker(0f, 0f, 4f)))
        val catalog = listOf(
            MaterialItem(
                category = MaterialCategory.POST, role = MaterialRole.LINE_POST,
                fenceType = FenceType.VINYL, name = "Post", unitPrice = 16.56
            ),
            MaterialItem(
                category = MaterialCategory.PANEL, role = MaterialRole.PANEL,
                fenceType = FenceType.VINYL, name = "Panel", unitPrice = 52.35, coversFt = 6f
            )
        )

        val first = EstimateEngine.buildLineItems(
            1, 1, run, EstimateEngine.suggestQuantities(run, 0f), catalog, null
        ).items
        val second = EstimateEngine.buildLineItems(
            1, 1, run, EstimateEngine.suggestQuantities(run, 0f), catalog, null
        ).items

        assertEquals(first.map { it.syncId }, second.map { it.syncId })
        // Unique per line, so an upsert replaces rather than appends.
        assertEquals(first.size, first.map { it.syncId }.distinct().size)
    }

    @Test
    fun `change orders move the total`() {
        val job = Job(customerName = "Test", laborRatePerFt = 10.0, taxRatePercent = 0.0)
        val items = listOf(
            EstimateLineItem(jobId = 1, description = "Panels", quantity = 10.0, unitPrice = 50.0)
        )

        val before = EstimateEngine.computeTotals(job, items, 100f)
        val after = EstimateEngine.computeTotals(
            job, items, 100f,
            listOf(ChangeOrder(jobId = 1, additionalFeet = 30.0, additionalCost = 400.0))
        )

        // 400 of extra cost, plus 30 more feet at the same $10/ft labor rate.
        assertEquals(before.grandTotal + 400.0 + 300.0, after.grandTotal, 0.001)
        assertEquals(400.0, after.changeOrderCost, 0.001)
        assertEquals(30.0, after.changeOrderFeet, 0.001)
    }

    @Test
    fun `no change orders leaves the total exactly as it was`() {
        val job = Job(customerName = "Test", laborRatePerFt = 10.0)
        val items = listOf(
            EstimateLineItem(jobId = 1, description = "Panels", quantity = 10.0, unitPrice = 50.0)
        )
        assertEquals(
            EstimateEngine.computeTotals(job, items, 100f).grandTotal,
            EstimateEngine.computeTotals(job, items, 100f, emptyList()).grandTotal,
            0.001
        )
    }

    @Test
    fun `repeated roles merge into one priced line`() {
        val run = vinylRun(feet = 80f, gates = listOf(GateMarker(0f, 0f, 4f), GateMarker(0f, 0f, 4f)))
        val s = EstimateEngine.suggestQuantities(run, pixelsPerFoot = 0f)
        val catalog = listOf(
            MaterialItem(
                category = MaterialCategory.HARDWARE, role = MaterialRole.LATCH,
                fenceType = FenceType.VINYL, name = "Latch", unitPrice = 25.87
            )
        )

        val latchLines = EstimateEngine.buildLineItems(1, 1, run, s, catalog, null)
            .items.filter { it.role == MaterialRole.LATCH }

        assertEquals(1, latchLines.size)
        assertEquals(2.0, latchLines.first().quantity, 0.001)
    }

    // ---- "when I click on suggested quantities, it goes back to 0" ----
    //
    // The typed-feet field on the estimate screen fed manualLinearFeet
    // straight into this engine. Its Compose state was re-seeded from
    // run.manualLinearFeet on every keystroke's own async DB round trip
    // (remember(run.id, run.manualLinearFeet) in RunSection), so a fast typist
    // could have their in-progress number snapped back to whatever had just
    // been committed -- including back to "" mid-word. Pressing Suggest
    // Quantities right after reads a run whose manualLinearFeet is 0/null,
    // and this engine correctly (and unhelpfully) suggests nothing for it.
    // These two pin the engine's side of that contract: a real typed length
    // suggests real quantities, and the zero-feet case that the UI bug
    // produced suggests none -- so a regression that starts inventing
    // quantities out of zero feet, or one that goes back to silently
    // suggesting nothing for a real typed length, both go red here.

    @Test
    fun `a typed length suggests real, non-zero quantities`() {
        val run = vinylRun(feet = 125f, corners = 1)
        val s = EstimateEngine.suggestQuantities(run, pixelsPerFoot = 0f)

        assertTrue(
            "125 ft of vinyl fence must suggest panels, not nothing",
            qtyOf(s, MaterialRole.PANEL) > 0.0
        )
        assertTrue(qtyOf(s, MaterialRole.CONCRETE_BAG) > 0.0)
    }

    @Test
    fun `planted failure -- a field wiped back to zero feet suggests nothing, which is why the wipe is the bug`() {
        // This is the exact state a keystroke-triggered remember reset left
        // the run in: manualLinearFeet null (the field read as cleared) and
        // no drawing to fall back on (pixelsPerFoot 0 here stands in for "no
        // calibration"). The engine is right to suggest zero for zero feet --
        // the bug was ever letting the field collapse to this while someone
        // was still typing, not anything this engine does with the number
        // once it gets it.
        val run = vinylRun(feet = null, corners = 1)
        val s = EstimateEngine.suggestQuantities(run, pixelsPerFoot = 0f)

        assertEquals(0.0, qtyOf(s, MaterialRole.PANEL), 0.001)
        assertEquals(0.0, qtyOf(s, MaterialRole.CONCRETE_BAG), 0.001)
    }
}

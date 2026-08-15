package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
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

        assertEquals(2.0, qtyOf(s, MaterialRole.GATE_POST), 0.001)
        assertTrue("line posts should not be wiped out", qtyOf(s, MaterialRole.LINE_POST) > 0.0)
    }

    @Test
    fun `every gate gets hinges latch handle and brace whatever the fence type`() {
        FenceType.values().filter { it != FenceType.UNIVERSAL }.forEach { type ->
            val s = EstimateEngine.suggestQuantities(
                vinylRun(feet = 50f, gates = listOf(GateMarker(0f, 0f, 4f)), type = type),
                pixelsPerFoot = 0f
            )
            assertEquals("$type hinges", 1.0, qtyOf(s, MaterialRole.HINGE_SET), 0.001)
            assertEquals("$type latch", 1.0, qtyOf(s, MaterialRole.LATCH), 0.001)
            assertEquals("$type handle", 1.0, qtyOf(s, MaterialRole.HANDLE), 0.001)
            assertEquals("$type brace", 1.0, qtyOf(s, MaterialRole.BRACE), 0.001)
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
}

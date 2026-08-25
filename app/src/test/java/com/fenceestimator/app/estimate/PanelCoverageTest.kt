package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.MaterialCategory
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateMounting
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Enough panel to build the fence, and one line per thing being bought.
 *
 * The count used to be worked out at the width the run was spec'd for while
 * the item was picked separately as the nearest width the catalog stocked,
 * with nothing reconciling the two -- so a 100 ft run spec'd at 8 ft panels
 * ordered thirteen 6 ft panels, 78 ft of fence, and the shortfall was found
 * on the day with the crew standing there.
 */
class PanelCoverageTest {

    private fun panel(name: String, covers: Float, price: Double) = MaterialItem(
        name = name, category = MaterialCategory.PANEL, role = MaterialRole.PANEL,
        fenceType = FenceType.VINYL, unit = "each", unitPrice = price,
        coversFt = covers, isActive = true
    )

    private fun run(specWidth: Float, feet: Float) = FenceRun(
        jobId = 1, fenceType = FenceType.VINYL, manualLinearFeet = feet,
        panelWidthFt = specWidth, postSpacingFt = specWidth
    )

    private fun panelsFor(specWidth: Float, feet: Float, catalog: List<MaterialItem>): Double {
        val r = run(specWidth, feet)
        val built = EstimateEngine.buildLineItems(
            jobId = 1, fenceRunId = 1, run = r,
            suggestions = EstimateEngine.suggestQuantities(r, pixelsPerFoot = 20f),
            catalog = catalog, preferredManufacturerId = null
        )
        return built.items.filter { it.role == MaterialRole.PANEL }.sumOf { it.quantity }
    }

    @Test
    fun `a wider spec than the catalog stocks still buys enough panel`() {
        // Spec'd at 8 ft; only a 6 ft panel exists. 100 ft needs 17 of them.
        val panels = panelsFor(8f, 100f, listOf(panel("6ft", 6f, 54.50)))
        assertEquals(17.0, panels, 0.001)
    }

    @Test
    fun `a narrower spec than the catalog stocks does not over-order`() {
        // Spec'd at 4 ft against a 6 ft panel: 100 ft is 17 panels, not 25.
        val panels = panelsFor(4f, 100f, listOf(panel("6ft", 6f, 54.50)))
        assertEquals(17.0, panels, 0.001)
    }

    @Test
    fun `when the catalog has the spec'd width nothing changes`() {
        val catalog = listOf(panel("6ft", 6f, 54.50), panel("8ft", 8f, 68.00))
        assertEquals(13.0, panelsFor(8f, 100f, catalog), 0.001)
        assertEquals(17.0, panelsFor(6f, 100f, catalog), 0.001)
    }

    @Test
    fun `two gates of different widths get different line item ids`() {
        // Both are GATE_PANEL, so they used to hash to one id -- and two rows
        // sharing a primary key fail the upsert as a batch, taking every other
        // line item on the job down with them.
        val r = FenceRun(
            jobId = 1, fenceType = FenceType.VINYL, manualLinearFeet = 100f,
            panelWidthFt = 6f, postSpacingFt = 6f,
            pointsEncoded = FenceCodec.encodePoints(
                listOf(
                    com.fenceestimator.app.geometry.FencePoint(0f, 0f),
                    com.fenceestimator.app.geometry.FencePoint(2000f, 0f)
                )
            ),
            gatesEncoded = FenceCodec.encodeGates(
                listOf(
                    GateMarker(400f, 0f, 4f, GateMounting.LINE),
                    GateMarker(1200f, 0f, 6f, GateMounting.LINE)
                )
            )
        )
        val built = EstimateEngine.buildLineItems(
            jobId = 1, fenceRunId = 1, run = r,
            suggestions = EstimateEngine.suggestQuantities(r, pixelsPerFoot = 20f),
            catalog = listOf(
                panel("6ft", 6f, 54.50),
                MaterialItem(
                    name = "Gate 4ft", category = MaterialCategory.GATE,
                    role = MaterialRole.GATE_PANEL, fenceType = FenceType.VINYL,
                    unit = "each", unitPrice = 210.0, coversFt = 4f, isActive = true
                ),
                MaterialItem(
                    name = "Gate 6ft", category = MaterialCategory.GATE,
                    role = MaterialRole.GATE_PANEL, fenceType = FenceType.VINYL,
                    unit = "each", unitPrice = 260.0, coversFt = 6f, isActive = true
                )
            ),
            preferredManufacturerId = null
        )
        val gateLines = built.items.filter { it.role == MaterialRole.GATE_PANEL }
        assertEquals("expected one line per gate width", 2, gateLines.size)
        assertNotEquals("gate lines must not share a sync id", gateLines[0].syncId, gateLines[1].syncId)
        // Every id on the job has to be distinct, or the push fails as a batch.
        assertEquals(built.items.size, built.items.map { it.syncId }.toSet().size)
    }
}

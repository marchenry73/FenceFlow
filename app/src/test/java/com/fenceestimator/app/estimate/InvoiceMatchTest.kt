package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.MaterialCategory
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.MaterialRole
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Importing a supplier invoice must not put a price on the wrong panel.
 *
 * The matcher dropped every one-character token, and the size of a panel is
 * exactly that: "Panel 6'H x 6'W - Gray" and "Panel 8'H x 8'W - Gray" both
 * reduced to PANEL, VINYL, PRIVACY, GRAY, word for word identical. Whichever
 * happened to be first in the catalog won, so importing an invoice could
 * write the 8 ft panel's price onto the 6 ft row -- and every estimate after
 * that quoted the wrong figure.
 */
class InvoiceMatchTest {

    private fun panel(name: String, price: Double) = MaterialItem(
        name = name, category = MaterialCategory.PANEL, role = MaterialRole.PANEL,
        fenceType = FenceType.VINYL, unit = "each", unitPrice = price,
        colorOrFinish = "Gray", isActive = true
    )

    private val catalog = listOf(
        panel("Panel T&G Vinyl Privacy 6'H x 6'W", 54.50),
        panel("Panel T&G Vinyl Privacy 8'H x 8'W", 71.00)
    )

    private fun matchFor(invoiceLine: String): MaterialItem? =
        InvoiceParser.matchAgainstCatalog(
            listOf(ParsedLineItem(invoiceLine, 10.0, 60.0, 600.0, false)),
            catalog
        ).single().existingMatch

    @Test
    fun `a six foot invoice line matches the six foot panel`() {
        assertEquals(
            "Panel T&G Vinyl Privacy 6'H x 6'W",
            matchFor("Panel T&G Vinyl Privacy 6'H x 6'W - Gray")?.name
        )
    }

    @Test
    fun `an eight foot invoice line matches the eight foot panel`() {
        assertEquals(
            "Panel T&G Vinyl Privacy 8'H x 8'W",
            matchFor("Panel T&G Vinyl Privacy 8'H x 8'W - Gray")?.name
        )
    }

    @Test
    fun `a supplier writing feet differently still finds the right panel`() {
        // Same product, the supplier's own wording.
        assertEquals(
            "Panel T&G Vinyl Privacy 6'H x 6'W",
            matchFor("VINYL PRIVACY PANEL 6FT X 6FT GRAY")?.name
        )
    }
}

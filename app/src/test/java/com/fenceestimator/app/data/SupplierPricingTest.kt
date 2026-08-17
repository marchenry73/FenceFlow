package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The catalog price is a guess; the supplier price is a fact.
 *
 * Keeping them apart is what lets the estimate admit it is provisional. A
 * contractor who signs a customer to a figure and then discovers the material
 * costs more has no way back, so the app has to be able to say which kind of
 * number it is showing.
 */
class SupplierPricingTest {

    private fun line(qty: Double, catalog: Double, quoted: Double? = null) = EstimateLineItem(
        jobId = 1,
        description = "6ft vinyl panel",
        quantity = qty,
        unitPrice = catalog,
        supplierUnitPrice = quoted
    )

    @Test
    fun `with no quote the catalog price is used`() {
        val item = line(qty = 10.0, catalog = 45.0)
        assertEquals(45.0, item.effectiveUnitPrice, 0.001)
        assertEquals(450.0, item.lineTotal, 0.001)
        assertFalse(item.isSupplierPriced)
    }

    @Test
    fun `a supplier quote replaces the catalog price`() {
        val item = line(qty = 10.0, catalog = 45.0, quoted = 52.75)
        assertEquals(52.75, item.effectiveUnitPrice, 0.001)
        assertEquals(527.50, item.lineTotal, 0.001)
        assertTrue(item.isSupplierPriced)
    }

    @Test
    fun `a quote of zero is a real quote, not a missing one`() {
        // Distinguishing these matters: "they did not quote it" and "it is free"
        // are different facts, and treating the first as the second is how a job
        // looks profitable until the invoice arrives.
        val free = line(qty = 4.0, catalog = 12.0, quoted = 0.0)
        assertTrue(free.isSupplierPriced)
        assertEquals(0.0, free.lineTotal, 0.001)

        val unquoted = line(qty = 4.0, catalog = 12.0, quoted = null)
        assertFalse(unquoted.isSupplierPriced)
        assertEquals(48.0, unquoted.lineTotal, 0.001)
    }

    @Test
    fun `the catalog price is kept, not overwritten`() {
        // So the two can be compared afterwards -- the difference between what
        // you quoted from and what it actually cost is the thing worth knowing.
        val item = line(qty = 1.0, catalog = 45.0, quoted = 60.0)
        assertEquals(45.0, item.unitPrice, 0.001)
        assertEquals(60.0, item.supplierUnitPrice!!, 0.001)
    }

    @Test
    fun `a job is only confirmed when every line has a real price`() {
        val items = listOf(
            line(qty = 1.0, catalog = 10.0, quoted = 11.0),
            line(qty = 1.0, catalog = 20.0, quoted = null)
        )
        // Half a quote is still a guess, and a guess that calls itself
        // confirmed is worse than one that admits it.
        assertFalse(items.all { it.isSupplierPriced })

        val allQuoted = items.map { it.copy(supplierUnitPrice = it.unitPrice) }
        assertTrue(allQuoted.all { it.isSupplierPriced })
    }

    @Test
    fun `the job total follows the supplier prices`() {
        val catalogOnly = listOf(line(10.0, 45.0), line(2.0, 30.0))
        assertEquals(510.0, catalogOnly.sumOf { it.lineTotal }, 0.001)

        val quoted = listOf(line(10.0, 45.0, 52.0), line(2.0, 30.0, 28.0))
        assertEquals(576.0, quoted.sumOf { it.lineTotal }, 0.001)
    }
}

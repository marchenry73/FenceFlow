package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A new company used to get FenceFlow's ninety-one items and five pricing
 * tiers inserted on first run, treated as if they were this company's real
 * numbers. That is now opt-in only, through "Copy FenceFlow's starting
 * list" (catalog) and "Copy FenceFlow's starting tiers" (settings). These
 * tests pin the policy so a future change to it is deliberate, not a
 * regression.
 */
class SeedDataOptInTest {

    @Test
    fun `a fresh install does not auto-seed material items`() {
        assertFalse(shouldAutoSeedMaterialItems(currentCount = 0))
    }

    @Test
    fun `a fresh install does not auto-seed pricing tiers`() {
        assertFalse(shouldAutoSeedPricingTiers(currentCount = 0))
    }

    @Test
    fun `auto-seed stays off even for a catalog that already has rows`() {
        // Guards against a lazy reading of the policy as "only until the
        // first item exists" -- it is off, full stop, regardless of count.
        assertFalse(shouldAutoSeedMaterialItems(currentCount = 5))
        assertFalse(shouldAutoSeedPricingTiers(currentCount = 5))
    }

    @Test
    fun `the opt-in catalog copy produces items flagged unverified`() {
        val items = SeedData.materialItems()
        assertTrue("opt-in copy should still offer a full starting catalog", items.size >= 90)
        assertTrue(
            "every item the opt-in action copies must still read as an unverified starting price",
            items.all { isPlaceholderPrice(it.sourceDoc) }
        )
    }

    @Test
    fun `pricing tiers carry real-looking numbers, which is why they are opt-in too`() {
        // There is no sourceDoc-style flag on a pricing tier, so unlike the
        // catalog there is no way to mark a copied tier "unverified" -- the
        // whole reason it needs its own opt-in gate rather than shipping by
        // default. This is a canary: if a future tier ever ships at all
        // zeroes, it stops being a value worth gating and this test should
        // be revisited alongside the seeding policy.
        val tiers = SeedData.pricingTiers()
        assertEquals(5, tiers.size)
        assertTrue(
            "expected every starting tier to carry a real labor rate or markup",
            tiers.all { it.laborRatePerFt > 0.0 || it.markupPercent > 0.0 }
        )
    }
}

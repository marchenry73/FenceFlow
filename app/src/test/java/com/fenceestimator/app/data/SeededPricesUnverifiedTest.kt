package com.fenceestimator.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Sixteen seeded items used to ship marked as coming from a real supplier
 * quote. That was true for exactly one company -- the one whose supplier wrote
 * it. Every other company received a stranger's negotiated price already
 * wearing a "verified" label, so it slipped past the unverified-price check
 * and could be quoted off without anyone looking at it.
 */
class SeededPricesUnverifiedTest {

    @Test
    fun `every seeded price is flagged unverified`() {
        val items = SeedData.materialItems()
        assertTrue("seed catalog should not be empty", items.isNotEmpty())

        val trusted = items.filterNot { isPlaceholderPrice(it.sourceDoc) }
        assertTrue(
            "these seeded prices claim to be verified: " +
                trusted.joinToString { "${it.name} (${it.sourceDoc})" },
            trusted.isEmpty(),
        )
    }

    /**
     * The canary. If the predicate ever starts answering true for everything,
     * the test above passes for the wrong reason and a genuinely checked price
     * gets re-flagged underneath the company that checked it.
     */
    @Test
    fun `a price a company checked is not flagged`() {
        assertFalse(isPlaceholderPrice("From a real supplier quote"))
        assertFalse(isPlaceholderPrice("FloriFence estimate 17407"))
        assertFalse(isPlaceholderPrice(""))
    }

    @Test
    fun `catalogs seeded by older builds still answer the same way`() {
        assertTrue(isPlaceholderPrice("Placeholder — verify with your supplier"))
    }
}

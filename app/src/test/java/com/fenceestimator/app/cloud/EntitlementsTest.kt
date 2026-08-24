package com.fenceestimator.app.cloud

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What each plan includes, pinned.
 *
 * These are the lines a customer's money buys, so a rename or a tidy-up that
 * quietly hands Solo the whole product -- or takes the reports away from a
 * company paying $349 for them -- must fail here rather than in front of a
 * paying contractor. The blank case matters just as much: companies granted
 * access by hand were never sold a seat count, and must never lose features
 * because no plan label was written next to their name.
 */
class EntitlementsTest {

    @Test
    fun `solo gets estimating, not the crew and money features`() {
        val solo = Entitlements.of("Solo")
        assertFalse(solo.timeAndCrew)
        assertFalse(solo.pipeline)
        assertFalse(solo.reports)
        assertFalse(solo.cardPayments)
        assertFalse(solo.advancedReports)
        assertFalse(solo.digest)
    }

    @Test
    fun `crew runs the operation but does not read the business`() {
        val crew = Entitlements.of("Crew")
        assertTrue(crew.timeAndCrew)
        assertTrue(crew.pipeline)
        assertTrue(crew.reports)
        assertTrue(crew.cardPayments)
        // The money intelligence is what Pro is sold on.
        assertFalse(crew.advancedReports)
        assertFalse(crew.digest)
    }

    @Test
    fun `pro gets everything`() {
        val pro = Entitlements.of("Pro")
        assertTrue(pro.timeAndCrew)
        assertTrue(pro.pipeline)
        assertTrue(pro.reports)
        assertTrue(pro.cardPayments)
        assertTrue(pro.advancedReports)
        assertTrue(pro.digest)
    }

    @Test
    fun `a company with no plan label keeps full access`() {
        // Granted by hand, before plans existed. Taking features away from
        // these companies would be a silent downgrade of a working customer.
        listOf("", "   ", "granted", "legacy").forEach { label ->
            val e = Entitlements.of(label)
            assertTrue("plan '$label' lost features", e.advancedReports && e.timeAndCrew && e.digest)
        }
    }

    @Test
    fun `plan names are matched whatever their casing`() {
        // Stripe metadata, the website and the admin page have each written
        // this field; none of them agree on capitalisation.
        listOf("solo", "SOLO", "Solo", "sOlO").forEach {
            assertFalse("'$it' should be Solo", Entitlements.of(it).timeAndCrew)
        }
        listOf("crew", "CREW", "Crew").forEach {
            assertTrue("'$it' should run the crew", Entitlements.of(it).timeAndCrew)
            assertFalse("'$it' should not read the business", Entitlements.of(it).advancedReports)
        }
    }
}

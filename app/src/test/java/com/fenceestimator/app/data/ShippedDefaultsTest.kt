package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The two things FenceFlow ships that a company is meant to replace before
 * it sells anything: the contract's right-to-cancel wording, and eighty-one
 * catalog prices that are market guesses rather than quotes.
 *
 * Both were already labelled in the data and shown to nobody. These pin the
 * tests the product now uses to warn, so that a future edit to the shipped
 * text cannot quietly switch the warnings off.
 */
class ShippedDefaultsTest {

    @Test
    fun `every shipped contract still carries the block an attorney must replace`() {
        // If this fails because the wording was finally filled in, delete the
        // assertion rather than the warning -- and check all three languages,
        // because a contract is only as good as the one that was signed.
        listOf(DEFAULT_CONTRACT_TERMS, DEFAULT_CONTRACT_TERMS_ES, DEFAULT_CONTRACT_TERMS_FR)
            .forEach { terms ->
                assertTrue(
                    "a shipped contract lost its replace-me marker, so the app will stop " +
                        "warning about the missing cancellation notice",
                    contractTermsNeedLegalReview(terms)
                )
            }
    }

    @Test
    fun `terms an owner has actually filled in raise no warning`() {
        val filled = DEFAULT_CONTRACT_TERMS.replace(
            "YOUR RIGHT TO CANCEL -- [REPLACE THIS BLOCK BEFORE USING THIS CONTRACT]",
            "YOUR RIGHT TO CANCEL: you may cancel this transaction within three business days."
        )
        assertFalse(contractTermsNeedLegalReview(filled))
    }

    @Test
    fun `an owner who edited everything except the cancellation block is still warned`() {
        // The looser isDefaultContractTerms test says "not the default" here
        // and would have let this through; the warning has to survive an
        // owner rewriting the warranty and leaving the legal block alone.
        val partlyEdited = DEFAULT_CONTRACT_TERMS.replace("WARRANTY", "OUR PROMISE TO YOU")
        assertFalse("premise: this is no longer the shipped default", isDefaultContractTerms(partlyEdited))
        assertTrue(contractTermsNeedLegalReview(partlyEdited))
    }

    @Test
    fun `most seeded prices are placeholders and the catalog can say how many`() {
        val items = SeedData.materialItems()
        val placeholders = items.count { isPlaceholderPrice(it.sourceDoc) }
        val priced = items.count { it.unitPrice > 0.0 && isPlaceholderPrice(it.sourceDoc) }

        // Not an exact count -- the catalog is meant to grow. What must stay
        // true is that the majority are unverified and that the app can tell,
        // because that is what the warning counts.
        assertTrue("no seeded item is marked as a placeholder any more", placeholders > 0)
        assertTrue(
            "fewer than half the seeded prices are placeholders now; if real supplier " +
                "pricing landed, say so here rather than leaving a stale expectation",
            placeholders > items.size / 2
        )
        assertEquals(
            "a placeholder with no price would be counted by the unpriced warning instead",
            placeholders, priced
        )
    }

    @Test
    fun `a price a company typed itself is not a placeholder`() {
        assertFalse(isPlaceholderPrice(""))
        assertFalse(isPlaceholderPrice("Imported"))
        assertFalse(isPlaceholderPrice("From a real supplier quote"))
    }
}

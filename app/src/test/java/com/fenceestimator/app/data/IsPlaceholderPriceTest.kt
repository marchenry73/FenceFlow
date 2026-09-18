package com.fenceestimator.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Imported catalog rows used to be stamped `sourceDoc = "Imported"`, a label
 * [isPlaceholderPrice] did not match -- so a number OCR'd off a supplier PDF
 * was treated as confirmed the instant it landed. This locks the fix: an
 * imported price counts as unverified until the explicit "Confirm price"
 * action stamps [CONFIRMED].
 */
class IsPlaceholderPriceTest {

    @Test
    fun `seeded and placeholder prices are unverified`() {
        assertTrue(isPlaceholderPrice(SEEDED))
        assertTrue(isPlaceholderPrice(PLACEHOLDER))
    }

    @Test
    fun `an imported price is unverified until confirmed`() {
        assertTrue(isPlaceholderPrice(IMPORTED_UNVERIFIED))
    }

    @Test
    fun `a confirmed price is not a placeholder`() {
        assertFalse(isPlaceholderPrice(CONFIRMED))
    }

    // Planted-failure case: the old bare "Imported" label must NOT be treated
    // as verified just because it doesn't match any known constant -- if
    // someone reintroduces that literal instead of IMPORTED_UNVERIFIED, this
    // test does not catch it directly, but confirms the predicate rejects an
    // arbitrary unrecognized label as verified (it must return false, i.e.
    // "not a known placeholder", to prove the check is exact rather than
    // matching everything).
    @Test
    fun `an arbitrary source doc is not treated as a placeholder`() {
        assertFalse(isPlaceholderPrice("Some Supplier Invoice #123"))
    }
}

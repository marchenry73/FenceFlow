package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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

    // ---- the office importer's label ---------------------------------------
    //
    // website/dashboard.html writes source_doc = "Imported <U+2014> check this
    // one" on every price-list line it adds. That is not one of the three
    // labels above, so those rows used to pass this check as if somebody had
    // confirmed them. The tests below build every string from code points,
    // never from a typed dash: a hyphen or an en dash would compare unequal to
    // the stored label, and a test written with one would pass for the wrong
    // reason.

    private val emDash = 0x2014.toChar().toString()

    @Test
    fun `the shared dash is exactly one em dash`() {
        assertEquals(1, LABEL_DASH.length)
        assertEquals(0x2014, LABEL_DASH[0].code)
    }

    @Test
    fun `every label carries one dash and it is the em dash`() {
        val dashLike = setOf(0x2D, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212)
        listOf(SEEDED, PLACEHOLDER, IMPORTED_UNVERIFIED, IMPORTED_CHECK_FILING).forEach { label ->
            val found = label.filter { it.code in dashLike }.map { it.code }
            assertEquals("dash-like characters in \"$label\"", listOf(0x2014), found)
        }
    }

    @Test
    fun `the office importer label is spelled from code points`() {
        assertEquals("Imported " + emDash + " check this one", IMPORTED_CHECK_FILING)
    }

    @Test
    fun `a row the office price-list importer wrote is unverified`() {
        assertTrue(isPlaceholderPrice(IMPORTED_CHECK_FILING))
        assertTrue(isPlaceholderPrice("Imported " + emDash + " check this one"))
    }

    @Test
    fun `a label extended after the importer wrote it still counts`() {
        assertTrue(isPlaceholderPrice(IMPORTED_CHECK_FILING + " (filed as a gate panel)"))
    }

    // Teeth: a hyphen (U+002D) and an en dash (U+2013) are the two characters
    // a person types or pastes in place of U+2014. Neither is the stored label.
    @Test
    fun `a hyphen or an en dash in place of the em dash is a different string`() {
        assertFalse(isPlaceholderPrice("Imported " + 0x2D.toChar() + " check this one"))
        assertFalse(isPlaceholderPrice("Imported " + 0x2013.toChar() + " check this one"))
    }

    @Test
    fun `only the whole label counts`() {
        assertFalse(isPlaceholderPrice("Imported " + emDash + " check"))
        assertFalse(isPlaceholderPrice("Imported " + emDash))
        assertFalse(isPlaceholderPrice("check this one"))
    }

    // The two imported labels stay two kinds. Merging them would let the
    // office's supplier-list confirm clear a filing concern it cannot check,
    // and would erase which of the two a row is.
    @Test
    fun `the two imported labels are different and neither contains the other`() {
        assertNotEquals(IMPORTED_UNVERIFIED, IMPORTED_CHECK_FILING)
        assertFalse(IMPORTED_UNVERIFIED.startsWith(IMPORTED_CHECK_FILING))
        assertFalse(IMPORTED_CHECK_FILING.startsWith(IMPORTED_UNVERIFIED))
        assertTrue(isPlaceholderPrice(IMPORTED_UNVERIFIED))
        assertTrue(isPlaceholderPrice(IMPORTED_CHECK_FILING))
    }

    @Test
    fun `the retired bare Imported label is still not matched`() {
        assertFalse(isPlaceholderPrice("Imported"))
    }
}

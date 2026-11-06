package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The phone's Cash App link must agree with the one the CUSTOMER already gets
 * on the quote page (website/quote.html's cashAppLink). Two surfaces that
 * disagree about where money goes is the class of defect this codebase keeps
 * finding, so the cases below are the quote page's own rules, restated.
 */
class CashAppLinkTest {

    @Test
    fun `an ordinary tag and amount`() {
        assertEquals("https://cash.app/\$MarcFence/1234.56", CashApp.link("MarcFence", 1234.56))
    }

    @Test
    fun `a leading dollar is accepted and not doubled`() {
        // People type the tag the way they see it written.
        assertEquals("https://cash.app/\$MarcFence/10.00", CashApp.link("\$MarcFence", 10.0))
    }

    @Test
    fun `whitespace around a pasted tag is trimmed`() {
        assertEquals("https://cash.app/\$MarcFence/10.00", CashApp.link("  MarcFence \n", 10.0))
    }

    @Test
    fun `always two decimals`() {
        assertEquals("https://cash.app/\$a/5.00", CashApp.link("a", 5.0))
        assertEquals("https://cash.app/\$a/5.10", CashApp.link("a", 5.1))
        // Rounded, not truncated, and not left as float dust.
        assertEquals("https://cash.app/\$a/5.13", CashApp.link("a", 5.125 + 0.001))
    }

    // ---- NULL rather than a broken link ----------------------------------
    // quote.html's reason, which is the same here: "A link that opens Cash App
    // on a 404 is worse than the copyable text it replaced: the customer thinks
    // they have paid the wrong person."

    @Test
    fun `no tag, no link`() {
        assertNull(CashApp.link(null, 10.0))
        assertNull(CashApp.link("", 10.0))
        assertNull(CashApp.link("   ", 10.0))
        assertNull(CashApp.link("\$", 10.0))
    }

    @Test
    fun `a tag that is not a tag gives no link`() {
        assertNull(CashApp.link("marc fence", 10.0))      // a space
        assertNull(CashApp.link("marc@fence", 10.0))      // an address, not a tag
        assertNull(CashApp.link("marc.fence", 10.0))      // a dot: fine to DISPLAY, not to route money
        assertNull(CashApp.link("marc-fence", 10.0))      // same for a dash
        assertNull(CashApp.link("a".repeat(21), 10.0))    // too long
        assertNull(CashApp.link("../evil", 10.0))         // path traversal in a URL
        assertNull(CashApp.link("a/b", 10.0))             // a second path segment
    }

    @Test
    fun `the stricter of the two rules in the codebase is the one used`() {
        // payment-methods.ts accepts [A-Za-z0-9_.-]{1,30} for DISPLAY. Showing
        // somebody their own tag back, dots and all, is harmless; building a
        // payment URL out of it is not. These two would pass the display rule
        // and must fail here.
        assertNull(CashApp.link("marc.fence", 1.0))
        assertNull(CashApp.link("a".repeat(25), 1.0))
    }

    // ---- the amount ------------------------------------------------------

    @Test
    fun `no amount still opens the right person's Cash App`() {
        // Omitted, NOT zeroed: a URL ending in /0.00 asks for nothing. The
        // contractor types the figure instead, against the right tag.
        assertEquals("https://cash.app/\$a", CashApp.link("a", null))
        assertEquals("https://cash.app/\$a", CashApp.link("a", 0.0))
        assertEquals("https://cash.app/\$a", CashApp.link("a", -50.0))
        assertEquals("https://cash.app/\$a", CashApp.link("a", 0.004))
    }

    @Test
    fun `a nonsense amount does not produce a nonsense URL`() {
        assertEquals("https://cash.app/\$a", CashApp.link("a", Double.NaN))
        assertEquals("https://cash.app/\$a", CashApp.link("a", Double.POSITIVE_INFINITY))
    }

    @Test
    fun `the amount never carries a comma, whatever the phone's locale`() {
        // A phone set to French formats 1234.56 as "1234,56", and a comma in a
        // URL path is not an amount Cash App reads. This is why link() names
        // Locale.US explicitly rather than taking the default.
        val was = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.FRANCE)
            assertEquals("https://cash.app/\$a/1234.56", CashApp.link("a", 1234.56))
        } finally {
            java.util.Locale.setDefault(was)
        }
    }
}

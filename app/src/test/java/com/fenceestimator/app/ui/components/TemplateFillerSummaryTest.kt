package com.fenceestimator.app.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The HOA letter naming EVERY side, not the first one.
 *
 * It filled {height}, {fenceType} and {material} from runs.firstOrNull(), so a
 * job with a 6 ft back fence and a 4 ft side fence told the association 6 ft.
 * The letter is the document the association approves against, which makes the
 * side it left out the one that comes back as a violation. Already wrong for
 * any multi-side job; now the normal case, because splitting a side for a
 * different height is exactly how a job comes to have two of them.
 *
 * It also printed "6.0" where a letter says "6".
 */
class TemplateFillerSummaryTest {

    @Test
    fun `a measurement reads the way a letter writes it`() {
        assertEquals("6", TemplateFiller.feetWord(6f))
        assertEquals("4", TemplateFiller.feetWord(4f))
        // Half a foot is a real spec and must survive.
        assertEquals("4.5", TemplateFiller.feetWord(4.5f))
        // A measured length is never exact; 5.999 ft is five foot eleven and
        // seven eighths, which a letter calls 6.
        assertEquals("6", TemplateFiller.feetWord(5.999f))
        // Nothing to say rather than "0" or "NaN".
        assertEquals("", TemplateFiller.feetWord(0f))
        assertEquals("", TemplateFiller.feetWord(-3f))
        assertEquals("", TemplateFiller.feetWord(Float.NaN))
        assertEquals("", TemplateFiller.feetWord(Float.POSITIVE_INFINITY))
    }

    @Test
    fun `several values read as a phrase, in the caller's language`() {
        assertEquals("", TemplateFiller.phrase(emptyList(), "and"))
        assertEquals("Vinyl", TemplateFiller.phrase(listOf("Vinyl"), "and"))
        assertEquals("Vinyl and Wood", TemplateFiller.phrase(listOf("Vinyl", "Wood"), "and"))
        assertEquals(
            "Vinyl, Wood and Chain Link",
            TemplateFiller.phrase(listOf("Vinyl", "Wood", "Chain Link"), "and")
        )
        // THE JOINING WORD IS THE CALLER'S. A hardcoded " and " in a French
        // letter is what a customer notices and the author never does.
        assertEquals("Vinyle et Bois", TemplateFiller.phrase(listOf("Vinyle", "Bois"), "et"))
    }

    @Test
    fun `the same thing on four sides is said once`() {
        // Four vinyl sides is "Vinyl", not "Vinyl, Vinyl, Vinyl and Vinyl".
        assertEquals(
            "Vinyl",
            TemplateFiller.phrase(listOf("Vinyl", "Vinyl", "Vinyl", "Vinyl"), "and")
        )
        // And a side with no colour set does not become an empty item in the list.
        assertEquals("White", TemplateFiller.phrase(listOf("White", "", "   "), "and"))
    }

    @Test
    fun `every height on the job, in order, each with its unit`() {
        assertEquals("6 ft", TemplateFiller.heightPhrase(listOf(6f), "and", "ft"))
        // THE CASE THE SPLIT CREATES. Sorted, so the same job always produces
        // the same sentence whatever order the sides came back in.
        assertEquals("4 ft and 6 ft", TemplateFiller.heightPhrase(listOf(6f, 4f), "and", "ft"))
        assertEquals("4 ft and 6 ft", TemplateFiller.heightPhrase(listOf(4f, 6f), "and", "ft"))
        assertEquals(
            "4 ft, 5 ft and 6 ft",
            TemplateFiller.heightPhrase(listOf(6f, 4f, 5f, 6f), "and", "ft")
        )
        assertEquals("4 pies y 6 pies", TemplateFiller.heightPhrase(listOf(6f, 4f), "y", "pies"))
        // A job with nothing usable says nothing, rather than "0 ft".
        assertEquals("", TemplateFiller.heightPhrase(listOf(0f, Float.NaN), "and", "ft"))
        assertEquals("", TemplateFiller.heightPhrase(emptyList(), "and", "ft"))
    }

    @Test
    fun `the template still substitutes every placeholder`() {
        val filled = TemplateFiller.fillHoaTemplate(
            template = "At {address}: {fenceType}, {height}, {material}. -- {businessName}, {phone}",
            address = "12 Oak St",
            fenceType = "Vinyl and Wood",
            height = "4 ft and 6 ft",
            material = "White",
            businessName = "Acme Fence",
            phone = "555-0100",
        )
        assertEquals(
            "At 12 Oak St: Vinyl and Wood, 4 ft and 6 ft, White. -- Acme Fence, 555-0100",
            filled
        )
    }

    @Test
    fun `POSITIVE CONTROL -- the old one-side answer is not what these produce`() {
        // Every check above would also pass against a helper that simply
        // returned its first item. Asserted directly, because that IS the
        // defect being fixed.
        assertNotEquals("6 ft", TemplateFiller.heightPhrase(listOf(6f, 4f), "and", "ft"))
        assertNotEquals("Vinyl", TemplateFiller.phrase(listOf("Vinyl", "Wood"), "and"))
        // And "6.0" is not an answer this code can give.
        assertNotEquals("6.0", TemplateFiller.feetWord(6f))
    }
}

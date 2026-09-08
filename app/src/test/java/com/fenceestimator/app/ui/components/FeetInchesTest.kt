package com.fenceestimator.app.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The drawing tool's length field. A person in a truck should be able to
 * type what the tape says, in whatever punctuation comes out, and get the
 * number they meant.
 */
class FeetInchesTest {

    private fun assertFeet(expected: Float, raw: String) {
        val got = FeetInches.parse(raw)
            ?: throw AssertionError("\"$raw\" was refused; it should read as $expected ft")
        assertEquals("\"$raw\"", expected.toDouble(), got.toDouble(), 0.0005)
    }

    @Test
    fun `every punctuation a person actually types for 47 feet 6`() {
        listOf("47' 6\"", "47'6\"", "47'6", "47' 6", "47 6", "47ft 6in", "47-6", "47 ft 6 in")
            .forEach { assertFeet(47.5f, it) }
    }

    @Test
    fun `a bare number is feet, not feet and inches`() {
        // 47.5 must be forty-seven and a half feet. Reading it as 47 feet
        // 5 inches would silently shorten a run by five inches a segment.
        assertFeet(47.5f, "47.5")
        assertFeet(47f, "47")
        assertFeet(47f, "47'")
    }

    @Test
    fun `inches on their own`() {
        assertFeet(0.5f, "6\"")
        assertFeet(0.5f, "6 in")
    }

    @Test
    fun `a fraction off the tape`() {
        assertFeet(47f + 6.5f / 12f, "47' 6 1/2\"")
        assertFeet(47f + 6.75f / 12f, "47' 6 3/4\"")
    }

    @Test
    fun `nonsense is refused rather than guessed at`() {
        listOf("", "   ", "abc", "forty seven", "47' 15\"", "47' 6/0\"", "--", "'")
            .forEach { assertNull("\"$it\" should be refused", FeetInches.parse(it)) }
    }

    @Test
    fun `formatting says what a crew would say`() {
        assertEquals("47' 6\"", FeetInches.format(47.5f))
        assertEquals("47'", FeetInches.format(47f))
        assertEquals("100' 3\"", FeetInches.format(100.25f))
    }

    @Test
    fun `an eighth short of the next foot carries instead of reading twelve inches`() {
        // 47.9975 ft is 11.97 inches. Naive rounding prints 47' 12", which is
        // the classic way this goes wrong on a drawing.
        assertEquals("48'", FeetInches.format(47.9975f))
        assertEquals("48'", FeetInches.formatCompact(47.9975f))
    }

    @Test
    fun `fractions are reduced the way a tape is read`() {
        assertEquals("10' 6 1/2\"", FeetInches.format(10f + 6.5f / 12f))
        assertEquals("10' 6 3/4\"", FeetInches.format(10f + 6.75f / 12f))
        assertEquals("10' 6 1/4\"", FeetInches.format(10f + 6.25f / 12f))
    }

    @Test
    fun `what is formatted can be read back`() {
        listOf(12.0f, 47.5f, 100.25f, 8.125f, 63.375f).forEach { feet ->
            val text = FeetInches.format(feet)
            val back = FeetInches.parse(text)
                ?: throw AssertionError("could not read back \"$text\"")
            assertEquals(text, feet.toDouble(), back.toDouble(), 0.01)
        }
    }

    @Test
    fun `the compact form stays short for a crowded drawing`() {
        assertEquals("47'6\"", FeetInches.formatCompact(47.5f))
        assertEquals("47'", FeetInches.formatCompact(47f))
    }
}

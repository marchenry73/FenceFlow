package com.fenceestimator.app.ui.components

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Feet and inches, the way a fence crew says them.
 *
 * The app has always held lengths as a decimal float, because that is what
 * the geometry and the pricing want. Nobody on a job site says "47.5 feet".
 * They say 47 foot 6, they write 47' 6", and the tape in their hand is
 * marked in inches. A drawing tool that can only accept 47.5 is a drawing
 * tool that makes its user do arithmetic before they are allowed to type.
 *
 * So this converts in both directions, and it is deliberately generous about
 * what it will read: a person entering a measurement in a truck should not
 * have to discover the one punctuation the parser likes.
 */
object FeetInches {

    /** Inches rounded to this many parts of an inch. Eighths is what a tape shows. */
    private const val EIGHTHS = 8

    /**
     * `47' 6"`, or `47'` when it lands on the foot.
     *
     * Rounded to the nearest eighth and then carried properly: 11.97 inches
     * must read as the next foot, not as `47' 12"`, which is the classic way
     * this goes wrong.
     */
    fun format(feet: Float): String {
        if (!feet.isFinite()) return "0'"
        val negative = feet < 0f
        val total = abs(feet)
        var wholeFeet = total.toInt()
        val eighths = ((total - wholeFeet) * 12f * EIGHTHS).roundToInt()
        var inchEighths = eighths
        if (inchEighths >= 12 * EIGHTHS) {
            wholeFeet += 1
            inchEighths = 0
        }
        val inches = inchEighths / EIGHTHS
        val remainder = inchEighths % EIGHTHS
        val sign = if (negative) "-" else ""
        return buildString {
            append(sign)
            append(wholeFeet)
            append('\'')
            if (inches > 0 || remainder > 0) {
                append(' ')
                append(inches)
                if (remainder > 0) {
                    // Reduced, because 6/8 on a drawing is somebody else's
                    // arithmetic to do: 3/4 is what the tape says.
                    val g = gcd(remainder, EIGHTHS)
                    append(' ')
                    append(remainder / g)
                    append('/')
                    append(EIGHTHS / g)
                }
                append('"')
            }
        }
    }

    /** Short form for a crowded drawing: `47'6"`, no spaces, no fractions. */
    fun formatCompact(feet: Float): String {
        if (!feet.isFinite()) return "0'"
        val total = abs(feet)
        var wholeFeet = total.toInt()
        var inches = ((total - wholeFeet) * 12f).roundToInt()
        if (inches >= 12) { wholeFeet += 1; inches = 0 }
        val sign = if (feet < 0f) "-" else ""
        return if (inches == 0) "$sign$wholeFeet'" else "$sign$wholeFeet'$inches\""
    }

    /**
     * Reads back anything a person is likely to type for a length.
     *
     * Accepted, all meaning the same 47.5 feet:
     *   `47' 6"` · `47'6` · `47 6` · `47ft 6in` · `47-6` · `47.5` · `47' 6 1/2"`
     *   (that last one being 47' 6.5", i.e. 47.5416…)
     *
     * A bare number is feet, because that is what the field is labelled and
     * what the old flow accepted; `6"` alone is six inches. Returns null for
     * anything that is not a length, so a caller can leave the value alone
     * rather than silently writing a zero.
     */
    fun parse(raw: String): Float? {
        val text = raw.trim().lowercase()
        if (text.isEmpty()) return null

        // Inches only: 6" or 6 in.
        Regex("""^(\d+(?:\.\d+)?)\s*(?:"|''|in|inch|inches)$""").find(text)?.let {
            return it.groupValues[1].toFloatOrNull()?.div(12f)
        }

        // Feet, then optionally inches, then optionally a fraction of an inch.
        val m = Regex(
            """^(-?\d+(?:\.\d+)?)\s*(?:'|ft|feet|foot|-|\s)?""" +   // feet
            """\s*(?:(\d+(?:\.\d+)?)\s*(?:(\d+)\s*/\s*(\d+))?\s*(?:"|''|in|inch|inches)?)?\s*$"""
        ).find(text) ?: return null

        val feet = m.groupValues[1].toFloatOrNull() ?: return null
        val inchesPart = m.groupValues[2]
        val fracNum = m.groupValues[3]
        val fracDen = m.groupValues[4]

        // "47.5" with nothing after it is decimal feet, not 47 feet 5 inches.
        if (inchesPart.isEmpty()) return feet

        var inches = inchesPart.toFloatOrNull() ?: return null
        if (fracNum.isNotEmpty() && fracDen.isNotEmpty()) {
            val n = fracNum.toFloatOrNull() ?: return null
            val d = fracDen.toFloatOrNull() ?: return null
            if (d == 0f) return null
            inches += n / d
        }
        // Twelve inches or more in the inches slot is a typo, not a length.
        if (inches >= 12f) return null
        val sign = if (feet < 0f) -1f else 1f
        return feet + sign * inches / 12f
    }

    private fun gcd(a: Int, b: Int): Int = if (b == 0) a else gcd(b, a % b)
}

package com.fenceestimator.app.ui.components

import java.text.NumberFormat
import java.util.Locale

/**
 * The one way money becomes text.
 *
 * A dozen screens each made their own currency formatter, and five more
 * skipped it and wrote "$" + "%.2f" -- so the same job read "$12,500.00" on
 * the home screen and "$12500.00" on its own page. For an app whose whole
 * pitch is getting the money right, the figure has to look the same
 * everywhere it appears.
 *
 * Always US dollars, always the thousands separator. Not the device locale:
 * a phone set to Spanish still quotes in dollars to a customer in Riverview.
 */
object Money {
    private val formatter: NumberFormat = NumberFormat.getCurrencyInstance(Locale.US)

    /** "$12,500.00" -- cents always shown, for anything that gets paid or owed. */
    fun format(amount: Double): String = synchronized(formatter) { formatter.format(amount) }

    /**
     * "$12,500" when the cents are zero, "$12,500.50" when they are not.
     * For tiles and summaries, where a trailing ".00" is noise.
     */
    fun short(amount: Double): String {
        val whole = amount == Math.rint(amount)
        return if (whole) format(amount).removeSuffix(".00") else format(amount)
    }
}

fun Double.asMoney(): String = Money.format(this)

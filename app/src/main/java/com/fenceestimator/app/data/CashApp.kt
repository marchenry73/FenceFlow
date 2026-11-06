package com.fenceestimator.app.data

/**
 * The Cash App payment link, for the phone.
 *
 * MARCH, 6 Nov 2026: "For the Cash App, I want for it to automatically pull up
 * the Cash App with the amount already on there", and then "Yes add it to my
 * phone too" -- the customer's side of this already existed on the quote page.
 *
 * THE SAME RULE AS website/quote.html's cashAppLink, deliberately, and the
 * stricter of the two the codebase already had:
 *
 *   * quote.html accepts [A-Za-z0-9_]{1,20} -- what a Cash App $cashtag
 *     actually is.
 *   * quote-approval-email/payment-methods.ts accepts [A-Za-z0-9_.-]{1,30} for
 *     DISPLAY, which is a different job: showing a tag somebody typed back to
 *     them, dots and all, is harmless, but building a payment URL out of it is
 *     not.
 *
 * This builds a URL, so it uses the strict rule.
 *
 * AND IT RETURNS NULL RATHER THAN A BROKEN LINK, for the reason quote.html
 * gives in its own comment: "A link that opens Cash App on a 404 is worse than
 * the copyable text it replaced: the customer thinks they have paid the wrong
 * person." On the phone the equivalent is the contractor standing in a garden
 * believing money is on its way.
 *
 * NOTHING HERE MARKS ANYTHING PAID. Cash App does not tell us whether the
 * payment happened, so tapping this cannot settle the job -- the payment still
 * has to be recorded. A button that marked a job paid on a tap would be a job
 * that reads as settled while the money never arrives.
 */
object CashApp {

    private val TAG = Regex("^[A-Za-z0-9_]{1,20}$")

    /**
     * `https://cash.app/$tag/12.34`, or null when there is nothing safe to
     * build.
     *
     * The amount is omitted -- not zeroed -- when it is not a positive figure,
     * so the link still opens the right person's Cash App and the amount is
     * typed by hand. A URL ending in `/0.00` would ask for nothing.
     */
    fun link(tag: String?, amount: Double?): String? {
        val clean = tag?.trim()?.removePrefix("$") ?: return null
        if (!TAG.matches(clean)) return null
        val n = amount ?: return "https://cash.app/$$clean"
        if (!n.isFinite() || n <= 0.005) return "https://cash.app/$$clean"
        // Two decimals, always, and never the platform's idea of a decimal
        // separator: a comma in a URL path is not an amount Cash App reads.
        val money = String.format(java.util.Locale.US, "%.2f", n)
        return "https://cash.app/$$clean/$money"
    }
}

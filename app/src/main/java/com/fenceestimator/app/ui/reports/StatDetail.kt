package com.fenceestimator.app.ui.reports

import com.fenceestimator.app.data.PaymentRecord

/**
 * What a headline figure is made of, and how it was arrived at.
 *
 * A number on its own invites two reactions and neither is useful: believe it,
 * or disbelieve it. Someone reading "Collected: $4,938.93" cannot act on it
 * without knowing which payments are in it, and if it looks wrong they have no
 * way to find out why except to ask.
 *
 * So every figure carries its arithmetic in words, and the rows that produced
 * it. That also makes the report self-checking -- a wrong total is obvious the
 * moment you can see what went into it.
 */
data class StatDetail(
    val title: String,
    /** The headline figure, formatted. */
    val value: String,
    /** How this is worked out, in a sentence a person would actually say. */
    val howItWorks: String,
    /** What it is made of. Empty when the figure is a count rather than a sum. */
    val lines: List<DetailLine> = emptyList(),
    /** Anything the reader should know about what is NOT in it. */
    val caveat: String? = null
)

/** One contributing row: what it was, when, and how much. */
data class DetailLine(
    val label: String,
    val sublabel: String = "",
    val amount: String = "",
    /** Refunds and other reductions, shown differently from money coming in. */
    val isNegative: Boolean = false
)

/**
 * Builds the explanation for each figure.
 *
 * Kept apart from the screen so the wording is in one place and can be read as
 * a whole -- these sentences are the difference between a report someone trusts
 * and one they quietly work around with a spreadsheet.
 */
object StatDetails {

    fun collected(
        totals: ReportTotals,
        payments: List<PaymentRecord>,
        jobNameFor: (Long) -> String,
        money: (Double) -> String,
        date: (Long) -> String
    ) = StatDetail(
        title = "Collected",
        value = money(totals.collected),
        howItWorks =
            "Every payment received in this date range, added up, less any refunds " +
                "given back in the same range. A payment counts on the day the money " +
                "arrived -- not the day the job was booked or finished.",
        lines = payments
            .sortedByDescending { it.receivedAt }
            .map { payment ->
                DetailLine(
                    label = jobNameFor(payment.jobId),
                    sublabel = date(payment.receivedAt) + " · " + payment.method.label +
                        if (payment.reference.isNotBlank()) " · " + payment.reference else "",
                    amount = money(payment.amount),
                    isNegative = payment.isRefund
                )
            },
        caveat = if (payments.isEmpty()) {
            "Nothing was received in this range. Money from jobs booked in this " +
                "period but paid later will appear in the period it was paid."
        } else null
    )

    fun profit(totals: ReportTotals, money: (Double) -> String) = StatDetail(
        title = "Profit",
        value = money(totals.profit),
        howItWorks = "What you collected, less what the work cost you.",
        lines = listOf(
            DetailLine("Collected", amount = money(totals.collected)),
            DetailLine("Materials", "From the priced line items", money(totals.materialCost), isNegative = true),
            DetailLine("Labour", "Approved crew hours only", money(totals.laborCost), isNegative = true),
            DetailLine("Other expenses", "Fuel, rentals, permits", money(totals.otherExpenses), isNegative = true)
        ),
        // Said plainly, because a contractor reading a profit figure that
        // excludes their van and their insurance and treating it as take-home
        // is how a business looks healthy while running out of money.
        caveat = "This does not include overheads -- insurance, vehicles, tools, " +
            "phone, office. It is profit on the work, not what the business made."
    )

    fun margin(totals: ReportTotals) = StatDetail(
        title = "Margin",
        value = "%.0f".format(totals.marginPercent) + "%",
        howItWorks = "Profit as a share of what you collected. Ten percent means " +
            "ten cents of every dollar collected was left after the work was paid for.",
        caveat = "Same exclusions as profit: no overheads."
    )

    fun jobsWon(totals: ReportTotals, wonJobNames: List<String>) = StatDetail(
        title = "Jobs won",
        value = totals.jobsWon.toString(),
        howItWorks = "Jobs in this range that the customer accepted or that are finished.",
        lines = wonJobNames.map { DetailLine(it) }
    )

    fun closeRate(totals: ReportTotals) = StatDetail(
        title = "Close rate",
        value = "%.0f".format(totals.closeRatePercent) + "%",
        howItWorks = "Of the ${totals.quotesSent} quote(s) that went out in this range, " +
            "${totals.jobsWon} became work.",
        caveat = if (totals.quotesSent == 0) "No quotes went out in this range." else null
    )

    fun hoursClocked(totals: ReportTotals, money: (Double) -> String) = StatDetail(
        title = "Hours clocked",
        value = "%.1f".format(totals.hoursClocked),
        howItWorks = "Every finished shift on these jobs, whether or not it has been " +
            "approved yet.",
        // The distinction that stops the two figures looking like a
        // contradiction: hours are what was worked, labour cost is what has
        // been signed off.
        caveat = "Labour cost above counts APPROVED hours only, so it can be lower " +
            "than these hours suggest. Approve shifts under Hours To Approve and " +
            "the two come together."
    )
}

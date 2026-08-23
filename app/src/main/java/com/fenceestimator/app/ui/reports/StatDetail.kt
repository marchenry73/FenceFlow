package com.fenceestimator.app.ui.reports

import android.content.Context
import com.fenceestimator.app.R
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
 *
 * These are called from click handlers (not composable scope), so the wording
 * is resolved through [Context.getString].
 */
object StatDetails {

    fun collected(
        context: Context,
        totals: ReportTotals,
        payments: List<PaymentRecord>,
        jobNameFor: (Long) -> String,
        money: (Double) -> String,
        date: (Long) -> String
    ) = StatDetail(
        title = context.getString(R.string.reports_collected),
        value = money(totals.collected),
        howItWorks = context.getString(R.string.rep_collected_how),
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
            context.getString(R.string.rep_collected_caveat_empty)
        } else null
    )

    fun profit(context: Context, totals: ReportTotals, money: (Double) -> String) = StatDetail(
        title = context.getString(R.string.rep_stat_profit),
        value = money(totals.profit),
        howItWorks = context.getString(R.string.rep_profit_how),
        lines = listOf(
            DetailLine(context.getString(R.string.reports_collected), amount = money(totals.collected)),
            DetailLine(context.getString(R.string.rep_line_materials), context.getString(R.string.rep_line_materials_sub), money(totals.materialCost), isNegative = true),
            DetailLine(context.getString(R.string.rep_line_labour), context.getString(R.string.rep_line_labour_sub), money(totals.laborCost), isNegative = true),
            DetailLine(context.getString(R.string.rep_line_other_expenses), context.getString(R.string.rep_line_other_expenses_sub), money(totals.otherExpenses), isNegative = true)
        ),
        // Said plainly, because a contractor reading a profit figure that
        // excludes their van and their insurance and treating it as take-home
        // is how a business looks healthy while running out of money.
        caveat = context.getString(R.string.rep_profit_caveat)
    )

    fun margin(context: Context, totals: ReportTotals) = StatDetail(
        title = context.getString(R.string.reports_margin),
        value = "%.0f".format(totals.marginPercent) + "%",
        howItWorks = context.getString(R.string.rep_margin_how),
        caveat = context.getString(R.string.rep_margin_caveat)
    )

    fun jobsWon(context: Context, totals: ReportTotals, wonJobNames: List<String>) = StatDetail(
        title = context.getString(R.string.rep_stat_jobs_won),
        value = totals.jobsWon.toString(),
        howItWorks = context.getString(R.string.rep_jobs_won_how),
        lines = wonJobNames.map { DetailLine(it) }
    )

    fun closeRate(context: Context, totals: ReportTotals) = StatDetail(
        title = context.getString(R.string.rep_stat_close_rate),
        value = "%.0f".format(totals.closeRatePercent) + "%",
        howItWorks = context.getString(R.string.rep_close_rate_how, totals.quotesSent, totals.jobsWon),
        caveat = if (totals.quotesSent == 0) context.getString(R.string.rep_close_rate_caveat_none) else null
    )

    fun hoursClocked(context: Context, totals: ReportTotals, money: (Double) -> String) = StatDetail(
        title = context.getString(R.string.rep_stat_hours_clocked),
        value = "%.1f".format(totals.hoursClocked),
        howItWorks = context.getString(R.string.rep_hours_how),
        // The distinction that stops the two figures looking like a
        // contradiction: hours are what was worked, labour cost is what has
        // been signed off.
        caveat = context.getString(R.string.rep_hours_caveat)
    )
}

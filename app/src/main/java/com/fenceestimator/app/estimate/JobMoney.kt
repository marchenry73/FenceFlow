package com.fenceestimator.app.estimate

import com.fenceestimator.app.R
import com.fenceestimator.app.data.Job

/**
 * One place that decides what a customer has paid and what they still owe.
 *
 * These figures were being worked out inline on the job screen, in the PDF
 * exporter and in the payment-link button, and they had already drifted apart:
 * the button asked for the original deposit again after money had arrived,
 * because its fallback was "the deposit" rather than "whatever is left".
 *
 * The rule everything hangs off: **the customer owes the contract total minus
 * what they have actually paid, net of refunds.** Never the original deposit,
 * never a figure captured earlier.
 */
object JobMoney {

    /**
     * Money that stayed with you.
     *
     * [Job.amountPaid] and [Job.refundedAmount] are both totals that only ever
     * grow -- sync keeps the larger of each so a race can't erase money -- so
     * the net is the difference rather than either one alone.
     */
    fun netPaid(job: Job): Double = (job.amountPaid - job.refundedAmount).coerceAtLeast(0.0)

    /**
     * What the customer still owes on the whole job. Never negative.
     *
     * Floored deliberately, because this is what gets ASKED for -- a payment
     * request for a negative amount is meaningless, and a payment link for one
     * would be worse.
     *
     * For showing a figure on screen, use [balance], which can go negative and
     * say so.
     */
    fun stillOwed(job: Job, contractTotal: Double): Double =
        (contractTotal - netPaid(job)).coerceAtLeast(0.0)

    /**
     * The balance as it really stands, negative when the money is owed the
     * other way.
     *
     * The screen used to floor this at zero, so a customer who had overpaid by
     * $400 read as "Still owed $0.00" -- which is not what a contractor needs
     * to see. Owing somebody $400 is a fact about the job, and one worth acting
     * on before they ask.
     */
    fun balance(job: Job, contractTotal: Double): Double = contractTotal - netPaid(job)

    /** True when they have paid more than the job is worth -- worth saying out loud. */
    fun overpaid(job: Job, contractTotal: Double): Boolean =
        contractTotal > 0.0 && netPaid(job) > contractTotal + 0.005

    /** How much of an overpayment could be handed back. */
    fun refundable(job: Job, contractTotal: Double): Double =
        if (contractTotal <= 0.0) netPaid(job)
        else (netPaid(job) - contractTotal).coerceAtLeast(0.0)

    /**
     * What the next payment request should be for.
     *
     * The order matters, and getting it wrong is what put "Request $5730.00
     * deposit" on a job that was already paid. Once any money has arrived, the
     * only correct figure is what remains -- falling back to the deposit would
     * bill someone a second time for the same money.
     */
    fun nextRequestAmount(job: Job, contractTotal: Double): Double {
        val owed = stillOwed(job, contractTotal)
        if (owed <= 0.005) return 0.0
        // Nothing paid yet and a deposit is set: ask for the deposit, but never
        // for more than the job is worth.
        if (netPaid(job) <= 0.005 && job.depositAmount > 0.005) {
            return minOf(job.depositAmount, owed)
        }
        return owed
    }

    /** What to call that request, so the customer sees the right word on the link. */
    fun nextRequestLabel(job: Job, contractTotal: Double): String =
        if (netPaid(job) <= 0.005 && job.depositAmount > 0.005) "deposit" else "balance"

    /**
     * Whether the paid figure came from a processor and so must not be typed over.
     *
     * What Stripe reports is the record. An accidental keystroke on top of it is
     * not a correction, it is a discrepancy that surfaces when the customer
     * disputes the bill.
     */
    fun paidFigureIsReadOnly(job: Job): Boolean = job.paymentsFromProcessor

    /**
     * Whether the customer's signature still describes the job they signed for.
     *
     * A signature means "I agree to this", and "this" was a price and a length
     * of fence. Redraw the layout afterwards and the signature silently becomes
     * agreement to a job that no longer exists.
     *
     * Jobs signed before this was tracked carry zeroed terms, and are left
     * alone rather than flagged -- retroactively accusing every historical job
     * of being unsigned would train people to ignore the warning.
     */
    fun signatureIsStale(job: Job, contractTotal: Double, linearFeet: Float): Boolean {
        if (job.signedAt == null) return false
        if (job.signedContractTotal <= 0.0 && job.signedLinearFeet <= 0f) return false
        val moneyMoved = kotlin.math.abs(contractTotal - job.signedContractTotal) > MONEY_TOLERANCE
        val fenceMoved = kotlin.math.abs(linearFeet - job.signedLinearFeet) > FOOTAGE_TOLERANCE
        return moneyMoved || fenceMoved
    }

    /**
     * Why a new signature is needed, as string resources plus their positional
     * arguments (figures pre-formatted here so they read exactly as before).
     *
     * Each entry is one clause -- "the price moved from $X to $Y" -- and the
     * screen joins them with [R.string.eng2_reason_joiner] ("and") so the whole
     * sentence comes out in the device language. Written for the person who has
     * to make the phone call, not for a log.
     */
    fun staleSignatureReasonParts(
        job: Job,
        contractTotal: Double,
        linearFeet: Float
    ): List<Pair<Int, List<Any>>> {
        val parts = mutableListOf<Pair<Int, List<Any>>>()
        if (kotlin.math.abs(contractTotal - job.signedContractTotal) > MONEY_TOLERANCE) {
            parts += R.string.eng2_reason_price_moved to listOf(
                "%.2f".format(job.signedContractTotal),
                "%.2f".format(contractTotal)
            )
        }
        if (kotlin.math.abs(linearFeet - job.signedLinearFeet) > FOOTAGE_TOLERANCE) {
            parts += R.string.eng2_reason_fence_moved to listOf(
                "%.0f".format(job.signedLinearFeet),
                "%.0f".format(linearFeet)
            )
        }
        return parts
    }

    /**
     * English-only join of [staleSignatureReasonParts], kept for callers with
     * no resources in reach (EstimateEngine.estimateWarnings embeds it in a
     * warning's arguments). Screens should render the parts with
     * `stringResource` instead.
     */
    fun staleSignatureReason(job: Job, contractTotal: Double, linearFeet: Float): String =
        staleSignatureReasonParts(job, contractTotal, linearFeet).joinToString(" and ") { (res, args) ->
            when (res) {
                R.string.eng2_reason_price_moved ->
                    "the price moved from $${args[0]} to $${args[1]}"
                else ->
                    "the fence went from ${args[0]} ft to ${args[1]} ft"
            }
        }

    /** A dollar of rounding is not a renegotiation. */
    private const val MONEY_TOLERANCE = 1.0

    /** Nudging a corner is not a new fence; two feet is. */
    private const val FOOTAGE_TOLERANCE = 2.0f
}

package com.fenceestimator.app.estimate

import com.fenceestimator.app.R
import com.fenceestimator.app.data.ChangeOrder
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
 * never a figure captured earlier. "The contract total" means [billableTotal]:
 * the price the customer accepted once they have, the live estimate until then.
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
     * True once the customer has agreed to this job -- whether that happened
     * as a drawn signature captured in the app ([Job.signedAt]) or as a typed
     * name approved on the emailed/texted quote page ([Job.quoteApprovedAt]).
     *
     * Those are two different mechanisms for the exact same agreement, not
     * two separate approvals. A screen that only checked [Job.signedAt] had a
     * customer type their name on the quote page, then get asked to sign
     * again in person for the same price -- the "I already did this" the
     * owner heard about. Anything gating on "has the customer accepted this
     * quote" should call this instead of reading [Job.signedAt] alone.
     */
    fun isAccepted(job: Job): Boolean = job.signedAt != null || job.quoteApprovedAt != null

    // ---- the price the customer accepted ----
    //
    // Every figure above takes "the contract total" as an argument, and every
    // caller used to pass the LIVE estimate. After acceptance that number kept
    // moving -- a catalog price changed, a takeoff was regenerated, a sync
    // reverted a quantity -- and it was pushed to the cloud as contract_total,
    // which the quote page, the payment link and the deposit cap all read.
    // Woody was signed at $3,620 and showed $200; job 4598 was signed at
    // $9,710 and asked against $13,410. [billableTotal] is what those callers
    // pass now: the accepted figure while one stands, the live estimate only
    // until then.

    /**
     * When the customer last agreed to this job -- the later of the two ways
     * they can ([Job.signedAt], [Job.quoteApprovedAt]), because a later
     * acceptance is the one the server re-stamps [Job.acceptedTotal] from.
     */
    fun acceptedAt(job: Job): Long? = listOfNotNull(job.signedAt, job.quoteApprovedAt).maxOrNull()

    /**
     * Extra work the customer has signed for since they accepted the price:
     * change orders whose own signature came after [acceptedAt], and that
     * were not already inside the price they accepted.
     *
     * A change order that existed at acceptance is already inside the figure
     * they accepted -- the engine counts every order in grandTotal, signed or
     * not -- so adding it again bills it twice. The signature's time alone
     * could not tell: an order added while the quote was out, left unsigned,
     * and signed the day after the contract has a signature AFTER acceptance
     * and was inside the accepted figure all along ($9,710 accepted with a
     * $900 order in it billed as $10,610). [ChangeOrder.inAcceptedTotal] is
     * the record of which orders an acceptance covered: marked on this phone
     * at a signature, on the server at an online approval. createdAt cannot
     * stand in for it: change orders do not carry created_at to the cloud, so
     * a second phone stamps them with the moment it pulled them.
     *
     * An unsigned change order added after acceptance does not move the price
     * until the customer signs it. That is the agreement working, not a gap.
     */
    fun extraWorkSinceAcceptance(job: Job, changeOrders: List<ChangeOrder>): Double {
        val since = acceptedAt(job) ?: return 0.0
        return changeOrders
            .filter { order -> !order.inAcceptedTotal && order.signedAt?.let { it > since } == true }
            .sumOf { it.additionalCost }
    }

    /**
     * The price that stands once the customer has accepted: [Job.acceptedTotal]
     * plus [extraWorkSinceAcceptance]. Null when nothing anchors the price --
     * not accepted, no accepted figure recorded (every job accepted before the
     * column existed), or a drawing change has withdrawn the approval
     * ([Job.reapprovalRequiredAt]), in which case the live estimate is what the
     * customer is being asked to approve again and must be free to move.
     */
    fun anchoredTotal(job: Job, changeOrders: List<ChangeOrder>): Double? {
        if (!isAccepted(job)) return null
        if (job.reapprovalRequiredAt != null) return null
        val accepted = job.acceptedTotal ?: return null
        if (accepted <= 0.005) return null
        return accepted + extraWorkSinceAcceptance(job, changeOrders)
    }

    /**
     * The figure to bill against: [anchoredTotal] while one stands, else the
     * live estimate's grand total. The one argument every [stillOwed],
     * [nextRequestAmount], [balance] and deposit check on the job screen and
     * the customer PDF should be given, so the three can never disagree.
     */
    fun billableTotal(job: Job, liveGrandTotal: Double, changeOrders: List<ChangeOrder>): Double =
        anchoredTotal(job, changeOrders) ?: liveGrandTotal

    /**
     * [billableTotal] for a document whose caller may not have the change
     * orders to hand ([changeOrders] null -- the PDF export's callers, until
     * they pass them).
     *
     * Without the list, the accepted price is still used when the estimate
     * carries no change-order money at all ([liveChangeOrderCost] zero): then
     * there is provably no extra work to add, so the anchored figure is exact.
     * With change orders on the job and no list, the extra work signed since
     * acceptance cannot be told apart from work already inside the accepted
     * figure, and guessing low would under-bill signed extra work -- so the
     * live estimate is printed, as it always was, rather than a wrong price.
     */
    fun documentTotal(
        job: Job,
        liveGrandTotal: Double,
        liveChangeOrderCost: Double,
        changeOrders: List<ChangeOrder>?
    ): Double = when {
        changeOrders != null -> billableTotal(job, liveGrandTotal, changeOrders)
        liveChangeOrderCost <= 0.005 -> billableTotal(job, liveGrandTotal, emptyList())
        else -> liveGrandTotal
    }

    /**
     * The "Set deposit to cover materials" suggestion: what is still needed to
     * buy the materials, net of money already in, rounded up to the next $10 --
     * and never more than is still owed on [billableTotal].
     *
     * Only ever offered, never written by itself. It used to be written
     * automatically the first time the materials figure was non-zero, which on
     * a takeoff that was flip-flopping (see the line-item sync fixes) meant
     * whatever snapshot happened to be on screen became the customer's deposit,
     * for good. The cap is new too: materials can outrun the agreed price (a
     * $3,620 job carrying $3,963 of hidden lines), and a deposit above the
     * price is a bill for money the customer never agreed to.
     */
    fun suggestedMaterialsDeposit(job: Job, materialCost: Double, billableTotal: Double): Double {
        if (materialCost <= 0.0 || billableTotal <= 0.0) return 0.0
        val outstanding = materialCost - netPaid(job)
        if (outstanding <= 0.0) return 0.0
        val rounded = kotlin.math.ceil(outstanding / 10.0) * 10.0
        return minOf(rounded, stillOwed(job, billableTotal))
    }

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

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
 * what they have actually paid, net of refunds.** Never a figure captured
 * earlier. "The contract total" means [billableTotal]: the price the customer
 * accepted once they have, the live estimate until then.
 *
 * WHAT TO ASK FOR NEXT is a second question, and the answer changed on 2 Oct
 * 2026: **the rest of the deposit while any of it is outstanding, then the
 * balance** ([nextRequestAmount]). Asking for the whole balance the moment a
 * first payment arrived -- which is what this did -- billed the labour on a
 * fence that had not been built, and disagreed with the figure the customer's
 * own quote page was showing her at the same moment. What it must never do,
 * and never did, is fall back to the ORIGINAL deposit after money has arrived:
 * that bills the same money twice. The deposit asked for is itself always
 * capped at the price ([depositAsked]).
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

    // ---- the deposit as a figure every surface reads the same way ----
    //
    // THE ONE CAP DECISION. jobs.deposit_amount is what the contractor typed
    // or tapped; what any surface may ASK FOR is that figure capped at the
    // price the job is billed against. The cap used to live in five places
    // (quote page, approval email, pay link, office job sheet, office
    // re-price) and nowhere in three (the contract PDF's deposit row, the
    // {DEPOSIT} in its terms, the phone's estimate card), so a signed
    // contract could state a deposit LARGER than the price the same customer
    // page showed -- a deposit of 3,963 was once stored on a 3,620 job.
    // [depositAsked] is that decision, in the same arithmetic as the server's
    // depositFigures().asked in _shared/quote-deposit.ts.
    //
    // WHY A DEPOSIT ABOVE THE PRICE IS CAPPED RATHER THAN REFUSED: a stored
    // deposit over the price is almost always a price that MOVED underneath a
    // figure that was right when it was typed -- a takeoff regenerated, lines
    // lost and rebuilt, a discount applied after the deposit was set. Refusing
    // (printing nothing, or blocking the document) would stop a contract going
    // out over a data condition the customer has nothing to do with, and would
    // hide money the contractor is owed. Capping prints the largest figure the
    // customer could honestly be asked for -- the whole price -- and the phone
    // still says so out loud on the job screen (depositOverContract) so he can
    // correct it. Nothing is ever asked for above the price.

    /**
     * The deposit this job may ask for: the stored figure, never more than
     * [billableTotal]. Zero means no deposit was asked for.
     *
     * Not capped when the job has no price at all ([billableTotal] zero or
     * less): a job priced at zero has not been priced, not been made free, and
     * capping against it would silently erase a deposit the contractor typed.
     * Same rule, same guard, as depositFigures().asked.
     */
    fun depositAsked(job: Job, billableTotal: Double): Double {
        val requested = job.depositAmount.coerceAtLeast(0.0)
        return if (billableTotal > 0.0) minOf(requested, billableTotal) else requested
    }

    /**
     * What is still owed ON THE DEPOSIT: [depositAsked] less what has actually
     * been paid, floored at zero. The server's depositFigures().due, to the
     * cent, and the figure the customer's own quote page prints.
     */
    fun depositStillDue(job: Job, billableTotal: Double): Double =
        // To the cent. Both sides are cents-exact and the subtraction is not:
        // 2,119.99 less 500.01 is 1619.9799999999998 in doubles. The server
        // rounds the same way (depositFigures().due), because the two have to
        // produce the same number for the same job.
        EstimateEngine.roundToCents(
            (depositAsked(job, billableTotal) - netPaid(job)).coerceAtLeast(0.0)
        )

    /**
     * THE ONE MEANING OF "DEPOSIT RECEIVED": the whole deposit that was asked
     * for is in, or none was asked for.
     *
     * It used to mean two things at once. The phone's project stages and the
     * payment-status column read "any money has arrived"; the office's
     * readiness checklist read "the whole deposit is collected". So a job with
     * $500 of a $3,000 deposit in showed "Deposit received" on the phone and
     * "Asked $3,000.00, collected $500.00" in the office, on the same job, on
     * the same afternoon. The office reading is the one that answers the
     * question the stage is actually for -- can the materials be bought and the
     * job put on the schedule -- so it is the one that survives. The other
     * reading is no longer called a deposit anywhere: the payment-status value
     * that is set by any payment now reads "Part paid".
     *
     * Identical to the office's `dep <= 0.005 || paid >= dep - 0.005`
     * (dashboard.html jobReadiness), written through [depositStillDue] so
     * there is one subtraction rather than two.
     */
    fun depositSettled(job: Job, billableTotal: Double): Boolean =
        depositStillDue(job, billableTotal) <= 0.005

    /**
     * What the next payment request should be for.
     *
     * THE REST OF THE DEPOSIT FIRST, THEN THE BALANCE -- and this is where the
     * pin moved on 2 Oct 2026. It used to ask for the whole remaining balance
     * the moment any money arrived, while the customer's own quote page went
     * on asking for the rest of the deposit: on a job with a $3,000 deposit
     * and a $4,654.47 total, $500 in, the phone offered to bill $4,154.47 and
     * her page said $2,500.00 was due. Both were deliberate, both were tested,
     * and they were on screen side by side.
     *
     * The page is right FOR THIS TRADE. The deposit buys the materials and the
     * slot on the schedule; the balance is labour, and the labour has not
     * happened yet. Asking a customer for the whole balance after one part
     * payment is asking to be paid for a fence that is not built, which is the
     * one thing a contractor cannot defend on the phone. So the request is the
     * rest of the deposit while any of it is outstanding ([depositStillDue],
     * the server's own `due`), and the remaining balance only once the deposit
     * is settled.
     *
     * Never more than is owed on the whole job: [depositStillDue] is already
     * capped at the price, so the floor is belt and braces.
     */
    fun nextRequestAmount(job: Job, contractTotal: Double): Double {
        val owed = stillOwed(job, contractTotal)
        if (owed <= 0.005) return 0.0
        val depositLeft = depositStillDue(job, contractTotal)
        if (depositLeft > 0.005) return minOf(depositLeft, owed)
        return owed
    }

    /** What to call that request, so the customer sees the right word on the link. */
    fun nextRequestLabel(job: Job, contractTotal: Double): String =
        if (depositStillDue(job, contractTotal) > 0.005) "deposit" else "balance"

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

    // ---- the deposit rule ----
    //
    // One rule, defined once per language: this object for the phone and
    // _shared/quote-deposit.ts (ruleDeposit / suggestedDeposit) for the server.
    // tests/a29-deposit-rule-vectors.json is run by BOTH
    // (JobMoneyDepositRuleTest.kt here, tests/a29-deposit-and-rounding.test.mjs
    // there), so one cannot change without the other going red.

    /** The deposit is rounded UP to the next multiple of this many dollars... */
    private const val DEPOSIT_ROUND_UP_TO = 100L

    /** ...and then this many dollars are added. */
    private const val DEPOSIT_PLUS = 100L

    /**
     * THE DEPOSIT RULE, in one sentence: the deposit is the materials still to
     * be bought, rounded up to the next $100, plus another $100 -- and what is
     * left to collect on it is never more than is still owed on the job
     * ([depositSuggestion] caps the stored figure at the price, which comes to
     * the same thing).
     *
     * The extra $100 pays for scheduling and transport. It is the contractor's
     * business and is deliberately NOT disclosed to the customer: it is folded
     * into the one deposit figure and never itemised, noted or explained on the
     * quote page, in the contract or in the PDF, each of which prints a single
     * deposit number. The contractor's own screens may say what the figure is
     * made of; a customer-facing surface must not.
     *
     * Returns whole dollars, or 0 when no materials are outstanding.
     *
     *  - Rounded UP means a figure that is already a whole hundred stays where
     *    it is before the $100 is added: $1,000 of materials is a $1,100
     *    deposit.
     *  - The amount is taken to cents FIRST, and the rounding is done in whole
     *    cents. $1,000 of materials that arrives as 1000.0000000000001 is
     *    $1,000, not a cent over -- float dust must not push a deposit into
     *    the next hundred.
     */
    fun ruleDeposit(outstandingMaterials: Double): Double {
        if (!outstandingMaterials.isFinite()) return 0.0
        val cents = Math.round(outstandingMaterials * 100.0)
        if (cents <= 0L) return 0.0
        val stepCents = DEPOSIT_ROUND_UP_TO * 100L
        val hundreds = (cents + stepCents - 1L) / stepCents
        return (hundreds * DEPOSIT_ROUND_UP_TO + DEPOSIT_PLUS).toDouble()
    }

    /**
     * A deposit to offer, and whether the cap on it bit.
     *
     * @property amount dollars; 0 when there is nothing to suggest.
     * @property capped true when [amount] is all that is still owed on the job
     *   and the rule's own figure was higher.
     */
    data class DepositSuggestion(val amount: Double, val capped: Boolean) {
        companion object { val NONE = DepositSuggestion(0.0, false) }
    }

    /**
     * WHAT A MATERIALS FIGURE MEANS, in one definition, because three phone
     * surfaces each had their own and none of them paid the sales tax.
     *
     * "Materials still to be bought" is cash he has to put out before the
     * fence can be built: the estimate's material lines, PLUS THE SALES TAX
     * ON THEM, plus the materials on any change order. He pays Florida sales
     * tax at the counter, so a materials figure without it is short by the tax
     * on every job -- about 7% of the largest number on the estimate.
     *
     * The three that disagreed, before this:
     *  - the "Set deposit" suggestion: lines + change-order materials, no tax;
     *  - the note under that button: the same figure, described as "Materials
     *    come to ... Rounded up to the next $10", which was neither the basis
     *    nor the rule;
     *  - the estimate's own affordability warning (EstimateEngine's
     *    warn_deposit_short / warn_fronting_material): totals.materialsSubtotal
     *    alone -- no tax AND no change-order materials, so a job whose extra
     *    work was all material read as covered when it was not.
     *
     * Change-order materials carry no tax here because the engine does not tax
     * them either (they are a cost the contractor types, not a priced line), so
     * this adds exactly the tax the engine charged and no tax it did not.
     *
     * [EstimateEngine.Totals.tax] is the tax on the taxable material lines and
     * nothing else -- labour and gates are not in its base -- so adding it does
     * not drag anything but materials into the figure.
     */
    fun materialsToBuy(totals: EstimateEngine.Totals, changeOrders: List<ChangeOrder>): Double =
        EstimateEngine.roundToCents(
            totals.materialsSubtotal + totals.tax + changeOrders.sumOf { it.materialCost }
        )

    /**
     * The "Set deposit" suggestion: the deposit to STORE, which is money
     * already in PLUS [ruleDeposit] of the materials still to be bought,
     * never more than [billableTotal].
     *
     * WHICH COLUMN IS CUMULATIVE, AND WHY THIS CHANGED ON 2 OCT 2026. This
     * moves real money, so the reasoning is written out rather than implied:
     *
     *  - `jobs.deposit_amount` is CUMULATIVE. It is the whole deposit asked of
     *    this customer. Every reader subtracts payments from it themselves:
     *    the server's depositFigures() returns `due = asked - netPaid`, the
     *    quote page prints "X of it is already paid -- Y left before we start",
     *    the office readiness line reads "Asked X, collected Y", and
     *    [depositStillDue] above does the same subtraction on the phone.
     *  - [ruleDeposit] of `materialsToBuy - netPaid` is INCREMENTAL. It is what
     *    still has to be COLLECTED, with the money already in taken off.
     *
     * Writing the incremental figure into the cumulative column subtracted the
     * same payment twice. Measured: $2,449.10 of materials, $1,000 already in,
     * on a $9,710 job. The rule needs $1,449.10 more, which rounds to $1,600.
     * The old suggestion stored 1,600, and the customer's page then asked for
     * `1,600 - 1,000 = 600`. He is $1,000 short of the materials on a job he is
     * about to buy for. The same arithmetic in the other direction made the
     * office report the wrong amount received against the deposit.
     *
     * So the suggestion is `netPaid + rule`, and every reader's own
     * subtraction then lands on exactly the incremental figure the rule asked
     * for: `asked - netPaid = 2,600 - 1,000 = 1,600`. On a job with nothing
     * paid the two are the same number, which is why this was invisible until
     * somebody part-paid.
     *
     * THE CAP, and what the customer sees where it bites. A deposit above the
     * job is a bill for money the customer never agreed to (a $3,963 deposit
     * was once stored against a $3,620 job), so the suggestion stops at the
     * price. On a small job that is the whole job: materials of $120 on a $150
     * job rule to $300, so the suggestion is the $150 -- the customer is asked
     * for the whole price up front, as one ordinary deposit figure with
     * nothing added on top of it. There is simply no room for the extra $100.
     * Capped, the figure is the price to the cent, which is also
     * `netPaid + stillOwed` -- so [depositStillDue] on a capped deposit is
     * exactly the balance, and the cap bites on the same inputs it always did
     * (`rule > stillOwed`), so `capped` has not changed for any case.
     *
     * Only ever offered, never written by itself -- see [depositToSeed] for the
     * one narrow case where writing it is safe. It used to be written
     * automatically the first time the materials figure was non-zero, which on
     * a takeoff that was flip-flopping (see the line-item sync fixes) meant
     * whatever snapshot happened to be on screen became the customer's deposit,
     * for good.
     *
     * Same inputs and same answer as the server's suggestedDeposit in
     * quote-deposit.ts: non-finite inputs read as nothing to suggest on both.
     *
     * @param materialsToBuy [materialsToBuy] -- materials with their tax.
     */
    fun depositSuggestion(job: Job, materialsToBuy: Double, billableTotal: Double): DepositSuggestion {
        if (!materialsToBuy.isFinite() || !billableTotal.isFinite()) return DepositSuggestion.NONE
        if (materialsToBuy <= 0.0 || billableTotal <= 0.0) return DepositSuggestion.NONE
        val collected = netPaid(job)
        // INCREMENTAL: what still has to be collected for the materials.
        val toCollect = ruleDeposit(materialsToBuy - collected)
        if (toCollect <= 0.0) return DepositSuggestion.NONE
        val owed = EstimateEngine.roundToCents(stillOwed(job, billableTotal))
        if (owed <= 0.005) return DepositSuggestion.NONE
        // CUMULATIVE: what to store, so every reader's own `asked - netPaid`
        // lands back on [toCollect]. Capped, that is the price to the cent,
        // which is the same figure as collected + owed.
        return if (toCollect <= owed + 0.005) {
            DepositSuggestion(EstimateEngine.roundToCents(collected + toCollect), false)
        } else {
            DepositSuggestion(EstimateEngine.roundToCents(collected + owed), true)
        }
    }

    /** [depositSuggestion]'s amount. Kept under its old name for the callers that only want the figure. */
    fun suggestedMaterialsDeposit(job: Job, materialsToBuy: Double, billableTotal: Double): Double =
        depositSuggestion(job, materialsToBuy, billableTotal).amount

    /**
     * Whether the customer is in it, so the deposit must stop following the
     * price: they approved or signed a price that still stands, or money has
     * actually moved. The same test, in the same terms, as the database's
     * deposit_follows_price trigger (supabase_r8_deposit_follows_price.sql,
     * customer_is_in_it) -- read off the job's own fields, never a figure a
     * client supplied.
     */
    fun customerIsInIt(job: Job): Boolean =
        (isAccepted(job) && job.reapprovalRequiredAt == null) || netPaid(job) > 0.005

    /**
     * The deposit to STORE on a job that has none, or null when nothing should
     * be stored. This is the one case where writing the suggestion is safe,
     * and it is as narrow as the old auto-fill was wide:
     *
     *  - a deposit already on the job is never touched (a person typed it or
     *    tapped it; the old auto-fill overwrote one, and John Beaunissant's
     *    moved from $9,910 to $5,730 ten seconds after he signed), and
     *  - nothing is written once [customerIsInIt]: a deposit that changes after
     *    the customer has agreed is a different deal from the one they signed.
     *
     * NOT CALLED ANYWHERE YET. Nothing seeds a deposit today: a new job's
     * deposit stays 0 until a person types one or taps "Set deposit", which is
     * why the estimate's "Deposit ($0.00) doesn't cover the estimated material
     * cost" warning appears on a fresh job whose materials are substantial.
     * This is the decision, pure and tested, for whoever wires the write (the
     * job screen's view model, after a takeoff run); the figure it returns is
     * what [depositSuggestion] already offers. Wiring it also needs a decision
     * about the database trigger: deposit_follows_price scales a stored
     * deposit in proportion to every re-price, which turns a whole-hundred
     * deposit into one that is not. (That trigger was DROPPED on 1 Oct 2026
     * after it rescaled deposits behind the owner's back on a re-price; two
     * of his jobs still carry the figures it left. See
     * docs/DEPOSIT_DATA_PENDING.md.)
     *
     * Only reached with nothing paid (customerIsInIt refuses once netPaid is
     * above zero), so the cumulative and incremental figures are the same
     * number here and the seed is the rule's own answer.
     */
    fun depositToSeed(job: Job, materialsToBuy: Double, billableTotal: Double): Double? {
        if (job.depositAmount > 0.005) return null
        if (customerIsInIt(job)) return null
        return depositSuggestion(job, materialsToBuy, billableTotal).amount.takeIf { it > 0.0 }
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
     *
     * The price half is [priceMovedSinceSigning], which knows about the
     * rounding change of 1 Oct 2026 (below). Without it this check would have
     * blocked the estimate and the invoice on most signed jobs the day totals
     * went exact.
     */
    fun signatureIsStale(job: Job, contractTotal: Double, linearFeet: Float): Boolean {
        if (job.signedAt == null) return false
        if (job.signedContractTotal <= 0.0 && job.signedLinearFeet <= 0f) return false
        val moneyMoved = priceMovedSinceSigning(job.signedContractTotal, contractTotal)
        val fenceMoved = kotlin.math.abs(linearFeet - job.signedLinearFeet) > FOOTAGE_TOLERANCE
        return moneyMoved || fenceMoved
    }

    /**
     * Whether the live price has moved off the figure the customer signed.
     *
     * More than [MONEY_TOLERANCE] apart, EXCEPT for one case the old rounding
     * made possible. Until engine 2026.10.1 every total was rounded UP to the
     * next ten, so a signed total always sat on a ten-dollar grid and the live
     * total sat on it too: the two were either equal or at least $10 apart, and
     * a one-dollar tolerance never had anything to decide. Totals are exact
     * now, so a job signed at $3,620 whose nothing-has-changed live estimate is
     * $3,614.50 is $5.50 "apart" -- and on a signed job that is a hard block:
     * [EstimateScreen]'s needsResign refuses to send the estimate or the
     * invoice until the customer signs again. About nine signed jobs in ten
     * would have hit it, for a price that never moved.
     *
     * So a signed figure that is on the ten-dollar grid is compared the way the
     * engine that produced it would have: the live total rounded up to the next
     * ten ([ceil]) must be that same figure. It is exactly the answer the old
     * engine gave for every such signature, so nothing that was caught before
     * stops being caught -- any change that moved the old, rounded total still
     * flags it. What it does not catch is a drop of under $10 that stays in the
     * same ten-dollar step, which the old engine could not see either. A
     * signed figure that is NOT on the grid (every signature taken on an
     * exact-engine phone, bar the one in ten that lands on a round figure by
     * chance) is compared exactly as before.
     */
    fun priceMovedSinceSigning(signedTotal: Double, liveTotal: Double): Boolean {
        if (kotlin.math.abs(liveTotal - signedTotal) <= MONEY_TOLERANCE) return false
        if (isOnTenDollarGrid(signedTotal) &&
            kotlin.math.abs(kotlin.math.ceil(liveTotal / 10.0) * 10.0 - signedTotal) <= MONEY_TOLERANCE
        ) return false
        return true
    }

    /** Whether [amount] is a whole multiple of ten dollars -- the grid every total sat on before 2026.10.1. */
    private fun isOnTenDollarGrid(amount: Double): Boolean =
        amount > 0.0 && kotlin.math.abs(amount - Math.rint(amount / 10.0) * 10.0) < 0.005

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
        if (priceMovedSinceSigning(job.signedContractTotal, contractTotal)) {
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

package com.fenceestimator.app.estimate

/**
 * What a document is for, and therefore who may see what is in it.
 *
 * The app used to produce one layout with an `isInvoice` flag, which meant the
 * customer received a full material breakdown with your buying prices on it,
 * and the "invoice" was the same page again under a different heading. Two
 * problems in one:
 *
 *  - **The customer does not need your material costs**, and showing them
 *    invites a negotiation about your margin instead of the work. They agreed
 *    to a price for a finished fence.
 *  - **The supplier does not need prices at all** -- they are the ones who
 *    send prices back. What they need is a list of what to quote.
 *
 * So the same job produces different documents for different readers, and each
 * one carries only what its reader has any business seeing.
 */
enum class JobDocument(
    val title: String,
    /** Material lines with unit prices. Internal only. */
    val showsMaterialPricing: Boolean,
    /** Quantities with no prices, for someone who will quote them. */
    val showsQuantitiesOnly: Boolean,
    /** The single agreed figure, terms, and somewhere to sign. */
    val showsContractTerms: Boolean,
    /** What has been paid and what is left. */
    val showsPaymentStatus: Boolean
) {
    /**
     * Your own working copy: every line, every price, the margin. Never sent to
     * a customer, and the only document that shows what the job costs you.
     */
    WORKING_ESTIMATE(
        title = "Estimate — internal",
        showsMaterialPricing = true,
        showsQuantitiesOnly = false,
        showsContractTerms = false,
        showsPaymentStatus = false
    ),

    /**
     * What the customer signs. The scope of work, the agreed price, the terms,
     * and a signature line -- no material breakdown.
     */
    CUSTOMER_CONTRACT(
        title = "Contract",
        showsMaterialPricing = false,
        showsQuantitiesOnly = false,
        showsContractTerms = true,
        showsPaymentStatus = true
    ),

    /**
     * Sent to the supplier or manufacturer: what is needed, in what quantity,
     * with nowhere for a price because theirs is the price that matters.
     */
    SUPPLIER_REQUEST(
        title = "Material Request",
        showsMaterialPricing = false,
        showsQuantitiesOnly = true,
        showsContractTerms = false,
        showsPaymentStatus = false
    ),

    /**
     * The bill. What was agreed, what has been paid, what is outstanding --
     * not a second copy of the estimate.
     */
    CUSTOMER_INVOICE(
        title = "Invoice",
        showsMaterialPricing = false,
        showsQuantitiesOnly = false,
        showsContractTerms = false,
        showsPaymentStatus = true
    );

    /** True when this document leaves the building. */
    val isExternal: Boolean get() = this != WORKING_ESTIMATE

}

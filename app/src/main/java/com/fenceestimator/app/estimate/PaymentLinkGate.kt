package com.fenceestimator.app.estimate

import com.fenceestimator.app.cloud.UserRole

/**
 * MAY THIS PHONE MINT A NEW PAYMENT LINK?
 *
 * ONE PREDICATE, BECAUSE THERE IS NOW MORE THAN ONE PLACE THAT MINTS. The
 * payment card's "Request by card" button was the only one; sending a quote
 * with a Pay here button is the second. Writing the condition out twice is how
 * the two drift: one of them gains a check the other does not, and the one
 * that was forgotten is the one that bills a customer. So the decision lives
 * here, is called from both, and is tested on its own.
 *
 * MINTING A LINK IS MONEY MOVING, not money displayed. Nothing here hides a
 * balance: the contract total, what has been paid, what is still owed, an
 * existing link and the stale-link warning are all outside this gate and stay
 * visible to Sales and Accountant exactly as before. Seeing a balance is not
 * the same thing as being able to bill it.
 *
 * THREE CONDITIONS, AND EACH ONE IS LOAD-BEARING:
 *
 *  - [cardPaymentsAllowed] -- the plan entitlement. Card payments are a Crew
 *    plan feature; without it the phone must not create a checkout at all.
 *
 *  - [canRequestPayment] -- the REQUEST_PAYMENT permission as this phone has
 *    resolved it, INCLUDING an owner's per-person revocation. The server never
 *    looks at a per-person override here -- role alone decides there -- so an
 *    owner who has deliberately taken REQUEST_PAYMENT off one specific Owner-
 *    or Manager-role account has that revocation respected only because this
 *    check exists.
 *
 *  - [role] -- literally Owner or Manager, which is what the edge function
 *    itself tests. The permission alone is NOT a substitute: has_permission()
 *    grants REQUEST_PAYMENT to ACCOUNTANT by default, and the function would
 *    still refuse an Accountant who holds it. Gating on the permission alone
 *    is the same mismatch one step over, moved from a role name to a
 *    permission name.
 *
 * Every condition can only narrow this further than the server's own rule,
 * never reopen it.
 */
object PaymentLinkGate {

    /** The roles the edge function itself accepts. */
    private val MAY_BILL = setOf(UserRole.OWNER, UserRole.MANAGER)

    fun mayMint(cardPaymentsAllowed: Boolean, canRequestPayment: Boolean, role: UserRole): Boolean =
        cardPaymentsAllowed && canRequestPayment && role in MAY_BILL
}

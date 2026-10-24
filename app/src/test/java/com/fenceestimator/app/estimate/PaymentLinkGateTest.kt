package com.fenceestimator.app.estimate

import com.fenceestimator.app.cloud.UserRole
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The gate on minting a payment link, which is the act of asking a customer
 * for money. Tested on its own because it is now called from two places -- the
 * payment card and the quote email's Pay here button -- and the failure this
 * guards against is a crew member's phone quietly creating a live checkout.
 */
class PaymentLinkGateTest {

    private fun mint(
        entitled: Boolean = true,
        permitted: Boolean = true,
        role: UserRole = UserRole.OWNER,
    ) = PaymentLinkGate.mayMint(entitled, permitted, role)

    @Test
    fun `an owner or manager with the permission and the plan may mint`() {
        assertTrue(mint(role = UserRole.OWNER))
        assertTrue(mint(role = UserRole.MANAGER))
    }

    @Test
    fun `no other role may mint, whatever permission it holds`() {
        // Each of these is a role that can legitimately SEE the money and must
        // still not be able to bill it.
        for (role in listOf(UserRole.SALES, UserRole.ACCOUNTANT, UserRole.FOREMAN, UserRole.CREW)) {
            assertFalse("$role must not mint a payment link", mint(role = role))
        }
    }

    @Test
    fun `a per-person revocation is respected even for an owner`() {
        // The server never looks at a per-person override here -- role alone
        // decides there -- so this check is the ONLY thing that honours an
        // owner having taken REQUEST_PAYMENT off one specific account.
        assertFalse(mint(permitted = false, role = UserRole.OWNER))
        assertFalse(mint(permitted = false, role = UserRole.MANAGER))
    }

    @Test
    fun `without the plan entitlement nobody mints`() {
        assertFalse(mint(entitled = false, role = UserRole.OWNER))
        assertFalse(mint(entitled = false, role = UserRole.MANAGER))
    }

    @Test
    fun `CANARY -- gating on the permission alone would let an accountant bill`() {
        // The mistake this gate exists to avoid, written out so it cannot be
        // reintroduced as a "simplification": has_permission() grants
        // REQUEST_PAYMENT to ACCOUNTANT by default, and the edge function
        // would refuse that account anyway. If this ever stops differing from
        // mayMint, the role half of the gate has been dropped.
        val permissionOnly = true   // what `session.canRequestPayment` alone says
        assertTrue(
            "THE CANARY DID NOT FIRE: the permission alone no longer admits an accountant",
            permissionOnly,
        )
        assertFalse(
            "the real gate must still refuse an accountant",
            mint(role = UserRole.ACCOUNTANT),
        )
    }
}

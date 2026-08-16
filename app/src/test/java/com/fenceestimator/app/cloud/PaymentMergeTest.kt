package com.fenceestimator.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A cleared payment must never be lost to a sync race.
 *
 * The failure this guards against was real and silent: the job screen was
 * open, so the local row was "newer", so plain last-edit-wins pushed a stale
 * copy over a payment the webhook had just recorded. The customer had paid,
 * Stripe had the money, and the app showed them still owing it.
 */
class PaymentMergeTest {

    @Test
    fun `a payment that cleared in the cloud survives a newer local edit`() {
        // Phone thinks nothing is paid; Stripe has taken $500.
        assertEquals(500.0, JobSync.mergedAmountPaid(localPaid = 0.0, cloudPaid = 500.0), 0.001)
    }

    @Test
    fun `a payment recorded on the phone survives an older cloud row`() {
        // Cash taken on site and typed in, before the cloud knows about it.
        assertEquals(300.0, JobSync.mergedAmountPaid(localPaid = 300.0, cloudPaid = 0.0), 0.001)
    }

    @Test
    fun `two payments do not cancel each other out`() {
        // Deposit banked in the cloud, cash added locally: the larger stands,
        // and the smaller is never allowed to erase it.
        assertEquals(900.0, JobSync.mergedAmountPaid(localPaid = 400.0, cloudPaid = 900.0), 0.001)
        assertEquals(900.0, JobSync.mergedAmountPaid(localPaid = 900.0, cloudPaid = 400.0), 0.001)
    }

    @Test
    fun `equal figures stay put`() {
        assertEquals(750.0, JobSync.mergedAmountPaid(750.0, 750.0), 0.001)
    }

    @Test
    fun `nothing paid stays nothing`() {
        assertEquals(0.0, JobSync.mergedAmountPaid(0.0, 0.0), 0.001)
    }
}

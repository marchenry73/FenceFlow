package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * A pull must update the job, not replace it.
 *
 * `CloudJob` carries 33 of the Job's 53 columns. The pull used to build a brand
 * new Job from it and keep only the local id, so the other twenty reverted to
 * their defaults: the survey image, the calibration every footage calculation
 * depends on, the customer's signature, the live payment link.
 *
 * That branch never actually ran, because cloud timestamps were being misparsed
 * as epoch 0 and so no cloud row ever looked newer. Fixing the parsing is what
 * would have armed it. These tests keep it disarmed.
 */
class JobMergeTest {

    private fun localJob() = Job(
        id = 7,
        syncId = "job-1",
        customerName = "Old Name",
        amountPaid = 500.0,
        // The device-local fields that a naive pull wiped.
        surveyImagePath = "/data/surveys/job7.jpg",
        calibrationPixelsPerFoot = 18.5f,
        signatureImagePath = "/data/signatures/job7.png",
        paymentLinkUrl = "https://checkout.stripe.com/abc",
        gateRatePerFt = 20.0,
        trashHaulFee = 175.0,
        gridFeetPerSquare = 2.5f,
        pricingTierName = "Premium",
        updatedAt = 1_000L
    )

    private fun cloudJob() = CloudJob(
        syncId = "job-1",
        companyId = "co-1",
        customerName = "New Name",
        amountPaid = 500.0,
        updatedAt = "2026-08-16T04:05:06.631429+00:00"
    )

    @Test
    fun `shared fields come down from the cloud`() {
        val merged = cloudJob().mergeOnto(localJob())
        assertEquals("New Name", merged.customerName)
    }

    @Test
    fun `the local row identity is kept`() {
        assertEquals(7L, cloudJob().mergeOnto(localJob()).id)
        assertEquals("job-1", cloudJob().mergeOnto(localJob()).syncId)
    }

    @Test
    fun `calibration survives a pull`() {
        // Without this the takeoff silently re-measures every fence on the job.
        assertEquals(18.5f, cloudJob().mergeOnto(localJob()).calibrationPixelsPerFoot)
    }

    @Test
    fun `the survey drawing and the signature survive a pull`() {
        val merged = cloudJob().mergeOnto(localJob())
        assertEquals("/data/surveys/job7.jpg", merged.surveyImagePath)
        assertEquals("/data/signatures/job7.png", merged.signatureImagePath)
    }

    @Test
    fun `the live payment link survives a pull`() {
        assertEquals("https://checkout.stripe.com/abc", cloudJob().mergeOnto(localJob()).paymentLinkUrl)
    }

    @Test
    fun `job-level pricing the cloud does not carry survives a pull`() {
        val merged = cloudJob().mergeOnto(localJob())
        assertEquals(20.0, merged.gateRatePerFt, 0.001)
        assertEquals(175.0, merged.trashHaulFee, 0.001)
        assertEquals(2.5f, merged.gridFeetPerSquare)
        assertEquals("Premium", merged.pricingTierName)
    }

    @Test
    fun `a cleared payment is never undone by a newer cloud row`() {
        val stale = cloudJob().copy(amountPaid = 0.0)
        assertEquals(500.0, stale.mergeOnto(localJob()).amountPaid, 0.001)
    }

    @Test
    fun `a larger cloud payment is taken`() {
        val paid = cloudJob().copy(amountPaid = 1200.0)
        assertEquals(1200.0, paid.mergeOnto(localJob()).amountPaid, 0.001)
    }

    @Test
    fun `the cloud timestamp is adopted so the row is not pushed straight back`() {
        // If updatedAt stayed local-and-older, the very next pass would treat
        // this row as unsynced work and push it up again, forever.
        assertEquals(1786853106631L, cloudJob().mergeOnto(localJob()).updatedAt)
    }

    @Test
    fun `an unreadable status leaves the local one alone`() {
        val junk = cloudJob().copy(status = "NOT_A_STATUS")
        assertEquals(localJob().status, junk.mergeOnto(localJob()).status)
    }
}

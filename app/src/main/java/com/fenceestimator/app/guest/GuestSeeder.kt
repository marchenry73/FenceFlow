package com.fenceestimator.app.guest

import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.Repository

/**
 * Fills a guest session with a small, believable business: a handful of jobs
 * sitting at different points in the pipeline, with real-looking numbers, so
 * opening the app for the first time shows what it actually does instead of
 * an empty list.
 *
 * Every job this writes carries both of GuestMarker's markers. That is not
 * decoration -- GuestWipe deletes by those markers alone when the session
 * ends, so a row this function writes without them would survive the wipe,
 * and a row anything else writes that happened to carry them would not.
 * Real entities only (Job, EstimateLineItem, straight off Entities.kt) --
 * nothing here invents a shape the rest of the app doesn't already use, so a
 * guest can open one of these jobs and draw, price and view it exactly like
 * a real one.
 */
object GuestSeeder {
    suspend fun seed(repository: Repository) {
        val now = System.currentTimeMillis()
        val day = 86_400_000L

        val finished = Job(
            customerName = GuestMarker.mark("Maria Ramirez"),
            address = "482 Willow Creek Dr, Sample City, TX 75001",
            phone = "555-0142",
            email = "demo@example.com",
            status = JobStatus.COMPLETED,
            referralSource = GuestMarker.REFERRAL_TAG,
            createdAt = now - 21 * day,
            updatedAt = now - 14 * day,
            taxRatePercent = 8.25,
            laborRatePerFt = 9.0,
            markupPercent = 15.0,
            paymentStatus = PaymentStatus.PAID_IN_FULL,
            isInvoiced = true,
            depositAmount = 900.0,
            amountPaid = 4485.0,
            signedContractTotal = 4485.0,
            signedLinearFeet = 180f
        )

        val inProgress = Job(
            customerName = GuestMarker.mark("David Chen"),
            address = "17 Maple Court, Sample City, TX 75001",
            phone = "555-0177",
            email = "demo@example.com",
            status = JobStatus.ACCEPTED,
            referralSource = GuestMarker.REFERRAL_TAG,
            createdAt = now - 4 * day,
            updatedAt = now - 2 * day,
            taxRatePercent = 8.25,
            laborRatePerFt = 9.0,
            markupPercent = 15.0,
            paymentStatus = PaymentStatus.DEPOSIT_PAID,
            depositAmount = 650.0,
            scheduledDate = now + 5 * day,
            signedContractTotal = 3250.0,
            signedLinearFeet = 130f
        )

        val quoted = Job(
            customerName = GuestMarker.mark("Sunil Patel"),
            address = "930 Oak Hollow Ln, Sample City, TX 75002",
            phone = "555-0118",
            email = "demo@example.com",
            status = JobStatus.SENT,
            referralSource = GuestMarker.REFERRAL_TAG,
            createdAt = now - day,
            updatedAt = now - day,
            taxRatePercent = 8.25,
            laborRatePerFt = 9.0,
            markupPercent = 15.0,
            paymentStatus = PaymentStatus.UNPAID
        )

        val finishedId = repository.createJob(finished)
        repository.createJob(inProgress)
        repository.createJob(quoted)

        // A couple of priced line items on the finished job, so opening it
        // shows a real-looking breakdown rather than a blank estimate.
        repository.saveLineItem(
            EstimateLineItem(
                jobId = finishedId,
                description = "6 ft Vinyl Privacy Panel",
                quantity = 30.0,
                unit = "PANEL",
                unitPrice = 89.0,
                role = MaterialRole.PANEL
            )
        )
        repository.saveLineItem(
            EstimateLineItem(
                jobId = finishedId,
                description = "Labor - Install",
                quantity = 180.0,
                unit = "FT",
                unitPrice = 9.0,
                role = MaterialRole.NONE
            )
        )
    }
}

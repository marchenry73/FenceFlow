package com.fenceestimator.app.cloud

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The crew door for jobs: a DENIED phone must never insert a job (there is
 * no insert path on the server either -- `crew_save_job` is UPDATE-only),
 * and must never send a money key even in the one write it IS allowed to
 * make.
 */
class JobSyncCrewDoorTest {

    private fun sampleCloudJob() = CloudJob(
        syncId = "job-1",
        companyId = "co-1",
        customerName = "Jane Homeowner",
        notes = "gate sticks",
        status = "IN_PROGRESS",
        taxRatePercent = 7.25,
        markupPercent = 18.0,
        amountPaid = 4200.0,
        contractTotal = 9800.0,
        paymentStatus = "PARTIAL",
        quoteSentAt = "2026-08-01T00:00:00Z"
    )

    @Test
    fun `no MONEY_KEYS key survives into the crew_save_job payload`() {
        val payload = buildCrewSaveJobPayload(sampleCloudJob())
        MONEY_KEYS.forEach { key ->
            assertFalse("crew_save_job's row_in must never carry '$key'", payload.containsKey(key))
        }
    }

    @Test
    fun `everything else about the job still travels`() {
        val payload = buildCrewSaveJobPayload(sampleCloudJob())
        assertTrue(payload.containsKey("sync_id"))
        assertTrue(payload.containsKey("customer_name"))
        assertTrue(payload.containsKey("notes"))
        assertTrue(payload.containsKey("status"))
    }

    /**
     * Reads the source rather than running the sync -- JobSync.sync() talks
     * to a real Supabase client with no seam this test suite can fake (the
     * same tradeoff PullFiltersDeletedTest makes on the pull side, for the
     * same reason). What has to be true structurally: the DENIED branch of
     * "cloudJob == null" never reaches an insert.
     */
    @Test
    fun `the DENIED branch of a job unknown to the cloud never inserts`() {
        val source = File("src/main/java/com/fenceestimator/app/cloud/JobSync.kt").readText()

        val blockStart = source.indexOf("if (cloudJob == null) {")
        assertTrue("could not find the cloudJob == null branch in JobSync.kt -- " +
            "if it moved, update this test with it rather than deleting it.", blockStart >= 0)
        val blockEnd = source.indexOf("} else if (job.updatedAt > cloudJob.updatedAtMillis())", blockStart)
        assertTrue("could not find the end of the cloudJob == null branch", blockEnd > blockStart)
        val block = source.substring(blockStart, blockEnd)

        val deniedStart = block.indexOf("if (scope == MoneyScope.DENIED) {")
        assertTrue("could not find the DENIED branch inside cloudJob == null", deniedStart >= 0)
        val elseStart = block.indexOf("} else {", deniedStart)
        assertTrue("could not find the ALLOWED else-branch inside cloudJob == null", elseStart >= 0)

        val deniedBranch = block.substring(deniedStart, elseStart)
        val allowedBranch = block.substring(elseStart)

        assertFalse(
            "a DENIED phone must never insert a job -- there is no crew insert path on the server either",
            deniedBranch.contains(".insert(")
        )
        assertTrue(
            "the ALLOWED branch should still insert new jobs exactly as before",
            allowedBranch.contains(".insert(")
        )
    }

    /**
     * Same shape of check on the other job-write branch: a DENIED phone's
     * newer-locally push must go through crew_save_job, never the base
     * table's own .update(...).
     */
    @Test
    fun `the DENIED branch of an ordinary edit never updates the base jobs table directly`() {
        val source = File("src/main/java/com/fenceestimator/app/cloud/JobSync.kt").readText()

        val blockStart = source.indexOf("} else if (job.updatedAt > cloudJob.updatedAtMillis()) {")
        assertTrue("could not find the newer-locally branch in JobSync.kt", blockStart >= 0)
        val blockEnd = source.indexOf("val incoming = mutableListOf<IncomingChange>()", blockStart)
        assertTrue("could not find the end of the newer-locally branch", blockEnd > blockStart)
        val block = source.substring(blockStart, blockEnd)

        val deniedStart = block.indexOf("if (scope == MoneyScope.DENIED) {")
        assertTrue("could not find the DENIED branch inside the newer-locally push", deniedStart >= 0)
        val elseStart = block.indexOf("} else {", deniedStart)
        assertTrue("could not find the ALLOWED else-branch inside the newer-locally push", elseStart >= 0)

        val deniedBranch = block.substring(deniedStart, elseStart)
        val allowedBranch = block.substring(elseStart)

        assertTrue(
            "a DENIED phone's edit must go through crew_save_job",
            deniedBranch.contains("\"crew_save_job\"")
        )
        assertFalse(
            "a DENIED phone must never PATCH the base jobs table directly",
            deniedBranch.contains(".from(\"jobs\").update(")
        )
        assertTrue(
            "the ALLOWED branch should still PATCH the base table exactly as before",
            allowedBranch.contains(".from(\"jobs\").update(")
        )
    }
}

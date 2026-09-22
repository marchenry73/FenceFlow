package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.JobStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What a pulled status change is announced as (see [statusChangeKind]).
 *
 * The pull tested ACCEPTED and announced it as completion, so every signed
 * quote told the owner "Job marked complete -- was finished by the crew" for
 * a fence nobody had started. ACCEPTED is the customer saying yes; COMPLETED
 * is the fence in the ground.
 */
class StatusChangeKindTest {

    @Test
    fun `a quote the customer accepted is announced as accepted, never as finished`() {
        assertEquals(ChangeKind.QUOTE_ACCEPTED, statusChangeKind(JobStatus.SENT, "ACCEPTED"))
        assertEquals(ChangeKind.QUOTE_ACCEPTED, statusChangeKind(JobStatus.DRAFT, "ACCEPTED"))
    }

    @Test
    fun `a job the crew finished is announced as complete`() {
        assertEquals(ChangeKind.MARKED_COMPLETE, statusChangeKind(JobStatus.ACCEPTED, "COMPLETED"))
        assertEquals(ChangeKind.MARKED_COMPLETE, statusChangeKind(JobStatus.SENT, "COMPLETED"))
    }

    @Test
    fun `nothing new is announced when the status did not move forward`() {
        assertEquals(ChangeKind.UPDATED, statusChangeKind(JobStatus.ACCEPTED, "ACCEPTED"))
        assertEquals(ChangeKind.UPDATED, statusChangeKind(JobStatus.COMPLETED, "COMPLETED"))
        // A phone behind the office: already finished here, the cloud still says accepted.
        assertEquals(ChangeKind.UPDATED, statusChangeKind(JobStatus.COMPLETED, "ACCEPTED"))
        assertEquals(ChangeKind.UPDATED, statusChangeKind(JobStatus.SENT, "DECLINED"))
    }

    @Test
    fun `a status this build does not know is an ordinary update`() {
        assertEquals(ChangeKind.UPDATED, statusChangeKind(JobStatus.SENT, "ON_HOLD"))
        assertEquals(ChangeKind.UPDATED, statusChangeKind(JobStatus.SENT, ""))
    }

    /**
     * The words, in every language the app ships: an accepted quote names the
     * customer and says "accepted", and never borrows the completion sentence.
     * AutoSync.notifyIncoming is what picks them; it needs a Context, so the
     * pairing is read from its source.
     */
    @Test
    fun `an accepted quote is worded as accepted in English, Spanish and French`() {
        val res = listOf(java.io.File("src/main/res"), java.io.File("app/src/main/res")).first { it.isDirectory }
        val expected = mapOf("values" to "accepted", "values-es" to "acept", "values-fr" to "accept")
        expected.forEach { (dir, word) ->
            val xml = java.io.File(res, "$dir/strings.xml").readText()
            fun string(name: String) = Regex("<string name=\"$name\">([^<]*)</string>").find(xml)?.groupValues?.get(1)
                ?: error("$dir has no $name")
            val title = string("ntf_quote_accepted_title")
            val body = string("ntf_quote_accepted_body")
            assertTrue("$dir title: $title", title.contains(word, ignoreCase = true))
            assertTrue("$dir body names the customer: $body", body.contains("%1\$s"))
            assertTrue("$dir body: $body", body.contains(word, ignoreCase = true))
            assertFalse("$dir must not reuse the completion sentence", body == string("ntf_job_complete_body"))
        }
        val src = listOf(
            java.io.File("src/main/java/com/fenceestimator/app/cloud/AutoSync.kt"),
            java.io.File("app/src/main/java/com/fenceestimator/app/cloud/AutoSync.kt")
        ).first { it.isFile }.readText()
        val branch = src.substringAfter("ChangeKind.QUOTE_ACCEPTED ->").substringBefore("ChangeKind.ASSIGNED_TO_ME")
        assertTrue(branch, branch.contains("R.string.ntf_quote_accepted_title") && branch.contains("R.string.ntf_quote_accepted_body"))
        val complete = src.substringAfter("ChangeKind.MARKED_COMPLETE ->").substringBefore("ChangeKind.QUOTE_ACCEPTED")
        assertTrue(complete, complete.contains("R.string.ntf_job_complete_title"))
    }
}

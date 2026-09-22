package com.fenceestimator.app.cloud

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

/**
 * `my_job_scope()`'s answer, folded the way the sync acts on it
 * ([foldJobScopeAnswer]). What is at stake: a SCOPED answer hides every job
 * the crew door did not return, so a failed question must never come out as
 * one -- and a database without the crew-scope SQL must come out as "sees
 * everything", which is what every phone did before it.
 *
 * The failures are the library's real exception types with the sentences
 * production answered on 2026-09-22, before the SQL was applied.
 */
class JobScopeAnswerTest {

    private val errors = RealRestErrors()

    @After
    fun tearDown() = errors.close()

    private fun scoped(linked: Boolean = true, visible: Int = 4, pending: Int = 1) = buildJsonObject {
        put("sees_all", false)
        put("linked", linked)
        put("visible", visible)
        put("pending_requests", pending)
    }

    private fun fold(answer: JsonElement) = foldJobScopeAnswer(Result.success(answer))
    private fun foldFailure(e: Throwable) = foldJobScopeAnswer(Result.failure(e))

    // The two sentences production answered for a function and a table the
    // SQL creates, read with curl before it was applied.
    private val missingFunction = "Could not find the function public.my_job_scope without parameters in the schema cache"
    private val missingTable = "Could not find the table 'public.job_assignments' in the schema cache"

    // ---- real answers ----

    @Test
    fun `someone who sees every job`() {
        assertSame(JobScope.SeesAll, fold(buildJsonObject { put("sees_all", true); put("linked", false); put("visible", 0); put("pending_requests", 0) }))
    }

    @Test
    fun `a scoped crew member, every field carried`() {
        assertEquals(JobScope.Scoped(linked = true, visible = 4, pendingRequests = 1), fold(scoped()))
    }

    @Test
    fun `an unlinked login is scoped and says so -- not a failure`() {
        val answer = fold(scoped(linked = false, visible = 0, pending = 0))
        assertEquals(JobScope.Scoped(linked = false, visible = 0, pendingRequests = 0), answer)
        assertTrue(answer.isDeployed)
        assertFalse(answer.seesEverything)
    }

    @Test
    fun `no company -- the function answers null -- decides nothing`() {
        assertSame(JobScope.Unknown, fold(JsonNull))
    }

    @Test
    fun `a shape this build cannot read decides nothing`() {
        assertSame(JobScope.Unknown, fold(JsonPrimitive(true)))
        assertSame(JobScope.Unknown, fold(buildJsonObject { put("linked", true) }))
    }

    // `visible` is what stops a crew phone hiding every job over an empty
    // door (planJobHolds), so a missing one must not be read as zero.
    @Test
    fun `a scoped answer missing visible is Unknown, not zero visible`() {
        val noVisible = buildJsonObject { put("sees_all", false); put("linked", true); put("pending_requests", 0) }
        assertSame(JobScope.Unknown, fold(noVisible))
        // Planted failure: the same answer with visible in it is read.
        assertTrue(fold(scoped(visible = 0)) is JobScope.Scoped)
    }

    // ---- failures ----

    @Test
    fun `the function not existing yet is NotDeployed -- everyone sees everything`() {
        val answer = foldFailure(errors.of(404, missingFunction, rpc = "my_job_scope"))
        assertSame(JobScope.NotDeployed, answer)
        assertTrue(answer.seesEverything)
        assertFalse(answer.isDeployed)
    }

    @Test
    fun `recognised by the sentence too, if the status is not to hand`() {
        assertSame(JobScope.NotDeployed, foldFailure(RuntimeException("rpc failed", IllegalStateException(missingFunction))))
        assertTrue(isNotDeployedYet(errors.of(404, missingTable)))
        assertTrue(isNotDeployedYet(IllegalStateException("relation \"public.job_assignments\" does not exist")))
    }

    @Test
    fun `no signal is Unknown`() {
        assertSame(JobScope.Unknown, foldFailure(IOException("Unable to resolve host example.supabase.co")))
    }

    @Test
    fun `a server error is Unknown, never scoped`() {
        assertSame(JobScope.Unknown, foldFailure(errors.of(500, "canceling statement due to statement timeout")))
        assertSame(JobScope.Unknown, foldFailure(errors.of(401, "JWT expired", rpc = "my_job_scope")))
    }

    // Planted failure: a fold that took any failure as "sees everything" would
    // pass the NotDeployed case above -- this is the case that tells them apart.
    @Test
    fun `a permission refusal is not mistaken for a missing function`() {
        val refused = errors.of(403, "permission denied for function my_job_scope", rpc = "my_job_scope")
        assertFalse(isNotDeployedYet(refused))
        assertNotEquals(JobScope.NotDeployed, foldFailure(refused))
    }

    // ---- what the states mean to the rest of the app ----

    @Test
    fun `only a server that has the change is deployed`() {
        assertTrue(JobScope.SeesAll.isDeployed)
        assertTrue(JobScope.Scoped(true, 1, 0).isDeployed)
        assertFalse(JobScope.NotDeployed.isDeployed)
        assertFalse(JobScope.Unknown.isDeployed)
        // Unknown is not "sees everything" either -- it is nothing at all.
        assertFalse(JobScope.Unknown.seesEverything)
    }
}

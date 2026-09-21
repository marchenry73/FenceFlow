package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.TimeEntry
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Test
import java.time.Instant

/**
 * What the time_entries push actually puts on the wire, through the exact Json
 * the phone sends with ([cloudJson]).
 *
 * From 1.470 the push's second pass was an upsert with started_at left out of
 * the body. Postgres checks NOT NULL on the proposed row before ON CONFLICT is
 * consulted, so that statement was refused 23502 for every shift, stored or
 * not -- proved in a rolled-back transaction on 2026-09-21, in PostgREST's own
 * statement shape, as a MANAGER and as a CREW member. These tests pin the two
 * shapes that replaced it: a shift row that always carries its clock, and a
 * PATCH that carries the worker and nothing else.
 */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
class TimeEntryPushShapeTest {

    private val start = Instant.parse("2026-09-18T12:00:00Z").toEpochMilli()
    private val end = Instant.parse("2026-09-18T20:00:00Z").toEpochMilli()

    private fun shift(breakMinutes: Int? = null) = TimeEntry(
        syncId = "shift-1", jobId = 1L, employeeId = 3L,
        startedAt = start, endedAt = end, hourlyRate = 21.0, notes = "gate side",
        breakMinutes = breakMinutes
    )

    private fun insertJson(entry: TimeEntry) =
        cloudJson.encodeToJsonElement(CloudTimeEntryPush.serializer(), entry.toInsertRow("co-1", "job-1", "emp-1")).jsonObject

    @Test
    fun `a shift row always carries the clock it was recorded with`() {
        val json = insertJson(shift())
        assertEquals(Instant.ofEpochMilli(start).toString(), json["started_at"]?.jsonPrimitive?.content)
        assertEquals(Instant.ofEpochMilli(end).toString(), json["ended_at"]?.jsonPrimitive?.content)
        assertEquals("emp-1", json["employee_sync_id"]?.jsonPrimitive?.content)
    }

    @Test
    fun `no break recorded stays out of the body, a break of zero does not`() {
        assertFalse("null break must be omitted, not sent", insertJson(shift(breakMinutes = null)).containsKey("break_minutes"))
        assertEquals("0", insertJson(shift(breakMinutes = 0))["break_minutes"]?.jsonPrimitive?.content)
    }

    /**
     * The regression guard. If started_at ever regains a null default, an
     * "update pass" that drops it becomes possible again -- and so does the
     * 23502 on every shift.
     */
    @Test
    fun `started_at can never be left out of a shift row`() {
        val descriptor = CloudTimeEntryPush.serializer().descriptor
        val i = descriptor.getElementIndex("started_at")
        assertFalse("started_at must have no default", descriptor.isElementOptional(i))
        assertFalse("started_at must not be nullable", descriptor.getElementDescriptor(i).isNullable)
    }

    // Planted failure, proving the guard above has teeth: the body the old
    // update pass sent -- six keys, no started_at -- cannot even be read back
    // into the class any more, let alone built from it.
    @Test
    fun `the old update pass's body is not a shift row`() {
        val oldUpdatePassBody = """
            {"company_id":"co-1","sync_id":"shift-1","job_sync_id":"job-1",
             "hourly_rate":21.0,"employee_sync_id":"emp-1","notes":"gate side"}
        """.trimIndent()
        assertThrows(SerializationException::class.java) {
            cloudJson.decodeFromString(CloudTimeEntryPush.serializer(), oldUpdatePassBody)
        }
    }

    @Test
    fun `the worker PATCH names one column and nothing else`() {
        val json = cloudJson.encodeToJsonElement(
            CloudTimeEntryWorkerPatch.serializer(), CloudTimeEntryWorkerPatch(employeeSyncId = "emp-2")
        ).jsonObject
        // No started_at/ended_at/break (the office's corrections stand), no
        // notes, no hourly_rate (stamp_time_entry_rate's), no decision
        // (approve_time_entry's), no company_id/sync_id (the filter's).
        assertEquals(setOf("employee_sync_id"), json.keys)
        assertEquals("emp-2", json["employee_sync_id"]?.jsonPrimitive?.content)
    }

    @Test
    fun `a Fix produces that PATCH, an untouched shift produces none`() {
        val fixed = shift().copy(workerChangedAt = end + 1)
        assertEquals(CloudTimeEntryWorkerPatch("emp-2"), workerChangeToSend(fixed, "emp-2"))
        // Planted: without the stamp there is nothing to send -- the push
        // must not rewrite every shift on every sync again.
        assertEquals(null, workerChangeToSend(shift(), "emp-2"))
    }
}

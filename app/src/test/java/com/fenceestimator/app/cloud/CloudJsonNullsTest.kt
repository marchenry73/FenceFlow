package com.fenceestimator.app.cloud

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Real server rows, with the nulls the live schema allows, through the exact
 * Json the phone decodes with ([cloudJson]).
 *
 * time_entries.correction_reason is nullable and null on 7 rows in 8, and
 * one such row killed the whole time_entries pull on every sync from 1.445
 * to 1.501: "Expected string literal but 'null' literal was found at path
 * $[0].correction_reason". The planted-failure test proves the same row
 * still does that through a Json without coerceInputValues, so a pass here
 * is the configuration and not the fixture.
 */
class CloudJsonNullsTest {

    private val timeEntryRows = """
        [{"company_id":"c1","sync_id":"s1","job_sync_id":"j1",
          "started_at":"2026-09-18T12:00:00+00:00","ended_at":null,
          "hourly_rate":0,"employee_sync_id":"","notes":"","approved_at":null,
          "approved_by":"","rejected_at":null,"review_note":"",
          "original_started_at":null,"original_ended_at":null,"corrected_at":null,
          "correction_reason":null,"break_minutes":null,
          "break_started_at":null,"break_ended_at":null,
          "a_column_this_build_does_not_know":"ignored"}]
    """.trimIndent()

    @Test
    fun `a null correction_reason decodes to the empty default`() {
        val rows = cloudJson.decodeFromString<List<CloudTimeEntry>>(timeEntryRows)
        assertEquals(1, rows.size)
        assertEquals("", rows.single().correctionReason)
        assertEquals("s1", rows.single().syncId)
    }

    // Planted failure: the configuration the phone shipped with, minus the
    // one flag, on the very same row. If this ever stops throwing, the test
    // above has stopped proving anything.
    @Test
    fun `without coerceInputValues the same row kills the decode`() {
        val before = Json { encodeDefaults = true; ignoreUnknownKeys = true; explicitNulls = false }
        assertThrows(SerializationException::class.java) {
            before.decodeFromString<List<CloudTimeEntry>>(timeEntryRows)
        }
    }

    /**
     * Identity columns the live schema allows to be null (employees.sync_id,
     * expenses.sync_id/job_sync_id, punch_list_items.sync_id/job_sync_id,
     * checked 2026-09-18). They decode to "" and the pull skips them, rather
     * than one null row taking the whole table down.
     */
    @Test
    fun `identity columns the server allows to be null decode rather than throw`() {
        val employee = cloudJson.decodeFromString<CloudEmployee>("""{"company_id":"c1","sync_id":null,"name":"Ana"}""")
        assertEquals("", employee.syncId)
        val roster = cloudJson.decodeFromString<CrewRosterRow>("""{"id":null,"sync_id":null,"name":"Ana"}""")
        assertEquals("", roster.syncId)
        val expense = cloudJson.decodeFromString<CloudExpense>("""{"company_id":"c1","sync_id":null,"job_sync_id":null}""")
        assertEquals("", expense.syncId)
        assertEquals("", expense.jobSyncId)
        val punch = cloudJson.decodeFromString<CloudPunchItem>("""{"company_id":"c1","sync_id":null,"job_sync_id":null}""")
        assertEquals("", punch.syncId)
        assertEquals("", punch.jobSyncId)
    }

    // Planted failure: a null for a non-null field WITHOUT a default is still
    // a decode error, coerceInputValues or not -- which is exactly why the
    // identity fields above had to be given one.
    @Test
    fun `a null for a field with no default still throws`() {
        assertThrows(SerializationException::class.java) {
            cloudJson.decodeFromString<CloudTimeEntry>(
                """{"company_id":"c1","sync_id":"s1","job_sync_id":null,"started_at":"2026-09-18T12:00:00+00:00"}"""
            )
        }
    }
}

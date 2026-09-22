package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Job
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The crew door for jobs: a DENIED phone must never insert a job (there is
 * no insert path on the server either -- `crew_save_job` is UPDATE-only),
 * must never send a money key even in the one write it IS allowed to make,
 * and since 2026-09-21 sends ONLY the columns crew may change
 * ([CREW_WRITABLE_JOB_KEYS]) -- never its whole copy of the row.
 *
 * The whole-row payload is what blanked the office's notes, HOA and permit
 * details from a crew phone's older copy, stamped priced_by = '' over a real
 * pricing record (10b0407f), and carried a crew-typed customer name that the
 * server put back while still moving updated_at -- so the next pull wrote a
 * blank name over the crew phone (4598150b).
 */
class JobSyncCrewDoorTest {

    private fun sampleCloudJob(status: String = "IN_PROGRESS") = CloudJob(
        syncId = "job-1",
        companyId = "co-1",
        customerName = "Jane Homeowner",
        address = "12 Oak St",
        phone = "555-0100",
        email = "jane@example.com",
        notes = "gate sticks",
        status = status,
        referralSource = "Yard sign",
        scheduledDate = "2026-09-30T08:00:00Z",
        estimatedDurationHours = 93.33,
        durationManuallySet = false,
        taxRatePercent = 7.25,
        markupPercent = 18.0,
        amountPaid = 4200.0,
        contractTotal = 9800.0,
        paymentStatus = "PARTIAL",
        quoteSentAt = "2026-08-01T00:00:00Z",
        hoaName = "Oak HOA",
        hoaEmail = "board@oakhoa.example",
        permitNumber = "P-123",
        wastePercent = 10.0,
        teardownEnabled = true,
        assignedEmployeeSyncId = "emp-1",
        preferredManufacturerSyncId = "man-1",
        buildTemplateSyncId = "tpl-1",
        acceptedTotal = 9710.0,
        // The crew-writable field work that must still travel.
        blockedReason = "Customer's dog in the yard",
        locateTicketNo = "T-778",
        locateNotes = "gas line marked on the east side",
        teardownFeet = 80.0,
        calibrationPixelsPerFoot = 18.5f,
        siteLat = 27.8,
        siteLon = -82.4,
        finalSignOffStoragePath = "co-1/job-1/final.png"
    )

    // ---- money: the original guarantee, unchanged ----

    @Test
    fun `no MONEY_KEYS key survives into the crew_save_job payload`() {
        for (mayReschedule in listOf(false, true)) {
            val payload = buildCrewSaveJobPayload(sampleCloudJob(), mayReschedule)
            MONEY_KEYS.forEach { key ->
                assertFalse("crew_save_job's row_in must never carry '$key'", payload.containsKey(key))
            }
        }
    }

    // ---- the allowlist ----

    @Test
    fun `only sync_id and crew-writable columns travel`() {
        val payload = buildCrewSaveJobPayload(sampleCloudJob())
        val unexpected = payload.keys - CREW_WRITABLE_JOB_KEYS - "sync_id"
        assertTrue("crew_save_job's row_in carries columns crew may not write: $unexpected", unexpected.isEmpty())
        assertTrue(payload.containsKey("sync_id"))
    }

    @Test
    fun `office columns a crew phone used to blank are absent`() {
        val payload = buildCrewSaveJobPayload(sampleCloudJob())
        listOf(
            "customer_name", "address", "phone", "email", "hoa_email", "notes", "referral_source",
            "hoa_name", "hoa_approval_status", "permit_number", "permit_status",
            "priced_by", "pricing_engine_version", "priced_at",
            "build_template_sync_id", "preferred_manufacturer_sync_id",
            "waste_percent", "teardown_enabled", "scheduled_date", "assigned_employee_sync_id",
            "created_at", "updated_at", "company_id", "accepted_total"
        ).forEach { key ->
            assertFalse("crew_save_job's row_in must not carry '$key'", payload.containsKey(key))
        }
    }

    @Test
    fun `the old everything-minus-money payload would have carried them -- planted failure`() {
        // What buildCrewSaveJobPayload used to send. Proves the assertions
        // above can fail: the same job through the old filter carries the
        // customer's name and the office's notes.
        val full = SyncJson.encodeToJsonElement(CloudJob.serializer(), sampleCloudJob()) as kotlinx.serialization.json.JsonObject
        val oldPayload = full.filterKeys { it !in MONEY_KEYS }
        assertTrue(oldPayload.containsKey("customer_name"))
        assertTrue(oldPayload.containsKey("notes"))
        assertTrue(oldPayload.containsKey("hoa_name"))
        assertNotEquals(oldPayload.keys, buildCrewSaveJobPayload(sampleCloudJob()).keys)
    }

    @Test
    fun `the field work crew legitimately change still travels`() {
        val payload = buildCrewSaveJobPayload(sampleCloudJob())
        listOf(
            "blocked_reason", "locate_ticket_no", "locate_notes", "teardown_feet",
            "calibration_pixels_per_foot", "site_lat", "site_lon", "final_sign_off_storage_path"
        ).forEach { key ->
            assertTrue("crew field work '$key' no longer reaches crew_save_job", payload.containsKey(key))
        }
        assertEquals(JsonPrimitive("T-778"), payload["locate_ticket_no"])
    }

    @Test
    fun `status travels only as COMPLETED`() {
        // A stale local DRAFT or ACCEPTED must never roll a job back.
        assertFalse(buildCrewSaveJobPayload(sampleCloudJob(status = "IN_PROGRESS")).containsKey("status"))
        assertFalse(buildCrewSaveJobPayload(sampleCloudJob(status = "DRAFT")).containsKey("status"))
        assertFalse(buildCrewSaveJobPayload(sampleCloudJob(status = "ACCEPTED")).containsKey("status"))
        assertEquals(
            JsonPrimitive("COMPLETED"),
            buildCrewSaveJobPayload(sampleCloudJob(status = "COMPLETED"))["status"]
        )
    }

    @Test
    fun `a duration travels only for a caller who may reschedule`() {
        // A crew handset pushed 93.33 hours over the office's 4 on 4598150b.
        val crew = buildCrewSaveJobPayload(sampleCloudJob(), mayReschedule = false)
        CREW_SCHEDULER_JOB_KEYS.forEach { assertFalse("'$it' sent without SCHEDULE_AND_ASSIGN", crew.containsKey(it)) }
        val foreman = buildCrewSaveJobPayload(sampleCloudJob(), mayReschedule = true)
        CREW_SCHEDULER_JOB_KEYS.forEach { assertTrue("'$it' dropped for a scheduler", foreman.containsKey(it)) }
    }

    // ---- only what this phone changed (Job.crewBase) ----

    /** A crew phone's copy of a job, as it pulled it. */
    private val pulledJob = Job(
        id = 7, syncId = "job-1", customerName = "Jane Homeowner", notes = "gate sticks",
        locateNotes = "", teardownFeet = 80.0, calibrationPixelsPerFoot = 18.5f, gridExtentFt = 400f
    )

    private fun snap(job: Job) = jobSyncSnapshot(job, "co-1", null, null)

    @Test
    fun `with a snapshot, only the columns this phone changed travel`() {
        val base = snap(pulledJob)
        // The crew adds a locate note. Meanwhile the office recalibrated and
        // set teardown feet -- this phone still holds the old values.
        val edited = pulledJob.copy(locateNotes = "gas line marked east")
        val changed = crewChangedKeys(snap(edited), base)
        assertEquals(setOf("locate_notes"), changed)

        val payload = buildCrewSaveJobPayload(sampleCloudJob(), onlyKeys = changed)
        assertEquals(setOf("sync_id", "locate_notes"), payload.keys)
        // Planted failure: sending every allowlisted column -- the rule with no
        // snapshot -- puts the stale calibration and teardown feet back over
        // the office's, and both move the price.
        val everything = buildCrewSaveJobPayload(sampleCloudJob())
        assertTrue(everything.containsKey("calibration_pixels_per_foot"))
        assertTrue(everything.containsKey("teardown_feet"))
    }

    @Test
    fun `a field the crew cleared goes up as an explicit null`() {
        // Unblocking clears blocked_at; SyncJson drops a Kotlin null, so the
        // clear never reached the office.
        val payload = buildCrewSaveJobPayload(sampleCloudJob().copy(blockedAt = null), onlyKeys = setOf("blocked_at"))
        assertEquals(JsonNull, payload["blocked_at"])
        // Status is never sent as a null, and nothing off the allowlist is.
        val notWritable = buildCrewSaveJobPayload(sampleCloudJob(), onlyKeys = setOf("status", "notes", "scheduled_date"))
        assertEquals(setOf("sync_id"), notWritable.keys)
        // Planted failure: with no snapshot the cleared field is simply absent.
        assertFalse(buildCrewSaveJobPayload(sampleCloudJob().copy(blockedAt = null)).containsKey("blocked_at"))
    }

    @Test
    fun `a job taken from the cloud and not touched shows no change`() {
        // The snapshot is recorded when the cloud's copy is taken (first pull,
        // a newer-in-the-cloud merge, a pushed row adopted). Taking the same
        // row again must read as "nothing changed here", or every pass would
        // send columns nobody touched.
        val cloud = sampleCloudJob()
        val local = cloud.toLocalJob()
        val base = snap(local)
        assertEquals(emptySet<String>(), crewChangedKeys(snap(cloud.mergeOnto(local, keepMoney = true)), base))
        assertEquals(emptySet<String>(), crewChangedKeys(snap(local), base))
        // No snapshot is "cannot tell", never "nothing changed".
        assertEquals(null, crewChangedKeys(snap(local), null))
        assertEquals(null, decodeSnapshot("not json"))
        assertEquals(base, decodeSnapshot(encodeSnapshot(base)))
    }

    @Test
    fun `the snapshot carries no money and no identity`() {
        val s = snap(pulledJob.copy(depositAmount = 500.0, amountPaid = 100.0))
        MONEY_KEYS.forEach { assertFalse("snapshot carries $it", s.containsKey(it)) }
        listOf("sync_id", "company_id", "created_at", "updated_at").forEach { assertFalse(s.containsKey(it)) }
    }

    @Test
    fun `an edit the server will not take from crew goes to the office as a note`() {
        val base = snap(pulledJob)
        val current = snap(pulledJob.copy(notes = "dog in yard", locateNotes = "gas east"))
        // What crew_save_job was given: the locate note. The note was dropped,
        // and the server still holds the office's.
        val sent = setOf("sync_id", "locate_notes")
        val returned = snap(pulledJob.copy(locateNotes = "gas east"))
        assertEquals(mapOf("notes" to "dog in yard"), unsentCrewEdits(current, base, returned, sent))
        // The office typing the same thing is not news.
        assertEquals(emptyMap<String, String>(), unsentCrewEdits(current, base, current, sent))
        // Planted failure: the adoption merges the server's copy over the
        // phone's -- without this, "dog in yard" was simply gone.
        assertNotEquals(current["notes"], returned["notes"])
    }

    @Test
    fun `with no snapshot, the old Customer card's fields are judged against the server`() {
        // A phone from before snapshots typed into the then-editable card.
        val current = snap(pulledJob.copy(notes = "crew note", hoaName = "Oak HOA", wastePercent = 12.0))
        val returned = snap(pulledJob)
        val unsent = unsentCrewEdits(current, null, returned, setOf("sync_id"))
        assertEquals(setOf("notes", "hoa_name"), unsent.keys)
        // Only those fields: waste percent was never on the crew's card, and an
        // old phone that differs there is holding an old copy, not an edit.
        assertFalse("waste_percent" in unsent)
    }

    @Test
    fun `a refused delete is final, a lost signal is not`() {
        val refused = RuntimeException("PATCH failed", RuntimeException("P0001: Deleting needs the delete permission"))
        assertTrue(isDeletePermissionRefusal(refused))
        // Planted failure: a timeout or no signal must stay queued and retry.
        assertFalse(isDeletePermissionRefusal(java.io.IOException("timeout")))
        assertFalse(isDeletePermissionRefusal(RuntimeException("new row violates row-level security policy")))
        assertFalse(isDeletePermissionRefusal(null))
    }

    // ---- priced_by / pricing_engine_version on every push ----

    @Test
    fun `a job row push no longer carries blank pricing provenance`() {
        // CloudJob defaulted these to "", and SyncJson encodes defaults, so
        // every Job.toCloud() payload stamped priced_by = '' and
        // pricing_engine_version = '' -- explicitNulls = false only drops
        // NULL defaults. Null defaults now, so an object that says nothing
        // about them sends nothing.
        val bare = SyncJson.encodeToJsonElement(CloudJob.serializer(), CloudJob(syncId = "j", companyId = "c"))
            as kotlinx.serialization.json.JsonObject
        assertFalse(bare.containsKey("priced_by"))
        assertFalse(bare.containsKey("pricing_engine_version"))
        assertFalse(bare.containsKey("accepted_total"))
        // Planted failure: a non-null "" default IS encoded -- which is what
        // priced_by was, and why it went out blank.
        val withBlank = SyncJson.encodeToJsonElement(
            CloudJob.serializer(), CloudJob(syncId = "j", companyId = "c", pricedBy = "")
        ) as kotlinx.serialization.json.JsonObject
        assertEquals(JsonPrimitive(""), withBlank["priced_by"])
    }

    // ---- the Kotlin list and the SQL list are one list ----

    /**
     * The repo root, from either working directory unit tests run in.
     */
    private fun repoRoot(): File =
        listOf(File(".."), File("."))
            .firstOrNull { File(it, "supabase/dev/apply-order.txt").isFile }
            ?: error("could not find the repo root (supabase/dev/apply-order.txt) from ${File(".").absolutePath}")

    /**
     * A definition, not a mention: `grant execute on function public.x()` and
     * the call inside crew_save_job name the function too, and parsing from
     * one of those would read the wrong array.
     */
    private val definition =
        Regex("create\\s+(or\\s+replace\\s+)?function\\s+public\\.crew_writable_job_columns\\s*\\(", RegexOption.IGNORE_CASE)

    /**
     * The SQL that defines `public.crew_writable_job_columns()`, latest by the
     * dev apply order when more than one file does. Found by content rather
     * than by name, so the check follows the function wherever it is kept.
     */
    private fun crewWritableSql(): Pair<File, String> {
        val root = repoRoot()
        val order = File(root, "supabase/dev/apply-order.txt").readLines().map { it.trim() }
        val definers = root.listFiles { f -> f.isFile && f.name.startsWith("supabase_") && f.name.endsWith(".sql") }
            .orEmpty()
            .map { it to it.readText() }
            .filter { (_, text) -> definition.containsMatchIn(text) }
        assertTrue(
            "No supabase_*.sql file defines public.crew_writable_job_columns() -- the server half of " +
                "CREW_WRITABLE_JOB_KEYS (a supabase_*.sql file at the repo root). The two lists " +
                "must ship together.",
            definers.isNotEmpty()
        )
        return definers.maxByOrNull { (f, _) ->
            order.indexOf(f.name).let { if (it < 0) Int.MAX_VALUE else it }
        }!!
    }

    /** The quoted names inside the function's array[...] literal, comments stripped. */
    private fun sqlAllowlist(text: String): Set<String> {
        val at = definition.findAll(text).last().range.first
        val body = text.substring(at).lines().joinToString("\n") { it.substringBefore("--") }
        val open = body.indexOf("array[", ignoreCase = true)
        assertTrue("crew_writable_job_columns() has no array[...] literal", open >= 0)
        val close = body.indexOf(']', open)
        assertTrue("crew_writable_job_columns()'s array[...] is not closed", close > open)
        return Regex("'([a-z_]+)'").findAll(body.substring(open, close)).map { it.groupValues[1] }.toSet()
    }

    @Test
    fun `CREW_WRITABLE_JOB_KEYS is exactly the server's crew_writable_job_columns()`() {
        val (file, text) = crewWritableSql()
        val sql = sqlAllowlist(text)
        assertTrue("parsed nothing from ${file.name} -- the parser, not the lists, is broken", sql.size >= 5)
        assertEquals(
            "CREW_WRITABLE_JOB_KEYS (SyncScope.kt) and crew_writable_job_columns() (${file.name}) have " +
                "drifted apart. Change both together: a key only the phone sends is silently dropped by the " +
                "server; a key only the server takes is never sent.",
            sql,
            CREW_WRITABLE_JOB_KEYS
        )
    }

    @Test
    fun `the parser can tell two lists apart -- planted failure`() {
        // If sqlAllowlist returned the Kotlin list whatever it read, the test
        // above could never fail. A one-name difference must show.
        val planted = """
            create or replace function public.crew_writable_job_columns()
             returns text[] language sql immutable as ${'$'}${'$'}
              select array[
                'status',      -- clamped to COMPLETED
                'locate_notes' -- the crew's own note
              ]::text[] ${'$'}${'$'};
        """.trimIndent()
        assertEquals(setOf("status", "locate_notes"), sqlAllowlist(planted))
        assertNotEquals(CREW_WRITABLE_JOB_KEYS, sqlAllowlist(planted))
    }

    @Test
    fun `the server grants the duration keys under the same permission the phone asks about`() {
        // Wherever crew_save_job applies the allowlist -- the same file as the
        // function or its own -- it must also let the two duration keys
        // through for SCHEDULE_AND_ASSIGN, the permission JobSync asks
        // has_permission about before sending them.
        crewWritableSql() // fails first, and clearly, if the server half is missing altogether
        val users = repoRoot()
            .listFiles { f -> f.isFile && f.name.startsWith("supabase_") && f.name.endsWith(".sql") }
            .orEmpty()
            .map { it.readText() }
            .filter { it.contains("crew_writable_job_columns") && it.contains("SCHEDULE_AND_ASSIGN") }
        assertTrue(
            "no supabase_*.sql file applies crew_writable_job_columns() together with SCHEDULE_AND_ASSIGN",
            users.isNotEmpty()
        )
        CREW_SCHEDULER_JOB_KEYS.forEach { key ->
            assertTrue(
                "'$key' is not let through for SCHEDULE_AND_ASSIGN in the crew_save_job allowlist SQL",
                users.any { it.contains("'$key'") }
            )
        }
    }

    // ---- structure of the two write branches (source-read) ----

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
     * table's own .update(...) -- and it must send the allowlisted payload.
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
        assertTrue(
            "the crew_save_job payload must be built by buildCrewSaveJobPayload (the allowlist)",
            deniedBranch.contains("buildCrewSaveJobPayload(")
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

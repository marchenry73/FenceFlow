package com.fenceestimator.app.data

/*
 * EVIDENCE, NOT A RUNNING TEST -- see the honesty note below before treating
 * a green run of this as proof of anything.
 *
 * This file lives at the repo root under tests/, outside any Gradle source
 * set, because the task that produced it is scoped to "new .sql files, new
 * .md files, new test files under tests/ -- do not edit any existing file."
 * Room's cascade behavior can only actually be exercised inside an
 * instrumented (androidTest) or Robolectric-backed unit test that builds a
 * real in-memory database via Room.inMemoryDatabaseBuilder(...), which needs
 * an Android test runner this location does not have and this task was not
 * authorized to wire up (that means touching build.gradle and possibly
 * app/src/test or app/src/androidTest, both outside the file ownership for
 * this task). So this could not be executed, on a device or otherwise, in
 * this session. What follows is the exact test that WOULD prove Defect 2,
 * written so whoever implements the fix can drop it into
 * app/src/androidTest/java/com/fenceestimator/app/data/ verbatim (adjusting
 * imports for whatever test runner the project already uses elsewhere) and
 * run it once before the fix (RED -- proves the defect) and once after
 * (GREEN -- proves the fix, with a positive control so a GREEN cannot be
 * mistaken for "the delete silently did nothing at all").
 *
 * import androidx.room.Room
 * import androidx.test.core.app.ApplicationProvider
 * import androidx.test.ext.junit.runners.AndroidJUnit4
 * import kotlinx.coroutines.runBlocking
 * import org.junit.Assert.assertEquals
 * import org.junit.Assert.assertNotNull
 * import org.junit.Assert.assertNull
 * import org.junit.Test
 * import org.junit.runner.RunWith
 *
 * @RunWith(AndroidJUnit4::class)
 * class DeletedJobCascadeEvidenceTest {
 *
 *     @Test
 *     fun deletingAJobDestroysItsUnsyncedTimeEntries() = runBlocking {
 *         val db = Room.inMemoryDatabaseBuilder(
 *             ApplicationProvider.getApplicationContext(),
 *             AppDatabase::class.java
 *         ).build()
 *
 *         val jobId = db.jobDao().insert(Job(customerName = "Evidence Job"))
 *
 *         // The offline crew-hours scenario: a shift clocked and clocked out
 *         // on this phone, never yet pushed to the cloud (TimeEntry carries
 *         // no per-row synced flag at all -- see Repository.kt's
 *         // recordedHoursForJob doc -- so there is no "already safe" copy of
 *         // this row anywhere before a push happens).
 *         val entryId = db.timeEntryDao().insert(
 *             TimeEntry(jobId = jobId, startedAt = 1L, endedAt = 2L, hourlyRate = 25.0)
 *         )
 *
 *         // Positive control -- prove the row genuinely exists before the
 *         // delete, so a later "it's gone" cannot be an artifact of the
 *         // insert having silently failed. Four proofs were invalidated
 *         // exactly this way in an earlier audit; this line is why that
 *         // will not happen here.
 *         val beforeDelete = db.timeEntryDao().getForJob(jobId)
 *         assertEquals("control failed: the time entry was never actually inserted", 1, beforeDelete.size)
 *         assertNotNull(db.jobDao().getById(jobId))
 *
 *         val job = db.jobDao().getById(jobId)!!
 *         db.jobDao().delete(job) // Repository.deleteJob's own local half
 *
 *         // TODAY (before either migration or code fix): this is empty --
 *         // SQLite's ON DELETE CASCADE removed it in the same transaction
 *         // as the job, with nothing pushed and nothing recoverable.
 *         val afterDelete = db.timeEntryDao().getForJob(jobId)
 *         assertEquals(
 *             "if this fails (i.e. the row survived), Defect 2 is already fixed " +
 *                 "-- re-run against the unmodified schema to confirm before trusting a passing suite",
 *             0,
 *             afterDelete.size
 *         )
 *
 *         db.close()
 *     }
 *
 *     // After MIGRATION_39_40 (see ROOM_MIGRATIONS_defects_1_and_2.md) lands
 *     // and Repository.deleteJob is updated to rely on ON DELETE SET NULL,
 *     // the equivalent assertion becomes:
 *     //
 *     //   val survivor = db.timeEntryDao().getForJob(jobId) // now returns nothing by jobId, since jobId is null
 *     //   val orphaned = db.timeEntryDao().getOrphaned() // a query that would need adding
 *     //   assertEquals(1, orphaned.size)
 *     //   assertNull(orphaned.single().jobId)
 *     //
 *     // -- proving the row survived AND lost its job link, not merely that
 *     // some row with count 1 exists somewhere (which a bug that failed to
 *     // delete anything at all would also produce).
 * }
 */

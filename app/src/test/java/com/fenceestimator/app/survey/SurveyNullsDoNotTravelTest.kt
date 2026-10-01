package com.fenceestimator.app.survey

import com.fenceestimator.app.cloud.CloudJob
import com.fenceestimator.app.cloud.cloudJson
import com.fenceestimator.app.cloud.jobAfterPush
import com.fenceestimator.app.data.Job
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the drawing screen can and cannot rely on the sync to carry, pinned as a
 * fact about the sync rather than assumed -- because two decisions in the survey
 * work rest on it.
 *
 * THE FACT: an OWNER's phone can send a survey path or a calibration to the cloud,
 * but it cannot send "this is now empty". A Kotlin null is dropped from the update
 * (`explicitNulls = false`), so the column is not touched; and the row the server
 * answers with is merged back over the phone's, where a value from the cloud
 * always beats a null on the phone ([jobAfterPush] / mergeOnto). (The crew door,
 * `crew_save_job`, sends an explicit null for a key the phone changed --
 * JobSync.buildCrewSaveJobPayload -- so it can clear; it is not what this file
 * covers and nothing in the survey work relies on it.)
 *
 * WHAT RESTS ON IT:
 *  - "Use Grid" cannot be made to stick by clearing `surveyStoragePath` (the fix
 *    tests/a30-use-grid-persists.test.mjs asks for). The path would be dropped
 *    from the update and put straight back from the server's row, and the next
 *    pass downloads the photo again. So Use Grid is a display choice instead, and
 *    the survey stays saved (SurveySavedTest).
 *  - `importImage` writes a null calibration for a new photo ("a photo has no scale
 *    until somebody calibrates it"), and that null does not reach the office: a
 *    scale the job already had -- the grid's own, for a job drawn before its photo
 *    was added -- survives and comes back down, so the new photo is priced at it.
 *    Unmeasured, and shown as such (ScaleBasis.UNMEASURED), but priced.
 *
 * If these start failing because the sync learned to send explicit nulls, that is
 * the fix both of those wanted: update the two notes above, then Use Grid and a new
 * photo's "no scale" can be made durable, and this file can go.
 */
class SurveyNullsDoNotTravelTest {

    private val photoPath = "co-1/job-1/survey/survey_7_old.jpg"

    /** What the phone holds after choosing a new photo: a local file, no storage path, no scale. */
    private val phone = Job(
        id = 7,
        syncId = "job-1",
        surveyImagePath = "/data/user/0/app/files/surveys/survey_7_new.jpg",
        surveyStoragePath = null,
        calibrationPixelsPerFoot = null,
        calibrationKnownFeet = null,
        updatedAt = 2_000L
    )

    /** What the server holds: the photo it already has, and the grid scale seeded earlier. */
    private fun server(photo: String? = photoPath, scale: Float? = 20f) = CloudJob(
        syncId = "job-1",
        companyId = "co-1",
        surveyStoragePath = photo,
        calibrationPixelsPerFoot = scale,
        updatedAt = "2026-10-01T10:00:00.000000+00:00"
    )

    @Test
    fun `a null survey path and a null calibration are left out of what the phone sends`() {
        val sent = cloudJson.encodeToString(
            CloudJob.serializer(),
            CloudJob(syncId = "job-1", companyId = "co-1", surveyStoragePath = null, calibrationPixelsPerFoot = null, calibrationKnownFeet = null)
        )
        assertFalse("a null path must not be sent as a clear: $sent", sent.contains("survey_storage_path"))
        assertFalse("a null calibration must not be sent as a clear: $sent", sent.contains("calibration_pixels_per_foot"))
        assertFalse(sent.contains("calibration_known_feet"))
        // Positive control: the same fields DO travel when they hold a value, so the
        // check above is reading the real encoder and not an empty string.
        val withValues = cloudJson.encodeToString(
            CloudJob.serializer(),
            CloudJob(syncId = "job-1", companyId = "co-1", surveyStoragePath = photoPath, calibrationPixelsPerFoot = 20f, calibrationKnownFeet = 40f)
        )
        assertTrue(withValues.contains("survey_storage_path"))
        assertTrue(withValues.contains("calibration_pixels_per_foot"))
        assertTrue(withValues.contains("calibration_known_feet"))
    }

    @Test
    fun `the row the server hands back puts its photo and its scale over a phone's nulls`() {
        val adopted = jobAfterPush(pushed = phone, current = phone, returned = server(), keepMoney = false)
        assertTrue("the server's row has a readable clock, so it is adopted", adopted != null)
        // The phone's own choices -- no storage path, no scale -- are gone...
        assertEquals(photoPath, adopted!!.surveyStoragePath)
        assertEquals(20f, adopted.calibrationPixelsPerFoot)
        // ...and the new photo's local file is untouched, which is why the job now has a new
        // photo on this phone, the old one in the cloud, and the old scale for both.
        assertEquals(phone.surveyImagePath, adopted.surveyImagePath)
    }

    @Test
    fun `with nothing on the server the phone's values stay -- the case that works`() {
        val adopted = jobAfterPush(pushed = phone, current = phone, returned = server(photo = null, scale = null), keepMoney = false)!!
        assertEquals(null, adopted.surveyStoragePath)
        assertEquals(null, adopted.calibrationPixelsPerFoot)
    }
}

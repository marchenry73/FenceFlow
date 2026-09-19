package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.BusinessProfile
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A settings blob the cloud never sent a number in must not produce one.
 *
 * company_settings is a single jsonb blob and save_company_settings merges it
 * with `||`, which keeps existing keys but still stamps `updated_at = now()`.
 * So a partial save from the office -- the setup wizard writing only
 * `default_build_template`, or the settings page, which deliberately omits a
 * numeric box left blank -- makes the cloud row NEWER than the phone's while
 * carrying none of the money keys. [CloudSettings] used to declare those four
 * non-nullable with invented literals (tax_rate 7.0, markup 15.0, labor_rate
 * 8.0, min_job_charge 200.0), so the whole-object merge handed the company a
 * price nobody chose, and the next push saved it as theirs.
 *
 * Every test here decodes through [cloudJson] -- the real configuration the
 * phone uses, `coerceInputValues` and all -- rather than a Json built for the
 * test, because the flag that turns an explicit null into a literal default
 * lives in that configuration and nowhere else.
 *
 * [LegacyCloudSettings] below is the shape as shipped, kept only as the planted
 * failure: each "absent key" test is paired with one proving the SAME fixture
 * decoded through the old declaration really does invent the number. Without
 * that pair a passing test could just mean the fixture happens to contain the
 * key after all.
 */
class SettingsMergeTest {

    /**
     * A company that has made real decisions: no markup at all, a low labour
     * rate, no minimum charge, and a tax rate that is not 7.
     *
     * Chosen so that every field differs from BOTH the local default AND the
     * literal the old [CloudSettings] would have invented. A fixture that
     * happened to equal either one could not tell "kept the local value" from
     * "wrote the default", which is the whole question.
     */
    private val local = BusinessProfile(
        businessName = "Ridgeline Fence",
        ownerName = "Dana Ruiz",
        phone = "813-555-0142",
        email = "dana@ridgeline.example",
        licenseNumber = "FL-CFC-99213",
        defaultTaxRatePercent = 6.5,
        defaultMarkupPercent = 0.0,
        defaultLaborRatePerFt = 11.25,
        defaultMinimumJobCharge = 0.0,
        defaultPostSpacingFt = 8f,
        defaultConcreteBagsPerPost = 2f,
        defaultPanelWidthFt = 8f,
        defaultPanelHeightFt = 4f,
        updatedAt = 1_600_000_000_000L
    )

    /** The wizard's real payload: one key, none of them money. */
    private val wizardBlob = """{"default_build_template":"tpl-7f3a"}"""

    /** Every money/measurement key the merge must not invent, and its literal. */
    private val invented = listOf(
        "tax_rate" to 7.0,
        "markup" to 15.0,
        "labor_rate" to 8.0,
        "min_job_charge" to 200.0
    )

    private fun decode(blob: String): CloudSettings =
        cloudJson.decodeFromString(CloudSettings.serializer(), blob)

    // ---------------------------------------------------------------- absent

    @Test
    fun `a blob with no money keys at all leaves every local money value untouched`() {
        val merged = local.mergedWith(decode(wizardBlob))

        assertEquals(6.5, merged.defaultTaxRatePercent, 0.0)
        assertEquals(0.0, merged.defaultMarkupPercent, 0.0)
        assertEquals(11.25, merged.defaultLaborRatePerFt, 0.0)
        assertEquals(0.0, merged.defaultMinimumJobCharge, 0.0)
        assertEquals(8f, merged.defaultPostSpacingFt, 0f)
        assertEquals(2f, merged.defaultConcreteBagsPerPost, 0f)
        assertEquals(8f, merged.defaultPanelWidthFt, 0f)
        assertEquals(4f, merged.defaultPanelHeightFt, 0f)
    }

    @Test
    fun `a blob missing exactly one money key leaves that one value untouched`() {
        // One at a time, because a merge can be right about three fields and
        // wrong about the fourth -- and min_job_charge was the fourth.
        for ((absent, _) in invented) {
            // The other three carry values that match neither this company's
            // nor the old invented literal, so a merge cannot pass by accident.
            val present = invented.filter { it.first != absent }
                .joinToString(",") { (key, literal) -> "\"" + key + "\":" + (literal + 100) }
            val merged = local.mergedWith(decode("{" + present + "}"))

            when (absent) {
                "tax_rate" -> assertEquals(
                    "tax_rate was absent and the merge wrote something anyway",
                    6.5, merged.defaultTaxRatePercent, 0.0
                )
                "markup" -> assertEquals(
                    "markup was absent and the merge wrote something anyway",
                    0.0, merged.defaultMarkupPercent, 0.0
                )
                "labor_rate" -> assertEquals(
                    "labor_rate was absent and the merge wrote something anyway",
                    11.25, merged.defaultLaborRatePerFt, 0.0
                )
                "min_job_charge" -> assertEquals(
                    "min_job_charge was absent and the merge wrote something anyway",
                    0.0, merged.defaultMinimumJobCharge, 0.0
                )
            }
        }
    }

    @Test
    fun `absent identity fields are kept rather than blanked`() {
        // Not money, but it prints on the contract and the invoice. The wizard
        // payload carries none of these either, and the merge used to write ""
        // over all five.
        val merged = local.mergedWith(decode(wizardBlob))
        assertEquals("Ridgeline Fence", merged.businessName)
        assertEquals("Dana Ruiz", merged.ownerName)
        assertEquals("813-555-0142", merged.phone)
        assertEquals("dana@ridgeline.example", merged.email)
        assertEquals("FL-CFC-99213", merged.licenseNumber)
    }

    // PLANTED FAILURE for both of the above: the shipped declaration, on the
    // very same fixture. It must invent all four numbers -- which is what
    // proves the fixture really is missing them.
    @Test
    fun `the old non-nullable shape invents all four numbers from the same blob`() {
        val legacy = cloudJson.decodeFromString(LegacyCloudSettings.serializer(), wizardBlob)
        assertEquals(7.0, legacy.taxRate, 0.0)
        assertEquals(15.0, legacy.markup, 0.0)
        assertEquals(8.0, legacy.laborRate, 0.0)
        assertEquals(200.0, legacy.minJobCharge, 0.0)
        // And each invented number really does differ from this company's own,
        // so applying it would have been a visible change to a quote.
        assertNotEquals(local.defaultTaxRatePercent, legacy.taxRate, 0.0)
        assertNotEquals(local.defaultMarkupPercent, legacy.markup, 0.0)
        assertNotEquals(local.defaultLaborRatePerFt, legacy.laborRate, 0.0)
        assertNotEquals(local.defaultMinimumJobCharge, legacy.minJobCharge, 0.0)
        assertEquals("", legacy.businessName)
    }

    // ------------------------------------------------------- explicit nulls

    @Test
    fun `an explicitly null money value leaves the local value untouched`() {
        val blob = """
            {"tax_rate":null,"markup":null,"labor_rate":null,"min_job_charge":null,
             "post_spacing":null,"concrete_bags":null,"panel_width":null,"panel_height":null,
             "business_name":null,"license_number":null}
        """.trimIndent()
        val merged = local.mergedWith(decode(blob))

        assertEquals(6.5, merged.defaultTaxRatePercent, 0.0)
        assertEquals(0.0, merged.defaultMarkupPercent, 0.0)
        assertEquals(11.25, merged.defaultLaborRatePerFt, 0.0)
        assertEquals(0.0, merged.defaultMinimumJobCharge, 0.0)
        assertEquals(8f, merged.defaultPostSpacingFt, 0f)
        assertEquals(2f, merged.defaultConcreteBagsPerPost, 0f)
        assertEquals(8f, merged.defaultPanelWidthFt, 0f)
        assertEquals(4f, merged.defaultPanelHeightFt, 0f)
        assertEquals("Ridgeline Fence", merged.businessName)
        assertEquals("FL-CFC-99213", merged.licenseNumber)
    }

    // PLANTED FAILURE: the same explicit nulls through the shipped shape.
    // coerceInputValues is what turns each one into the declared literal, so
    // this is the flag doing the damage rather than the absence.
    @Test
    fun `the old shape turns an explicit null into the invented literal`() {
        val legacy = cloudJson.decodeFromString(
            LegacyCloudSettings.serializer(),
            """{"tax_rate":null,"markup":null,"labor_rate":null,"min_job_charge":null}"""
        )
        assertEquals(7.0, legacy.taxRate, 0.0)
        assertEquals(15.0, legacy.markup, 0.0)
        assertEquals(8.0, legacy.laborRate, 0.0)
        assertEquals(200.0, legacy.minJobCharge, 0.0)
    }

    // ------------------------------------------------- a real value still wins

    @Test
    fun `a real cloud value wins, including a real zero`() {
        val blob = """
            {"tax_rate":8.25,"markup":22.5,"labor_rate":14.0,"min_job_charge":450.0,
             "post_spacing":6,"concrete_bags":1.5,"panel_width":6,"panel_height":6,
             "business_name":"Ridgeline Fence LLC","prices_reviewed":true}
        """.trimIndent()
        val merged = local.mergedWith(decode(blob))

        assertEquals(8.25, merged.defaultTaxRatePercent, 0.0)
        assertEquals(22.5, merged.defaultMarkupPercent, 0.0)
        assertEquals(14.0, merged.defaultLaborRatePerFt, 0.0)
        assertEquals(450.0, merged.defaultMinimumJobCharge, 0.0)
        assertEquals(6f, merged.defaultPostSpacingFt, 0f)
        assertEquals(1.5f, merged.defaultConcreteBagsPerPost, 0f)
        assertEquals("Ridgeline Fence LLC", merged.businessName)
        // Nothing was kept by accident: every one of those differs from local.
        assertNotEquals(local.defaultTaxRatePercent, merged.defaultTaxRatePercent, 0.0)
        assertNotEquals(local.defaultMarkupPercent, merged.defaultMarkupPercent, 0.0)
        assertNotEquals(local.defaultLaborRatePerFt, merged.defaultLaborRatePerFt, 0.0)
        assertNotEquals(local.defaultMinimumJobCharge, merged.defaultMinimumJobCharge, 0.0)

        // A deliberate zero is an answer, not an absence. The office setting
        // markup to 0 has to reach the phone, or "keep local when null" would
        // have quietly become "never let a price go down".
        val zeroed = local.copy(defaultMarkupPercent = 18.0, defaultMinimumJobCharge = 300.0)
            .mergedWith(decode("""{"markup":0,"min_job_charge":0}"""))
        assertEquals(0.0, zeroed.defaultMarkupPercent, 0.0)
        assertEquals(0.0, zeroed.defaultMinimumJobCharge, 0.0)
    }

    // PLANTED FAILURE for the above: the fixture's values must not equal what
    // the merge would produce by doing nothing at all. If this ever passes
    // while the test above also passes, the fixture has gone stale.
    @Test
    fun `doing nothing would not have produced those values`() {
        val untouched = local.mergedWith(decode("{}"))
        assertNotEquals(8.25, untouched.defaultTaxRatePercent, 0.0)
        assertNotEquals(22.5, untouched.defaultMarkupPercent, 0.0)
        assertNotEquals(14.0, untouched.defaultLaborRatePerFt, 0.0)
        assertNotEquals(450.0, untouched.defaultMinimumJobCharge, 0.0)
    }

    // ------------------------------------------------------ newer-wins gate

    @Test
    fun `the cloud only wins when it is genuinely newer`() {
        val localAt = 1_600_000_000_000L
        assertTrue(cloudIsNewer("2026-09-18T12:00:00+00:00", localAt))
        // Same instant is the same save, not a newer one.
        assertFalse(cloudIsNewer("2020-09-13T12:26:40+00:00", 1_600_000_000_000L))
        // Older must lose, or a push that had not landed gets undone.
        assertFalse(cloudIsNewer("2019-01-01T00:00:00+00:00", localAt))
        // A row that cannot say when it changed does not get to overwrite one
        // that can.
        assertFalse(cloudIsNewer(null, localAt))
        assertFalse(cloudIsNewer("not a timestamp", localAt))
    }

    // PLANTED FAILURE: a phone that has never saved anything has updatedAt 0,
    // and must still accept the cloud -- otherwise "only when newer" would
    // lock a fresh install out of its own company's settings for ever.
    @Test
    fun `a phone that has never saved still accepts the cloud`() {
        assertTrue(cloudIsNewer("2026-09-18T12:00:00+00:00", 0L))
    }

    // ------------------------------------------------------- whole-row decode

    @Test
    fun `a whole company_settings row decodes with its money keys absent`() {
        // The realistic shape: what the table actually hands over after the
        // wizard has saved once and no phone has pushed yet.
        val row = cloudJson.decodeFromString(
            SettingsRow.serializer(),
            """{"updated_at":"2026-09-18 12:00:00+00","company_id":"c-1",
                "settings":{"default_build_template":"tpl-7f3a","business_name":"Ridgeline Fence"}}"""
        )
        assertTrue(cloudIsNewer(row.updatedAt, local.updatedAt))
        val merged = local.mergedWith(row.settings)
        assertEquals(0.0, merged.defaultMarkupPercent, 0.0)
        assertEquals(11.25, merged.defaultLaborRatePerFt, 0.0)
        assertEquals(6.5, merged.defaultTaxRatePercent, 0.0)
        assertEquals(0.0, merged.defaultMinimumJobCharge, 0.0)
    }

    // ------------------------------------------------------------ prices flag

    @Test
    fun `prices_reviewed stays one-way`() {
        // An absent flag cannot un-review, and a true one cannot be undone by
        // a phone that has not synced lately.
        assertTrue(local.copy(pricesReviewed = true).mergedWith(decode("{}")).pricesReviewed)
        assertTrue(
            local.copy(pricesReviewed = true)
                .mergedWith(decode("""{"prices_reviewed":false}""")).pricesReviewed
        )
        assertTrue(
            local.copy(pricesReviewed = false)
                .mergedWith(decode("""{"prices_reviewed":true}""")).pricesReviewed
        )
        assertFalse(local.copy(pricesReviewed = false).mergedWith(decode("{}")).pricesReviewed)
    }
}

/**
 * [CloudSettings] exactly as it shipped, kept ONLY so the tests above have
 * something that fails. Every money field non-nullable with a literal default,
 * which is the fault: decoded against a blob that is missing the key, or that
 * carries an explicit null, it produces a number nobody at the company chose.
 *
 * Do not use this for anything. If [CloudSettings] ever goes back to this
 * shape, the planted-failure tests will start agreeing with the real ones and
 * the suite stops proving anything -- which is what the assertNotEquals pairs
 * above are there to catch.
 */
@Serializable
private data class LegacyCloudSettings(
    @SerialName("business_name") val businessName: String = "",
    @SerialName("tax_rate") val taxRate: Double = 7.0,
    @SerialName("markup") val markup: Double = 15.0,
    @SerialName("labor_rate") val laborRate: Double = 8.0,
    @SerialName("min_job_charge") val minJobCharge: Double = 200.0
)

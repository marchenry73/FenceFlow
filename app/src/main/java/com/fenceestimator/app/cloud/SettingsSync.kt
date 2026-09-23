package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.SettingsStore
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The company-level slice of settings -- everything that should follow the
 * business rather than the handset.
 *
 * Theme, language, and the Square access token are deliberately NOT here.
 * Theme and language are personal to whoever is holding the phone, and the
 * Square token is a live payment credential: syncing it would hand every
 * manager on the account the ability to charge cards.
 *
 * EVERY field is nullable, and null means one thing only: "the cloud did not
 * say". It is never a value. [mergedWith] keeps the phone's own answer for any
 * field that comes back null, and the merge is the only place these are read.
 *
 * They were not nullable, and the money four carried invented literals --
 * tax_rate 7.0, markup 15.0, labor_rate 8.0, min_job_charge 200.0. company_settings
 * is a single jsonb blob, so a key is absent whenever no client that knows about
 * it has ever written one; save_company_settings merges with `||`, which keeps
 * existing keys but still stamps updated_at = now(). So any partial save from the
 * office -- the setup wizard writing only `default_build_template`, or the
 * settings page which deliberately omits a numeric box left blank -- makes the
 * cloud row NEWER than the phone's while carrying none of the money keys. The
 * whole-object merge then wrote 7/15/8/200 over whatever this company had
 * actually chosen, and the next push saved those as theirs. `coerceInputValues`
 * (SupabaseModule.cloudJson) opened the same door for an explicit
 * `"markup": null`, which decodes to the declared default rather than throwing.
 *
 * Checked live 2026-09-18 (read-only, rolled back): both companies currently
 * carry all eight money/measurement keys with no explicit nulls, so nothing is
 * corrupted today. This is about the number nobody chose being unreachable
 * rather than merely unobserved.
 */
@Serializable
data class CloudSettings(
    @SerialName("business_name") val businessName: String? = null,
    @SerialName("owner_name") val ownerName: String? = null,
    val phone: String? = null,
    val email: String? = null,
    @SerialName("license_number") val licenseNumber: String? = null,
    // The four that decide a price. There is no defensible literal for any of
    // them: a markup is a business decision, not a constant.
    @SerialName("tax_rate") val taxRate: Double? = null,
    @SerialName("markup") val markup: Double? = null,
    @SerialName("labor_rate") val laborRate: Double? = null,
    @SerialName("min_job_charge") val minJobCharge: Double? = null,
    @SerialName("min_labor_charge") val minLaborCharge: Double? = null,
    // Measurements, which reach a price through the material counts: posts per
    // run, bags per post, panels per run. A wrong 6 is a wrong quote.
    @SerialName("post_spacing") val postSpacing: Float? = null,
    @SerialName("concrete_bags") val concreteBags: Float? = null,
    @SerialName("panel_width") val panelWidth: Float? = null,
    @SerialName("panel_height") val panelHeight: Float? = null,
    @SerialName("tools_list") val toolsList: String? = null,
    @SerialName("order_template") val orderTemplate: String? = null,
    @SerialName("hoa_template") val hoaTemplate: String? = null,
    @SerialName("review_template") val reviewTemplate: String? = null,
    @SerialName("prices_reviewed") val pricesReviewed: Boolean? = null
)

/**
 * What crew_settings() returns: the non-money keys only, and every one of them
 * nullable. A null here means "that key was not in the answer", which must
 * leave the local value alone.
 *
 * [CloudSettings] is now nullable throughout and would merge a crew answer
 * correctly, so this class is no longer needed to avoid inventing a number.
 * It is kept for the stronger, structural guarantee: it has no money field at
 * all, so if crew_settings() ever started returning `markup`, this door still
 * could not carry it onto a crew phone. That is a property of the type rather
 * than of a `?:` somebody has to remember to write.
 */
@Serializable
private data class CrewSettings(
    @SerialName("business_name") val businessName: String? = null,
    @SerialName("owner_name") val ownerName: String? = null,
    val phone: String? = null,
    val email: String? = null,
    @SerialName("license_number") val licenseNumber: String? = null,
    @SerialName("post_spacing") val postSpacing: Float? = null,
    @SerialName("concrete_bags") val concreteBags: Float? = null,
    @SerialName("panel_width") val panelWidth: Float? = null,
    @SerialName("panel_height") val panelHeight: Float? = null,
    @SerialName("tools_list") val toolsList: String? = null,
    @SerialName("order_template") val orderTemplate: String? = null,
    @SerialName("hoa_template") val hoaTemplate: String? = null,
    @SerialName("review_template") val reviewTemplate: String? = null
)

/** One company_settings row, exactly as the table hands it over. */
@Serializable
internal data class SettingsRow(
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("company_id") val companyId: String,
    val settings: CloudSettings
)

object SettingsSync {

    // explicitNulls = false matters on the way UP, now that CloudSettings is
    // nullable. save_company_settings merges with `||`, so a key present as
    // JSON null would REPLACE a real stored number with null -- turning this
    // phone's "I have nothing to say about markup" into the company's stored
    // answer, and handing every other phone the null this fix exists to refuse.
    // [toCloud] never produces a null today; this makes it impossible to start.
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true; explicitNulls = false }

    /** Pushes the company-level settings up. Device-only fields are left behind. */
    suspend fun push(profile: BusinessProfile): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val payload = json.encodeToString(CloudSettings.serializer(), profile.toCloud())
            SupabaseModule.client.postgrest.rpc(
                "save_company_settings",
                buildJsonObject { put("new_settings", json.parseToJsonElement(payload)) }
            )
            Unit
        }
    }

    /**
     * Pulls company settings down and writes them into the local store,
     * preserving this device's own theme, language, and Square credentials.
     */
    suspend fun pull(store: SettingsStore, companyId: String): Result<Boolean> = withContext(Dispatchers.IO) {
        runCatching {
            // company_settings carries labor_rate, markup and min_job_charge --
            // the INPUTS a price is built from -- so the whole row is now hidden
            // from a member without SEE_MONEY
            // (supabase_sec_company_reads.sql), the same way employees and
            // time_entries hide pay. A crew phone still needs the business name
            // and the post/panel measurements, so an empty answer falls back to
            // crew_settings(), which returns the non-money keys and nothing
            // else. An empty read is NOT read as "the office cleared every
            // setting": the merge below only ever applies what came back.
            val row = SupabaseModule.client.postgrest.from("company_settings")
                .select { filter { eq("company_id", companyId) } }
                .decodeSingleOrNull<SettingsRow>()
                ?: run {
                    val crew = runCatching {
                        SupabaseModule.client.postgrest
                            .rpc("crew_settings")
                            .decodeAs<CrewSettings>()
                    }.getOrNull() ?: return@runCatching false
                    val local0 = store.profile.first()
                    store.save(local0.mergedWith(crew), stamp = false)
                    return@runCatching true
                }

            val local = store.profile.first()

            // The cloud only wins when it is genuinely newer.
            //
            // This used to overwrite every local value unconditionally, and it
            // runs on every session refresh -- so a save whose push had not
            // landed was quietly undone on the next app start. The user saw a
            // setting they had changed revert after an update and reasonably
            // concluded the save was broken. It was not: it was being
            // overwritten by an older copy.
            if (!cloudIsNewer(row.updatedAt, local.updatedAt)) return@runCatching false

            // Newer is not the same as complete, and that gap was the bug. The
            // row that wins here may carry two keys out of twenty-three -- the
            // office saving one thing stamps updated_at for all of them. The
            // merge is per-field for exactly that reason: winning the timestamp
            // earns the cloud the fields it actually sent, and nothing else.
            store.save(local.mergedWith(row.settings), stamp = false)
            true
        }
    }
}

/**
 * Whether the cloud's copy is genuinely newer than this device's.
 *
 * Pulled out of [SettingsSync.pull] so the rule can be tested without a client.
 * An unparseable or missing timestamp reads as 0, i.e. never newer -- a cloud
 * row that cannot say when it changed does not get to overwrite a phone that
 * can. Equal timestamps are not newer either: the same second is the same save.
 */
internal fun cloudIsNewer(cloudUpdatedAt: String?, localUpdatedAtMillis: Long): Boolean =
    (CloudTime.parseMillis(cloudUpdatedAt) ?: 0L) > localUpdatedAtMillis

private fun BusinessProfile.toCloud() = CloudSettings(
    businessName = businessName,
    ownerName = ownerName,
    phone = phone,
    email = email,
    licenseNumber = licenseNumber,
    taxRate = defaultTaxRatePercent,
    markup = defaultMarkupPercent,
    laborRate = defaultLaborRatePerFt,
    postSpacing = defaultPostSpacingFt,
    concreteBags = defaultConcreteBagsPerPost,
    panelWidth = defaultPanelWidthFt,
    panelHeight = defaultPanelHeightFt,
    minJobCharge = defaultMinimumJobCharge,
    minLaborCharge = defaultMinimumLaborCharge,
    toolsList = defaultToolsListCsv,
    orderTemplate = orderEmailTemplate,
    hoaTemplate = hoaEmailTemplate,
    reviewTemplate = reviewRequestTemplate,
    pricesReviewed = pricesReviewed
)

/**
 * Keeps this device's personal and credential fields; takes the rest from the
 * cloud -- but only where the cloud actually said something.
 *
 * Every line is `cloud.x ?: x`. There is no literal on the right-hand side of
 * any of them, and there must never be one: the fallback for "the cloud did not
 * say" is this phone's own answer, which somebody at this company typed. A
 * literal here is a price nobody chose, saved as theirs by the next push.
 *
 * Note what has NOT changed: a value the cloud does send still wins outright,
 * including a real zero. `markup: 0` is a company that has decided not to mark
 * up, and it must travel; only absence is refused.
 *
 * The honest cost: for a key no client has ever written, two phones now keep
 * their own answers instead of both being set to the same invented one. They
 * can therefore differ until somebody saves Settings, which pushes every key
 * and closes the gap. That is the better failure -- two phones showing each
 * device's real starting default, which Settings displays and anybody can
 * correct, rather than both quietly agreeing on a markup nobody chose.
 */
internal fun BusinessProfile.mergedWith(cloud: CloudSettings) = copy(
    businessName = cloud.businessName ?: businessName,
    ownerName = cloud.ownerName ?: ownerName,
    phone = cloud.phone ?: phone,
    email = cloud.email ?: email,
    licenseNumber = cloud.licenseNumber ?: licenseNumber,
    defaultTaxRatePercent = cloud.taxRate ?: defaultTaxRatePercent,
    defaultMarkupPercent = cloud.markup ?: defaultMarkupPercent,
    defaultLaborRatePerFt = cloud.laborRate ?: defaultLaborRatePerFt,
    defaultPostSpacingFt = cloud.postSpacing ?: defaultPostSpacingFt,
    defaultConcreteBagsPerPost = cloud.concreteBags ?: defaultConcreteBagsPerPost,
    defaultPanelWidthFt = cloud.panelWidth ?: defaultPanelWidthFt,
    defaultPanelHeightFt = cloud.panelHeight ?: defaultPanelHeightFt,
    defaultMinimumJobCharge = cloud.minJobCharge ?: defaultMinimumJobCharge,
    defaultMinimumLaborCharge = cloud.minLaborCharge ?: defaultMinimumLaborCharge,
    defaultToolsListCsv = cloud.toolsList?.ifBlank { defaultToolsListCsv } ?: defaultToolsListCsv,
    orderEmailTemplate = cloud.orderTemplate?.ifBlank { orderEmailTemplate } ?: orderEmailTemplate,
    hoaEmailTemplate = cloud.hoaTemplate?.ifBlank { hoaEmailTemplate } ?: hoaEmailTemplate,
    reviewRequestTemplate = cloud.reviewTemplate?.ifBlank { reviewRequestTemplate } ?: reviewRequestTemplate,
    // One-way on purpose: once anyone at the company has reviewed the
    // prices, a phone that has not synced lately must not un-review them.
    // Absence was already harmless here -- `||` with false changes nothing --
    // but it is nullable for the same reason as the rest: so the type says
    // "the cloud may not have answered" rather than leaving a reader to work
    // out that false happens to be safe.
    pricesReviewed = pricesReviewed || (cloud.pricesReviewed ?: false)
)

/**
 * The same merge for a phone that may not see money: every money field is
 * simply absent, so nothing here can write one.
 */
private fun BusinessProfile.mergedWith(crew: CrewSettings) = copy(
    businessName = crew.businessName ?: businessName,
    ownerName = crew.ownerName ?: ownerName,
    phone = crew.phone ?: phone,
    email = crew.email ?: email,
    licenseNumber = crew.licenseNumber ?: licenseNumber,
    defaultPostSpacingFt = crew.postSpacing ?: defaultPostSpacingFt,
    defaultConcreteBagsPerPost = crew.concreteBags ?: defaultConcreteBagsPerPost,
    defaultPanelWidthFt = crew.panelWidth ?: defaultPanelWidthFt,
    defaultPanelHeightFt = crew.panelHeight ?: defaultPanelHeightFt,
    defaultToolsListCsv = crew.toolsList?.ifBlank { defaultToolsListCsv } ?: defaultToolsListCsv,
    orderEmailTemplate = crew.orderTemplate?.ifBlank { orderEmailTemplate } ?: orderEmailTemplate,
    hoaEmailTemplate = crew.hoaTemplate?.ifBlank { hoaEmailTemplate } ?: hoaEmailTemplate,
    reviewRequestTemplate = crew.reviewTemplate?.ifBlank { reviewRequestTemplate } ?: reviewRequestTemplate
)

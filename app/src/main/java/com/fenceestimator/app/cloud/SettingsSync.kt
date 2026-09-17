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
 */
@Serializable
data class CloudSettings(
    @SerialName("business_name") val businessName: String = "",
    @SerialName("owner_name") val ownerName: String = "",
    val phone: String = "",
    val email: String = "",
    @SerialName("license_number") val licenseNumber: String = "",
    @SerialName("tax_rate") val taxRate: Double = 7.0,
    @SerialName("markup") val markup: Double = 15.0,
    @SerialName("labor_rate") val laborRate: Double = 8.0,
    @SerialName("post_spacing") val postSpacing: Float = 6f,
    @SerialName("concrete_bags") val concreteBags: Float = 1f,
    @SerialName("panel_width") val panelWidth: Float = 6f,
    @SerialName("panel_height") val panelHeight: Float = 6f,
    @SerialName("min_job_charge") val minJobCharge: Double = 200.0,
    @SerialName("tools_list") val toolsList: String = "",
    @SerialName("order_template") val orderTemplate: String = "",
    @SerialName("hoa_template") val hoaTemplate: String = "",
    @SerialName("review_template") val reviewTemplate: String = "",
    @SerialName("prices_reviewed") val pricesReviewed: Boolean = false
)

/**
 * What crew_settings() returns: the non-money keys only, and every one of them
 * nullable. A null here means "that key was not in the answer", which must
 * leave the local value alone -- reusing [CloudSettings] would have handed the
 * merge its own defaults (markup 15, labor_rate 8) and written those over
 * whatever the phone already had, which is the "empty answer reads as a real
 * answer" mistake wearing a different hat.
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

@Serializable
private data class SettingsRow(
    @SerialName("updated_at") val updatedAt: String? = null,
    @SerialName("company_id") val companyId: String,
    val settings: CloudSettings
)

object SettingsSync {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

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
            val cloudChangedAt = CloudTime.parseMillis(row.updatedAt) ?: 0L
            if (cloudChangedAt <= local.updatedAt) return@runCatching false

            store.save(local.mergedWith(row.settings), stamp = false)
            true
        }
    }
}

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
    toolsList = defaultToolsListCsv,
    orderTemplate = orderEmailTemplate,
    hoaTemplate = hoaEmailTemplate,
    reviewTemplate = reviewRequestTemplate,
    pricesReviewed = pricesReviewed
)

/** Keeps this device's personal and credential fields; takes the rest from the cloud. */
private fun BusinessProfile.mergedWith(cloud: CloudSettings) = copy(
    businessName = cloud.businessName,
    ownerName = cloud.ownerName,
    phone = cloud.phone,
    email = cloud.email,
    licenseNumber = cloud.licenseNumber,
    defaultTaxRatePercent = cloud.taxRate,
    defaultMarkupPercent = cloud.markup,
    defaultLaborRatePerFt = cloud.laborRate,
    defaultPostSpacingFt = cloud.postSpacing,
    defaultConcreteBagsPerPost = cloud.concreteBags,
    defaultPanelWidthFt = cloud.panelWidth,
    defaultPanelHeightFt = cloud.panelHeight,
    defaultMinimumJobCharge = cloud.minJobCharge,
    defaultToolsListCsv = cloud.toolsList.ifBlank { defaultToolsListCsv },
    orderEmailTemplate = cloud.orderTemplate.ifBlank { orderEmailTemplate },
    hoaEmailTemplate = cloud.hoaTemplate.ifBlank { hoaEmailTemplate },
    reviewRequestTemplate = cloud.reviewTemplate.ifBlank { reviewRequestTemplate },
    // One-way on purpose: once anyone at the company has reviewed the
    // prices, a phone that has not synced lately must not un-review them.
    pricesReviewed = pricesReviewed || cloud.pricesReviewed
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

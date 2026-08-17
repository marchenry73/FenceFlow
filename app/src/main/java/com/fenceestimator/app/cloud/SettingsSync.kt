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
    @SerialName("review_template") val reviewTemplate: String = ""
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
            val row = SupabaseModule.client.postgrest.from("company_settings")
                .select { filter { eq("company_id", companyId) } }
                .decodeSingleOrNull<SettingsRow>()
                ?: return@runCatching false

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
    reviewTemplate = reviewRequestTemplate
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
    reviewRequestTemplate = cloud.reviewTemplate.ifBlank { reviewRequestTemplate }
)

package com.fenceestimator.app.data

import android.content.Context
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore by preferencesDataStore(name = "business_settings")

enum class ThemeMode { SYSTEM, LIGHT, DARK }

/**
 * [tag] is the BCP-47 code that selects the matching res/values-xx folder.
 * [rtl] drives layout direction -- Arabic has to mirror the whole UI, not
 * just swap the words.
 */
enum class AppLanguage(val tag: String, val displayName: String, val rtl: Boolean = false) {
    ENGLISH("en", "English"),
    SPANISH("es", "Espanol"),
    FRENCH("fr", "Francais"),
    PORTUGUESE("pt", "Portugues"),
    CHINESE("zh", "中文"),
    HINDI("hi", "हिन्दी"),
    ARABIC("ar", "العربية", rtl = true),
    RUSSIAN("ru", "Русский")
}

private const val DEFAULT_ORDER_TEMPLATE =
    "Hi,\n\nPlease supply the materials below for the following job, accepted and ready to schedule:\n\n" +
        "Customer: {customerName}\nAddress: {address}\n\n{lineItems}\n\nTotal: {total}\n\n" +
        "Please confirm availability and lead time.\n\nThanks,\n{businessName}"

private const val DEFAULT_ORDER_TEMPLATE_ES =
    "Hola,\n\nPor favor suministren los materiales a continuacion para el siguiente trabajo, aceptado y listo para programar:\n\n" +
        "Cliente: {customerName}\nDireccion: {address}\n\n{lineItems}\n\nTotal: {total}\n\n" +
        "Por favor confirmen disponibilidad y tiempo de entrega.\n\nGracias,\n{businessName}"

private const val DEFAULT_HOA_TEMPLATE =
    "Dear HOA Board,\n\nWe are requesting approval to install a new fence at the property below.\n\n" +
        "Property: {address}\nFence type: {fenceType}\nHeight: {height} ft\nMaterial/Color: {material}\n\n" +
        "Please let us know if you require any additional information or documentation to approve this request.\n\n" +
        "Thank you,\n{businessName}\n{phone}"

private const val DEFAULT_HOA_TEMPLATE_ES =
    "Estimada Junta de la HOA,\n\nSolicitamos autorizacion para instalar una cerca nueva en la siguiente propiedad.\n\n" +
        "Propiedad: {address}\nTipo de cerca: {fenceType}\nAltura: {height} pies\nMaterial/Color: {material}\n\n" +
        "Haganos saber si necesitan informacion o documentacion adicional para aprobar esta solicitud.\n\n" +
        "Gracias,\n{businessName}\n{phone}"

private const val DEFAULT_REVIEW_TEMPLATE =
    "Hi {customerName}, thanks again for choosing {businessName} for your fence! " +
        "If you have a minute, a quick review would mean a lot to us and helps other folks find us. Thank you!"

private const val DEFAULT_REVIEW_TEMPLATE_ES =
    "Hola {customerName}, gracias por elegir a {businessName} para su cerca! " +
        "Si tiene un momento, una breve resena significaria mucho para nosotros y ayuda a que otros nos encuentren. Gracias!"

data class BusinessProfile(
    val businessName: String = "",
    val ownerName: String = "",
    val phone: String = "",
    val email: String = "",
    val licenseNumber: String = "",
    val defaultTaxRatePercent: Double = 7.0,
    val defaultMarkupPercent: Double = 15.0,
    val defaultPostSpacingFt: Float = 6f,
    val defaultConcreteBagsPerPost: Float = 1f,
    val defaultLaborRatePerFt: Double = 8.0,
    val defaultPanelWidthFt: Float = 6f,
    val defaultPanelHeightFt: Float = 6f,
    val defaultMinimumJobCharge: Double = 200.0,
    val defaultToolsListCsv: String = "Post hole digger,4' level,Drill/driver,Circular saw,Tape measure,Post level,Wheelbarrow,Safety glasses,Gloves,String line",
    val preferredManufacturerId: Long = 0L,
    val orderEmailTemplate: String = DEFAULT_ORDER_TEMPLATE,
    val hoaEmailTemplate: String = DEFAULT_HOA_TEMPLATE,
    val reviewRequestTemplate: String = DEFAULT_REVIEW_TEMPLATE,
    /**
     * The contractor's own Square access token, kept on this device only.
     * It is never sent to the FenceFlow cloud -- each business bills into
     * its own Square account, and nobody else should be able to read it.
     */
    val squareAccessToken: String = "",
    val squareLocationId: String = "",
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val language: AppLanguage = AppLanguage.ENGLISH
) {
    companion object {
        fun defaultOrderTemplate(language: AppLanguage) = if (language == AppLanguage.SPANISH) DEFAULT_ORDER_TEMPLATE_ES else DEFAULT_ORDER_TEMPLATE
        fun defaultHoaTemplate(language: AppLanguage) = if (language == AppLanguage.SPANISH) DEFAULT_HOA_TEMPLATE_ES else DEFAULT_HOA_TEMPLATE
        fun defaultReviewTemplate(language: AppLanguage) = if (language == AppLanguage.SPANISH) DEFAULT_REVIEW_TEMPLATE_ES else DEFAULT_REVIEW_TEMPLATE
    }
}

class SettingsStore(private val context: Context) {
    private object Keys {
        val BUSINESS_NAME = stringPreferencesKey("business_name")
        val OWNER_NAME = stringPreferencesKey("owner_name")
        val PHONE = stringPreferencesKey("phone")
        val EMAIL = stringPreferencesKey("email")
        val LICENSE = stringPreferencesKey("license")
        val TAX_RATE = doublePreferencesKey("tax_rate")
        val MARKUP = doublePreferencesKey("markup")
        val POST_SPACING = floatPreferencesKey("post_spacing")
        val CONCRETE_BAGS = floatPreferencesKey("concrete_bags")
        val LABOR_RATE = doublePreferencesKey("labor_rate")
        val PANEL_WIDTH = floatPreferencesKey("panel_width")
        val PANEL_HEIGHT = floatPreferencesKey("panel_height")
        val MIN_JOB_CHARGE = doublePreferencesKey("min_job_charge")
        val TOOLS_LIST = stringPreferencesKey("tools_list")
        val PREFERRED_MANUFACTURER = longPreferencesKey("preferred_manufacturer")
        val ORDER_TEMPLATE = stringPreferencesKey("order_template")
        val HOA_TEMPLATE = stringPreferencesKey("hoa_template")
        val REVIEW_TEMPLATE = stringPreferencesKey("review_template")
        val SQUARE_TOKEN = stringPreferencesKey("square_token")
        val SQUARE_LOCATION = stringPreferencesKey("square_location")
        val THEME_MODE = stringPreferencesKey("theme_mode")
        val LANGUAGE = stringPreferencesKey("language")
    }

    val profile: Flow<BusinessProfile> = context.dataStore.data.map { prefs ->
        val language = runCatching { AppLanguage.valueOf(prefs[Keys.LANGUAGE] ?: "") }.getOrDefault(AppLanguage.ENGLISH)
        BusinessProfile(
            businessName = prefs[Keys.BUSINESS_NAME] ?: "",
            ownerName = prefs[Keys.OWNER_NAME] ?: "",
            phone = prefs[Keys.PHONE] ?: "",
            email = prefs[Keys.EMAIL] ?: "",
            licenseNumber = prefs[Keys.LICENSE] ?: "",
            defaultTaxRatePercent = prefs[Keys.TAX_RATE] ?: 7.0,
            defaultMarkupPercent = prefs[Keys.MARKUP] ?: 15.0,
            defaultPostSpacingFt = prefs[Keys.POST_SPACING] ?: 6f,
            defaultConcreteBagsPerPost = prefs[Keys.CONCRETE_BAGS] ?: 1f,
            defaultLaborRatePerFt = prefs[Keys.LABOR_RATE] ?: 8.0,
            defaultPanelWidthFt = prefs[Keys.PANEL_WIDTH] ?: 6f,
            defaultPanelHeightFt = prefs[Keys.PANEL_HEIGHT] ?: 6f,
            defaultMinimumJobCharge = prefs[Keys.MIN_JOB_CHARGE] ?: 200.0,
            defaultToolsListCsv = prefs[Keys.TOOLS_LIST]
                ?: "Post hole digger,4' level,Drill/driver,Circular saw,Tape measure,Post level,Wheelbarrow,Safety glasses,Gloves,String line",
            preferredManufacturerId = prefs[Keys.PREFERRED_MANUFACTURER] ?: 0L,
            orderEmailTemplate = prefs[Keys.ORDER_TEMPLATE] ?: BusinessProfile.defaultOrderTemplate(language),
            hoaEmailTemplate = prefs[Keys.HOA_TEMPLATE] ?: BusinessProfile.defaultHoaTemplate(language),
            reviewRequestTemplate = prefs[Keys.REVIEW_TEMPLATE] ?: BusinessProfile.defaultReviewTemplate(language),
            squareAccessToken = prefs[Keys.SQUARE_TOKEN].orEmpty(),
            squareLocationId = prefs[Keys.SQUARE_LOCATION].orEmpty(),
            themeMode = runCatching { ThemeMode.valueOf(prefs[Keys.THEME_MODE] ?: "") }.getOrDefault(ThemeMode.SYSTEM),
            language = language
        )
    }

    suspend fun save(profile: BusinessProfile) {
        context.dataStore.edit { prefs ->
            prefs[Keys.BUSINESS_NAME] = profile.businessName
            prefs[Keys.OWNER_NAME] = profile.ownerName
            prefs[Keys.PHONE] = profile.phone
            prefs[Keys.EMAIL] = profile.email
            prefs[Keys.LICENSE] = profile.licenseNumber
            prefs[Keys.TAX_RATE] = profile.defaultTaxRatePercent
            prefs[Keys.MARKUP] = profile.defaultMarkupPercent
            prefs[Keys.POST_SPACING] = profile.defaultPostSpacingFt
            prefs[Keys.CONCRETE_BAGS] = profile.defaultConcreteBagsPerPost
            prefs[Keys.LABOR_RATE] = profile.defaultLaborRatePerFt
            prefs[Keys.PANEL_WIDTH] = profile.defaultPanelWidthFt
            prefs[Keys.PANEL_HEIGHT] = profile.defaultPanelHeightFt
            prefs[Keys.MIN_JOB_CHARGE] = profile.defaultMinimumJobCharge
            prefs[Keys.TOOLS_LIST] = profile.defaultToolsListCsv
            prefs[Keys.PREFERRED_MANUFACTURER] = profile.preferredManufacturerId
            prefs[Keys.ORDER_TEMPLATE] = profile.orderEmailTemplate
            prefs[Keys.HOA_TEMPLATE] = profile.hoaEmailTemplate
            prefs[Keys.REVIEW_TEMPLATE] = profile.reviewRequestTemplate
            prefs[Keys.SQUARE_TOKEN] = profile.squareAccessToken
            prefs[Keys.SQUARE_LOCATION] = profile.squareLocationId
            prefs[Keys.THEME_MODE] = profile.themeMode.name
            prefs[Keys.LANGUAGE] = profile.language.name
        }
    }
}

package com.fenceestimator.app.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.floatPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
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
    "Hola,\n\nPor favor suministren los materiales a continuación para el siguiente trabajo, aceptado y listo para programar:\n\n" +
        "Cliente: {customerName}\nDirección: {address}\n\n{lineItems}\n\nTotal: {total}\n\n" +
        "Por favor confirmen disponibilidad y tiempo de entrega.\n\nGracias,\n{businessName}"

private const val DEFAULT_HOA_TEMPLATE =
    "Dear HOA Board,\n\nWe are requesting approval to install a new fence at the property below.\n\n" +
        "Property: {address}\nFence type: {fenceType}\nHeight: {height} ft\nMaterial/Color: {material}\n\n" +
        "Please let us know if you require any additional information or documentation to approve this request.\n\n" +
        "Thank you,\n{businessName}\n{phone}"

private const val DEFAULT_HOA_TEMPLATE_ES =
    "Estimada Junta de la HOA,\n\nSolicitamos autorización para instalar una cerca nueva en la siguiente propiedad.\n\n" +
        "Propiedad: {address}\nTipo de cerca: {fenceType}\nAltura: {height} pies\nMaterial/Color: {material}\n\n" +
        "Háganos saber si necesitan información o documentación adicional para aprobar esta solicitud.\n\n" +
        "Gracias,\n{businessName}\n{phone}"

private const val DEFAULT_REVIEW_TEMPLATE =
    "Hi {customerName}, thanks again for choosing {businessName} for your fence! " +
        "If you have a minute, a quick review would mean a lot to us and helps other folks find us. Thank you!"

private const val DEFAULT_REVIEW_TEMPLATE_ES =
    "Hola {customerName}, ¡gracias por elegir a {businessName} para su cerca! " +
        "Si tiene un momento, una breve reseña significaría mucho para nosotros y ayuda a que otros nos encuentren. ¡Gracias!"

data class BusinessProfile(
    val businessName: String = "",
    val ownerName: String = "",
    val phone: String = "",
    val email: String = "",
    val licenseNumber: String = "",
    val defaultTaxRatePercent: Double = 7.0,
    val defaultMarkupPercent: Double = 0.0,
    val defaultPostSpacingFt: Float = 6f,
    val defaultConcreteBagsPerPost: Float = 1f,
    val defaultLaborRatePerFt: Double = 8.0,
    val defaultPanelWidthFt: Float = 6f,
    val defaultPanelHeightFt: Float = 6f,
    val defaultMinimumJobCharge: Double = 200.0,
    val defaultToolsListCsv: String = "Post hole digger,4' level,Drill/driver,Circular saw,Tape measure,Post level,Wheelbarrow,Safety glasses,Gloves,String line",

    // ---- How fast this company actually works ----
    // Every crew is different, and a schedule built on someone else's numbers
    // is a schedule that slips. These drive the duration estimate.
    /** Feet of standard fence this crew installs in one working day. */
    val feetPerDay: Double = 125.0,
    /** Length of a working day before breaks. */
    val workdayHours: Double = 8.0,
    /** Unpaid break time in a day -- real hours that aren't install hours. */
    val breakHoursPerDay: Double = 1.0,
    /** Hanging and squaring one gate. Slow, fiddly work regardless of width. */
    val hoursPerGate: Double = 1.5,
    /** Clearing one tree or stump off the fence line. */
    val hoursPerTree: Double = 0.25,
    /** Working around an obstacle that isn't a tree -- rock, a shed, a slope. */
    val hoursPerObstacle: Double = 0.5,
    /** Extra layout, bracing and a deeper hole at each corner. */
    val hoursPerCorner: Double = 0.4,
    /** Mobilising, unloading and the final walkthrough, whatever the size. */
    val setupHours: Double = 1.0,
    /** Pulling and hauling off an old fence, per foot. */
    val teardownHoursPerFoot: Double = 0.02,
    val preferredManufacturerId: Long = 0L,
    val orderEmailTemplate: String = DEFAULT_ORDER_TEMPLATE,
    val hoaEmailTemplate: String = DEFAULT_HOA_TEMPLATE,
    val reviewRequestTemplate: String = DEFAULT_REVIEW_TEMPLATE,
    /**
     * The terms printed on the contract the customer signs.
     *
     * Editable per company on purpose. Every fencing business has its own
     * warranty period, its own deposit rule, its own line about property
     * lines and utility locates -- and a contractor cannot use terms they
     * cannot change. The default below is a workable starting point, NOT
     * legal advice; anyone selling real work should have it read once by an
     * attorney in their own state.
     *
     * Placeholders are filled in when the document is produced.
     */
    val contractTerms: String = DEFAULT_CONTRACT_TERMS,
    /**
     * Which figures appear on the home screen, in order.
     *
     * A dashboard showing everything shows nothing -- the number somebody
     * checks every morning is different for every business, and a fixed set
     * means most of it is scenery they learn to look past.
     */
    val homeCardsCsv: String = HomeCard.DEFAULT_CSV,
    /** False until the first-run tour has been seen or skipped. */
    val hasSeenTour: Boolean = false,
    /**
     * When these settings were last changed on this device.
     *
     * Without it the cloud copy always won a pull, newer or not -- so a save
     * whose push did not land was silently reverted on the next app start and
     * looked exactly like the save never worked.
     */
    val updatedAt: Long = 0L,
    /**
     * The contractor's own Square access token, kept on this device only.
     * It is never sent to the FenceFlow cloud -- each business bills into
     * its own Square account, and nobody else should be able to read it.
     */
    val squareAccessToken: String = "",
    val squareLocationId: String = "",
    /**
     * Minutes of inactivity before the app locks. 0 disables it.
     * Device-local by design: a crew phone left in a truck may warrant a
     * tighter timeout than the owner's own phone.
     */
    val autoLockMinutes: Int = 0,
    val biometricUnlockEnabled: Boolean = false,
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val language: AppLanguage = AppLanguage.ENGLISH
) {
    companion object {
        fun defaultContractTerms() = DEFAULT_CONTRACT_TERMS
        fun defaultOrderTemplate(language: AppLanguage) = if (language == AppLanguage.SPANISH) DEFAULT_ORDER_TEMPLATE_ES else DEFAULT_ORDER_TEMPLATE
        fun defaultHoaTemplate(language: AppLanguage) = if (language == AppLanguage.SPANISH) DEFAULT_HOA_TEMPLATE_ES else DEFAULT_HOA_TEMPLATE
        fun defaultReviewTemplate(language: AppLanguage) = if (language == AppLanguage.SPANISH) DEFAULT_REVIEW_TEMPLATE_ES else DEFAULT_REVIEW_TEMPLATE
    }
}

class SettingsStore(private val context: Context) {

    /**
     * Records that the tour has been seen, without going through a full profile
     * save -- that would write every setting back and race with anyone editing
     * Settings at the same moment.
     */
    suspend fun markTourSeen() {
        context.dataStore.edit { it[Keys.SEEN_TOUR] = true }
    }

    private object Keys {
        val BUSINESS_NAME = stringPreferencesKey("business_name")
        val OWNER_NAME = stringPreferencesKey("owner_name")
        val PHONE = stringPreferencesKey("phone")
        val EMAIL = stringPreferencesKey("email")
        val LICENSE = stringPreferencesKey("license")
        val CONTRACT_TERMS = stringPreferencesKey("contract_terms")
        val HOME_CARDS = stringPreferencesKey("home_cards")
        val SEEN_TOUR = androidx.datastore.preferences.core.booleanPreferencesKey("seen_tour")
        val UPDATED_AT = androidx.datastore.preferences.core.longPreferencesKey("settings_updated_at")
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
        val AUTO_LOCK_MINUTES = intPreferencesKey("auto_lock_minutes")
        val BIOMETRIC_UNLOCK = booleanPreferencesKey("biometric_unlock")
        val THEME_MODE = stringPreferencesKey("theme_mode")
        val LANGUAGE = stringPreferencesKey("language")
        // How fast this crew works -- drives every duration estimate.
        val FEET_PER_DAY = doublePreferencesKey("feet_per_day")
        val WORKDAY_HOURS = doublePreferencesKey("workday_hours")
        val BREAK_HOURS = doublePreferencesKey("break_hours")
        val HOURS_PER_GATE = doublePreferencesKey("hours_per_gate")
        val HOURS_PER_TREE = doublePreferencesKey("hours_per_tree")
        val HOURS_PER_OBSTACLE = doublePreferencesKey("hours_per_obstacle")
        val HOURS_PER_CORNER = doublePreferencesKey("hours_per_corner")
        val SETUP_HOURS = doublePreferencesKey("setup_hours")
        val TEARDOWN_HOURS_FT = doublePreferencesKey("teardown_hours_ft")
    }

    val profile: Flow<BusinessProfile> = context.dataStore.data.map { prefs ->
        val language = runCatching { AppLanguage.valueOf(prefs[Keys.LANGUAGE] ?: "") }.getOrDefault(AppLanguage.ENGLISH)
        BusinessProfile(
            businessName = prefs[Keys.BUSINESS_NAME] ?: "",
            ownerName = prefs[Keys.OWNER_NAME] ?: "",
            phone = prefs[Keys.PHONE] ?: "",
            email = prefs[Keys.EMAIL] ?: "",
            licenseNumber = prefs[Keys.LICENSE] ?: "",
            contractTerms = prefs[Keys.CONTRACT_TERMS] ?: DEFAULT_CONTRACT_TERMS,
            homeCardsCsv = prefs[Keys.HOME_CARDS] ?: HomeCard.DEFAULT_CSV,
            hasSeenTour = prefs[Keys.SEEN_TOUR] ?: false,
            updatedAt = prefs[Keys.UPDATED_AT] ?: 0L,
            defaultTaxRatePercent = prefs[Keys.TAX_RATE] ?: 7.0,
            defaultMarkupPercent = prefs[Keys.MARKUP] ?: 0.0,
            defaultPostSpacingFt = prefs[Keys.POST_SPACING] ?: 6f,
            defaultConcreteBagsPerPost = prefs[Keys.CONCRETE_BAGS] ?: 1f,
            defaultLaborRatePerFt = prefs[Keys.LABOR_RATE] ?: 8.0,
            feetPerDay = prefs[Keys.FEET_PER_DAY] ?: 125.0,
            workdayHours = prefs[Keys.WORKDAY_HOURS] ?: 8.0,
            breakHoursPerDay = prefs[Keys.BREAK_HOURS] ?: 1.0,
            hoursPerGate = prefs[Keys.HOURS_PER_GATE] ?: 1.5,
            hoursPerTree = prefs[Keys.HOURS_PER_TREE] ?: 0.25,
            hoursPerObstacle = prefs[Keys.HOURS_PER_OBSTACLE] ?: 0.5,
            hoursPerCorner = prefs[Keys.HOURS_PER_CORNER] ?: 0.4,
            setupHours = prefs[Keys.SETUP_HOURS] ?: 1.0,
            teardownHoursPerFoot = prefs[Keys.TEARDOWN_HOURS_FT] ?: 0.02,
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
            autoLockMinutes = prefs[Keys.AUTO_LOCK_MINUTES] ?: 0,
            biometricUnlockEnabled = prefs[Keys.BIOMETRIC_UNLOCK] ?: false,
            themeMode = runCatching { ThemeMode.valueOf(prefs[Keys.THEME_MODE] ?: "") }.getOrDefault(ThemeMode.SYSTEM),
            language = language
        )
    }

    /**
     * Wipes every stored setting, including the Square access token.
     *
     * Used when the phone changes hands between accounts. Business name,
     * licence number, pricing and email templates all belong to one company --
     * but the Square token is the sharp one: it is a live payment credential,
     * and leaving it behind would let whoever signs in next take money into the
     * previous company's account.
     */
    suspend fun clearAll() {
        context.dataStore.edit { it.clear() }
    }

    /**
     * @param stamp false when writing values that came FROM the cloud, so a
     *   pull does not make itself look like the newest edit and win every
     *   subsequent comparison.
     */
    suspend fun save(profile: BusinessProfile, stamp: Boolean = true) {
        val toWrite = if (stamp) profile.copy(updatedAt = System.currentTimeMillis()) else profile
        val profile = toWrite
        context.dataStore.edit { prefs ->
            prefs[Keys.BUSINESS_NAME] = profile.businessName
            prefs[Keys.OWNER_NAME] = profile.ownerName
            prefs[Keys.PHONE] = profile.phone
            prefs[Keys.EMAIL] = profile.email
            prefs[Keys.LICENSE] = profile.licenseNumber
            prefs[Keys.CONTRACT_TERMS] = profile.contractTerms
            prefs[Keys.HOME_CARDS] = profile.homeCardsCsv
            prefs[Keys.SEEN_TOUR] = profile.hasSeenTour
            prefs[Keys.UPDATED_AT] = profile.updatedAt
            prefs[Keys.TAX_RATE] = profile.defaultTaxRatePercent
            prefs[Keys.MARKUP] = profile.defaultMarkupPercent
            prefs[Keys.POST_SPACING] = profile.defaultPostSpacingFt
            prefs[Keys.CONCRETE_BAGS] = profile.defaultConcreteBagsPerPost
            prefs[Keys.LABOR_RATE] = profile.defaultLaborRatePerFt
            prefs[Keys.FEET_PER_DAY] = profile.feetPerDay
            prefs[Keys.WORKDAY_HOURS] = profile.workdayHours
            prefs[Keys.BREAK_HOURS] = profile.breakHoursPerDay
            prefs[Keys.HOURS_PER_GATE] = profile.hoursPerGate
            prefs[Keys.HOURS_PER_TREE] = profile.hoursPerTree
            prefs[Keys.HOURS_PER_OBSTACLE] = profile.hoursPerObstacle
            prefs[Keys.HOURS_PER_CORNER] = profile.hoursPerCorner
            prefs[Keys.SETUP_HOURS] = profile.setupHours
            prefs[Keys.TEARDOWN_HOURS_FT] = profile.teardownHoursPerFoot
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
            prefs[Keys.AUTO_LOCK_MINUTES] = profile.autoLockMinutes
            prefs[Keys.BIOMETRIC_UNLOCK] = profile.biometricUnlockEnabled
            prefs[Keys.THEME_MODE] = profile.themeMode.name
            prefs[Keys.LANGUAGE] = profile.language.name
        }
    }
}

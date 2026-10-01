package com.fenceestimator.app.data

import android.content.Context
import androidx.datastore.preferences.core.MutablePreferences
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
 * The languages this app actually speaks.
 *
 * [tag] is the BCP-47 code selecting the matching res/values-xx folder.
 * [rtl] is kept for the day a right-to-left language is added properly; none
 * of the three below needs it.
 *
 * Cut from eight to three. The other five were offered in the settings list
 * but had no translated documents behind them, so choosing one changed a
 * little of the interface and none of the estimate, contract or invoice the
 * customer receives. A language that half-works is worse than one that is not
 * offered: it makes the app look broken at exactly the moment somebody is
 * showing it to a customer.
 *
 * Arabic also needs the whole interface mirrored, which is a piece of work in
 * its own right rather than a translation.
 *
 * Written in each language's own spelling, accents included -- a language list
 * that cannot spell its own languages does not inspire confidence in the rest.
 */
enum class AppLanguage(val tag: String, val displayName: String, val rtl: Boolean = false) {
    ENGLISH("en", "English"),
    SPANISH("es", "Español"),
    FRENCH("fr", "Français")
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
    /**
     * Least this company charges for LABOUR on a job, before markup and tax and
     * with materials charged on top. 0 is off, which is what every company that
     * has never set it reads as -- and off has to mean untouched arithmetic.
     *
     * Defaults to 0 rather than 200 like the job floor above it: a default that
     * put a floor under every job on every phone that updates is a price change
     * nobody asked for.
     */
    val defaultMinimumLaborCharge: Double = 0.0,
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
     * Whether somebody has looked the starting catalog in the eye.
     *
     * A new company opens with a seeded catalog and seeded labor rates --
     * necessary, or Suggest Quantities produces nothing on day one. But
     * seeded numbers are the founding company's numbers, and the first
     * quote a new owner sends must not quietly carry someone else's
     * prices. This stays false until they either open the catalog from the
     * review card or declare the prices theirs, and the card sits on the
     * home screen until it flips.
     */
    val pricesReviewed: Boolean = false,
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
    /**
     * Square is gone -- card payments run through Stripe alone.
     *
     * The two fields stay, unread, because they hold something somebody typed
     * and this app does not quietly throw away what people entered. Anyone who
     * had connected Square keeps their token where they left it; nothing in
     * the app looks at it any more.
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
    val language: AppLanguage = AppLanguage.ENGLISH,
    /**
     * When the current guest session started, in device millis. 0 means no
     * guest session is running.
     *
     * Stored here rather than in memory so the countdown survives the app
     * being backgrounded and killed -- a contractor who switches apps
     * mid-demo must come back to the same clock, not a fresh one. How long
     * that clock runs is GuestSession.DURATION_MS, not restated here so this
     * comment cannot drift out of step with it again.
     * Device-local only, never synced: guest mode never talks to the cloud,
     * and this field is only ever written by startGuestSession/endGuestSession
     * below, never by [save]'s normal profile-editing path -- [save] does not
     * write it at all, so a profile object read a moment ago cannot bring a
     * finished demo back or end a running one.
     *
     * The theme and language the phone had when the demo began are kept beside
     * this flag, in the same write, and given back when it is cleared. They are
     * not fields here: nothing but the demo's own start and end has any use for
     * them.
     */
    val guestSessionStartedAt: Long = 0L
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

    /** Same shape as [markTourSeen], and stamped so the answer syncs to the company. */
    suspend fun markPricesReviewed() {
        context.dataStore.edit {
            it[Keys.PRICES_REVIEWED] = true
            it[Keys.UPDATED_AT] = System.currentTimeMillis()
        }
    }

    /**
     * Records the guest countdown's start time, and in the SAME write keeps the
     * theme and language this phone has right now. Targeted keys, like
     * [markTourSeen], never the full [save]. Not stamped as an ordinary edit:
     * this is device-local scaffolding for a mode that never syncs, and
     * running it through the normal updatedAt path would make a guest demo
     * look like a real settings change the next time this phone actually
     * signs in and compares clocks with the cloud.
     *
     * Why the copy is made here and nowhere else. A visitor may change theme and
     * language while trying the product -- they are cosmetic and cannot lock
     * anybody out -- and nothing used to put them back, so the last visitor's
     * choice stayed on the handset after the sample jobs were gone. Giving them
     * back needs the values from before the demo, and that copy has to exist
     * (a) before the visitor can change anything, and the flag written here is
     * what opens the demo, and (b) after the app is killed mid-demo, which rules
     * out holding it in memory. One edit of this store does both: there is no
     * moment when the flag exists without the copy, or the copy without the flag.
     *
     * A second call while a demo is already running moves the clock and does NOT
     * copy again -- by then the stored values are the visitor's, and copying
     * them would make the visitor's choices the original. See [beginDemoPrefs].
     */
    suspend fun startGuestSession(startedAtMillis: Long) {
        context.dataStore.edit { beginDemoPrefs(it, startedAtMillis) }
    }

    /**
     * Clears the guest countdown and gives back the theme and language the phone
     * had before the demo began, in one write. Touches nothing else.
     *
     * This is deliberately NOT [clearAll]. clearAll wipes every setting on
     * the phone, which is right when a phone changes hands between real
     * accounts but would be wrong here: ending a guest session must not be
     * able to erase a real business name or template this phone had before
     * (or gets after) the guest detour. See GuestWipe for the data-row half
     * of ending a session; this is only ever the other half, the flag and the
     * two cosmetic choices.
     *
     * One write, so with a copy the demo cannot be over without the choices being
     * back, or back without the demo being over -- and so a second call (the
     * countdown and a sign-in can both end the same demo) finds the copy already
     * spent and changes nothing, instead of putting the old values over
     * something the person chose after the first call. With no copy at all -- a demo that was
     * already running before the copy existed -- it clears the flag and leaves
     * theme and language exactly as they are: it cannot know the originals, and
     * writing defaults would overwrite somebody's real choice. See
     * [endDemoPrefs].
     */
    suspend fun endGuestSession() {
        context.dataStore.edit { endDemoPrefs(it) }
    }

    /**
     * The address that last signed in on this phone, offered in the sign-in
     * box next time so coming back is one field rather than two.
     *
     * The address only. There is deliberately no password key anywhere in this
     * store and there must never be one -- a password written to disk is one
     * backup, one rooted phone or one careless export away from somebody else.
     *
     * Kept out of [BusinessProfile] on purpose: the profile is pushed to the
     * company's cloud settings, and who last signed in on one handset is
     * nobody else's business.
     */
    val lastSignInEmail: Flow<String> = context.dataStore.data.map { it[Keys.LAST_SIGN_IN_EMAIL].orEmpty() }

    /**
     * Whether the snapping hint on the drawing screen has done its job.
     * Device-local and not stamped, like every other one-time hint: it says
     * what this phone's owner has already read, which is nothing the company
     * settings have an opinion about.
     *
     * Held here rather than in rememberSaveable so it survives the app being
     * closed. Saved state only survives rotation, so someone who has used the
     * app for months met the beginner's line again after every cold start,
     * until their first snapped point cleared it for that session.
     */
    val snapIntroSeen: Flow<Boolean> = context.dataStore.data.map { it[Keys.SNAP_INTRO_SEEN] == true }

    /** Same shape as [markTourSeen] -- one key, no full save, no stamp. */
    suspend fun markSnapIntroSeen() {
        context.dataStore.edit { it[Keys.SNAP_INTRO_SEEN] = true }
    }

    /** Only ever called after a sign-in that actually got in. */
    suspend fun saveLastSignInEmail(email: String) {
        context.dataStore.edit { it[Keys.LAST_SIGN_IN_EMAIL] = email }
    }

    /**
     * Theme, language, auto-lock and fingerprint unlock -- the four settings
     * that belong to the handset rather than to the company -- and nothing else.
     *
     * The personal Settings screen saves through here, never through [save].
     * That is the screen for everyone without "Change catalog and settings":
     * crew by default, and foreman, sales and bookkeeper too. [save] writes the
     * whole [BusinessProfile] and stamps UPDATED_AT, and SettingsViewModel then
     * pushes the profile to company_settings. For somebody who may not change
     * company settings both halves are wrong. The push is refused by the
     * server every time, so each theme change would report "saved on this
     * phone only" as though something had failed. And the stamp makes this
     * phone's copy look newer than the cloud's, so a seller or bookkeeper whose
     * phone pulls company settings would stop receiving the owner's changes
     * until the owner happened to save again.
     *
     * Not stamped, for the same reason [startGuestSession] is not: none of the
     * four is in CloudSettings, so a device choice has nothing to win against
     * the cloud and must not look as though it does. Nothing here calls
     * SettingsSync, and nothing should.
     */
    suspend fun saveDevicePrefs(
        themeMode: ThemeMode,
        language: AppLanguage,
        autoLockMinutes: Int,
        biometricUnlockEnabled: Boolean
    ) {
        context.dataStore.edit {
            writeDevicePrefs(it, themeMode, language, autoLockMinutes, biometricUnlockEnabled)
        }
    }

    companion object {
        /**
         * The body of [saveDevicePrefs], kept apart from DataStore so a unit
         * test can run it on a plain [MutablePreferences] and see exactly which
         * keys it touched (DevicePrefsWriteTest). Four keys, and never
         * UPDATED_AT.
         */
        internal fun writeDevicePrefs(
            prefs: MutablePreferences,
            themeMode: ThemeMode,
            language: AppLanguage,
            autoLockMinutes: Int,
            biometricUnlockEnabled: Boolean
        ) {
            // By enum NAME, the way [save] writes them, because [profile] reads
            // them back with valueOf. The language's tag ("fr") would read back
            // as nothing and quietly put the phone back into English.
            prefs[Keys.THEME_MODE] = themeMode.name
            prefs[Keys.LANGUAGE] = language.name
            prefs[Keys.AUTO_LOCK_MINUTES] = autoLockMinutes
            prefs[Keys.BIOMETRIC_UNLOCK] = biometricUnlockEnabled
        }

        // ---- The guest demo's two cosmetic choices ---------------------------------
        //
        // A visitor may change the theme and the language while trying the product.
        // The three DEMO_PREV_* keys hold what the phone had when the demo began,
        // and every way a demo can end gives it back: the countdown running out and
        // a real sign-in both end through endGuestSession, and the sign-in's own
        // account-change wipe ends through clearAll. Each of the three functions
        // below is the body of exactly one of those, so a test can drive them on a
        // plain MutablePreferences (GuestPrefsRestoreTest).

        /**
         * Raises the guest countdown and, only when no demo was already running,
         * keeps the phone's current theme and language beside it. One edit, so the
         * flag and the copy appear together or not at all.
         *
         * The copy is of the stored TEXT, or of its absence. A phone that never
         * chose has no theme key at all, and giving that back means removing the
         * key, not writing "SYSTEM" over a state that only read as SYSTEM because
         * nothing was there.
         *
         * Only on the way from no demo to a demo. While one is running the stored
         * values may already be the visitor's, and copying them would make the
         * visitor's choices the original. A start with [startedAtMillis] of zero is
         * not a demo (see GuestSession.isActive) and copies nothing, so it cannot
         * leave a copy behind with no flag to end it.
         */
        internal fun beginDemoPrefs(prefs: MutablePreferences, startedAtMillis: Long) {
            val running = (prefs[Keys.GUEST_SESSION_STARTED_AT] ?: 0L) != 0L
            if (!running && startedAtMillis != 0L) {
                prefs[Keys.DEMO_PREV_TAKEN] = true
                copyOrForget(prefs, Keys.THEME_MODE, Keys.DEMO_PREV_THEME)
                copyOrForget(prefs, Keys.LANGUAGE, Keys.DEMO_PREV_LANGUAGE)
            }
            prefs[Keys.GUEST_SESSION_STARTED_AT] = startedAtMillis
        }

        /**
         * Gives back the copy, deletes it, and clears the countdown, in that order
         * within one edit.
         *
         * Spending the copy is what makes a second call harmless. The countdown and
         * a sign-in can both end the same demo, and the second finds nothing to give
         * back, so it cannot put the pre-demo values over whatever the person chose
         * after the first ended it. With no copy -- a demo already running before
         * the copy existed -- theme and language are left exactly as they are.
         */
        internal fun endDemoPrefs(prefs: MutablePreferences) {
            giveBackDemoPrefs(prefs)
            prefs[Keys.GUEST_SESSION_STARTED_AT] = 0L
        }

        /**
         * The body of [clearAll]: every key except the remembered sign-in address
         * goes -- and, when a demo's copy exists, the phone's pre-demo theme and
         * language are put back as the last step, instead of being lost with the
         * rest and leaving whatever the visitor chose in their place.
         *
         * The copy is read before the clear, because the clear deletes it. With no
         * copy this is what it was before the demo existed: theme and language
         * included in the wipe.
         */
        internal fun clearAllPrefs(prefs: MutablePreferences) {
            val lastEmail = prefs[Keys.LAST_SIGN_IN_EMAIL]
            val hadCopy = prefs[Keys.DEMO_PREV_TAKEN] == true
            val theme = prefs[Keys.DEMO_PREV_THEME]
            val language = prefs[Keys.DEMO_PREV_LANGUAGE]
            prefs.clear()
            lastEmail?.let { prefs[Keys.LAST_SIGN_IN_EMAIL] = it }
            if (hadCopy) {
                theme?.let { prefs[Keys.THEME_MODE] = it }
                language?.let { prefs[Keys.LANGUAGE] = it }
            }
        }

        private fun giveBackDemoPrefs(prefs: MutablePreferences) {
            if (prefs[Keys.DEMO_PREV_TAKEN] != true) return
            copyOrForget(prefs, Keys.DEMO_PREV_THEME, Keys.THEME_MODE)
            copyOrForget(prefs, Keys.DEMO_PREV_LANGUAGE, Keys.LANGUAGE)
            prefs.remove(Keys.DEMO_PREV_TAKEN)
            prefs.remove(Keys.DEMO_PREV_THEME)
            prefs.remove(Keys.DEMO_PREV_LANGUAGE)
        }

        /** Copies [from]'s value to [to], or removes [to] when [from] has none. */
        private fun copyOrForget(
            prefs: MutablePreferences,
            from: androidx.datastore.preferences.core.Preferences.Key<String>,
            to: androidx.datastore.preferences.core.Preferences.Key<String>
        ) {
            val value = prefs[from]
            if (value != null) prefs[to] = value else prefs.remove(to)
        }

        /**
         * The body of [save], kept apart from DataStore so a unit test can run it on
         * a plain [MutablePreferences] (GuestPrefsRestoreTest).
         *
         * Two things it deliberately does NOT write, both because this is a
         * read-modify-write of a profile object that may be a moment old:
         *
         *  - The guest countdown flag, ever. The field's own doc has always said only
         *    startGuestSession/endGuestSession write it, but this used to write it
         *    back from whatever the profile held -- so a pull that read the profile
         *    just before a demo ended wrote the countdown straight back after the
         *    wipe, and one that read it just before a demo began could write zero
         *    over it once the demo was running.
         *  - Theme, language, auto-lock and fingerprint unlock when [fromCloud]. The
         *    cloud has no opinion on any of them (none is in CloudSettings), so a
         *    write that came from the cloud has nothing to say about them either;
         *    writing back the value it read only ever undid a choice made in between,
         *    including the theme and language a demo's end had just given back.
         */
        internal fun writeProfile(prefs: MutablePreferences, profile: BusinessProfile, fromCloud: Boolean) {
            prefs[Keys.BUSINESS_NAME] = profile.businessName
            prefs[Keys.OWNER_NAME] = profile.ownerName
            prefs[Keys.PHONE] = profile.phone
            prefs[Keys.EMAIL] = profile.email
            prefs[Keys.LICENSE] = profile.licenseNumber
            prefs[Keys.CONTRACT_TERMS] = profile.contractTerms
            prefs[Keys.HOME_CARDS] = profile.homeCardsCsv
            prefs[Keys.SEEN_TOUR] = profile.hasSeenTour
            prefs[Keys.PRICES_REVIEWED] = profile.pricesReviewed
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
            prefs[Keys.MIN_LABOR_CHARGE] = profile.defaultMinimumLaborCharge
            prefs[Keys.TOOLS_LIST] = profile.defaultToolsListCsv
            prefs[Keys.PREFERRED_MANUFACTURER] = profile.preferredManufacturerId
            prefs[Keys.ORDER_TEMPLATE] = profile.orderEmailTemplate
            prefs[Keys.HOA_TEMPLATE] = profile.hoaEmailTemplate
            prefs[Keys.REVIEW_TEMPLATE] = profile.reviewRequestTemplate
            prefs[Keys.SQUARE_TOKEN] = profile.squareAccessToken
            prefs[Keys.SQUARE_LOCATION] = profile.squareLocationId
            if (!fromCloud) {
                prefs[Keys.AUTO_LOCK_MINUTES] = profile.autoLockMinutes
                prefs[Keys.BIOMETRIC_UNLOCK] = profile.biometricUnlockEnabled
                prefs[Keys.THEME_MODE] = profile.themeMode.name
                prefs[Keys.LANGUAGE] = profile.language.name
            }
        }
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
        val PRICES_REVIEWED = androidx.datastore.preferences.core.booleanPreferencesKey("prices_reviewed")
        val SNAP_INTRO_SEEN = androidx.datastore.preferences.core.booleanPreferencesKey("snap_intro_seen")
        val UPDATED_AT = androidx.datastore.preferences.core.longPreferencesKey("settings_updated_at")
        val TAX_RATE = doublePreferencesKey("tax_rate")
        val MARKUP = doublePreferencesKey("markup")
        val POST_SPACING = floatPreferencesKey("post_spacing")
        val CONCRETE_BAGS = floatPreferencesKey("concrete_bags")
        val LABOR_RATE = doublePreferencesKey("labor_rate")
        val PANEL_WIDTH = floatPreferencesKey("panel_width")
        val PANEL_HEIGHT = floatPreferencesKey("panel_height")
        val MIN_JOB_CHARGE = doublePreferencesKey("min_job_charge")
        val MIN_LABOR_CHARGE = doublePreferencesKey("min_labor_charge")
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
        val GUEST_SESSION_STARTED_AT = longPreferencesKey("guest_session_started_at")
        // What the phone had when the guest demo began (beginDemoPrefs). The two
        // strings are the stored enum text, and are ABSENT when the phone had never
        // chosen; the boolean says a copy exists, so "absent" and "no copy" differ.
        // Present only while a demo runs, or until the end of one that was
        // interrupted gives them back.
        val DEMO_PREV_TAKEN = booleanPreferencesKey("guest_demo_prev_taken")
        val DEMO_PREV_THEME = stringPreferencesKey("guest_demo_prev_theme_mode")
        val DEMO_PREV_LANGUAGE = stringPreferencesKey("guest_demo_prev_language")
        val LAST_SIGN_IN_EMAIL = stringPreferencesKey("last_sign_in_email")
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
            pricesReviewed = prefs[Keys.PRICES_REVIEWED] ?: false,
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
            defaultMinimumLaborCharge = prefs[Keys.MIN_LABOR_CHARGE] ?: 0.0,
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
            language = language,
            guestSessionStartedAt = prefs[Keys.GUEST_SESSION_STARTED_AT] ?: 0L
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
     *
     * Everything except [lastSignInEmail]. This runs on every sign-out, and
     * again straight after a sign-in into a different company -- a moment
     * after that sign-in recorded its address -- so clearing it here would
     * mean the box was never filled in the one situation it exists for. It
     * is an email address, not the company's books, prices or payment keys.
     *
     * One more exception, for a demo that is still running. Somebody signing in
     * to a real account mid-demo can reach this (through DataOwnership) before
     * the sign-in's own end of the demo does, and clearing everything would
     * delete the copy of the phone's original theme and language along with the
     * flag -- leaving the visitor's choices on the handset with nothing left to
     * undo them. So while a copy exists it is applied as the wipe's last step;
     * with none, this clears exactly what it always did. See [clearAllPrefs].
     */
    suspend fun clearAll() {
        context.dataStore.edit { clearAllPrefs(it) }
    }

    /**
     * @param stamp false when writing values that came FROM the cloud, so a
     *   pull does not make itself look like the newest edit and win every
     *   subsequent comparison.
     */
    suspend fun save(profile: BusinessProfile, stamp: Boolean = true) {
        val toWrite = if (stamp) profile.copy(updatedAt = System.currentTimeMillis()) else profile
        context.dataStore.edit { writeProfile(it, toWrite, fromCloud = !stamp) }
    }
}

package com.fenceestimator.app.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.AppLanguage
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.SettingsStore
import com.fenceestimator.app.data.ThemeMode
import com.fenceestimator.app.guest.GuestSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The settings a person may change on their own phone, whoever they are.
 *
 * Deliberately just these four. Everything else in [BusinessProfile] belongs
 * to the company, and a screen that cannot touch it is a screen that cannot
 * break it -- so this is the whole of what PersonalSettingsScreen can write.
 */
data class DevicePrefs(
    val themeMode: ThemeMode,
    val language: AppLanguage,
    val autoLockMinutes: Int,
    val biometricUnlockEnabled: Boolean
) {
    companion object {
        fun of(profile: BusinessProfile) = DevicePrefs(
            themeMode = profile.themeMode,
            language = profile.language,
            autoLockMinutes = profile.autoLockMinutes,
            biometricUnlockEnabled = profile.biometricUnlockEnabled
        )
    }
}

/**
 * Backs the Settings screen for people who may not change company settings.
 *
 * Not SettingsViewModel, on purpose. Its save writes the whole profile with a
 * fresh timestamp and then pushes it to company_settings, which the server
 * refuses for anyone but an owner or manager -- see
 * [SettingsStore.saveDevicePrefs] for what that did to a crew phone. This one
 * has no route to the cloud at all.
 *
 * [appScope] must outlive this ViewModel, for the reason SettingsViewModel
 * gives: Save closes the screen at once, and a write still running on
 * viewModelScope would be cancelled by that navigation before it landed.
 */
class PersonalSettingsViewModel(
    private val settingsStore: SettingsStore,
    private val appScope: CoroutineScope
) : ViewModel() {

    // Null until the stored values have loaded, so the screen never seeds its
    // buffer from a default and shows "System, English" to somebody who chose
    // Dark and Spanish a week ago.
    val prefs: StateFlow<DevicePrefs?> = settingsStore.profile
        .map { DevicePrefs.of(it) }
        .distinctUntilChanged()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    /**
     * Writes [prefs] -- except that while a guest demo is active, auto-lock
     * and biometric unlock are held at whatever this phone already has them
     * set to, no matter what [prefs] carries for them.
     *
     * This is the real gap three earlier reviews missed by only checking the
     * company-profile screen: a guest cannot reach that screen at all
     * (Routes.SETTINGS hands a guest THIS screen instead), but this screen's
     * four device-local keys are not covered by GuestWriteGuard -- they never
     * go through [com.fenceestimator.app.data.Repository], so there is no
     * write funnel for that guard to sit in front of. Theme and language are
     * left alone here: they are cosmetic, arguably part of trying the
     * product, and cannot lock the owner out of anything. Auto-lock minutes
     * and biometric unlock are the opposite -- a visitor could otherwise turn
     * off the owner's fingerprint unlock, permanently, on a phone the demo
     * wipe never touches (see GuestWipe: it clears the guest countdown flag
     * and deletes only the sample jobs, never any entry in this store).
     *
     * Checked here, not only by disabling the control in
     * PersonalSettingsScreen: a control that merely looks disabled while the
     * write underneath it would still succeed is exactly the "fake feature"
     * this app's rules forbid, so the refusal has to live where the write
     * actually happens, the same reasoning GuestWriteGuard is built on for
     * every write that DOES go through Repository. The guest check runs
     * first, before anything is written, matching the guard-goes-first rule
     * everywhere else a write funnel refuses a guest.
     *
     * Guest state is read fresh from [settingsStore] rather than passed in
     * from a remembered Compose value, for the same reason [GuestWipe]
     * insists on a fresh read: a stale "not a guest" captured before this
     * suspend function was scheduled must never let a real change through
     * where a fresh read would have refused it -- the reverse mistake
     * (refusing a real user) is merely annoying, so the fresh read costs
     * nothing when it is not needed and matters exactly when it is.
     */
    fun save(prefs: DevicePrefs) {
        appScope.launch {
            withContext(NonCancellable) {
                val current = settingsStore.profile.first()
                val guestActive = GuestSession.isActive(current)
                settingsStore.saveDevicePrefs(
                    themeMode = prefs.themeMode,
                    language = prefs.language,
                    autoLockMinutes = if (guestActive) current.autoLockMinutes else prefs.autoLockMinutes,
                    biometricUnlockEnabled = if (guestActive) current.biometricUnlockEnabled else prefs.biometricUnlockEnabled
                )
            }
        }
    }
}

package com.fenceestimator.app.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.AppLanguage
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.SettingsStore
import com.fenceestimator.app.data.ThemeMode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
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

    fun save(prefs: DevicePrefs) {
        appScope.launch {
            withContext(NonCancellable) {
                settingsStore.saveDevicePrefs(
                    themeMode = prefs.themeMode,
                    language = prefs.language,
                    autoLockMinutes = prefs.autoLockMinutes,
                    biometricUnlockEnabled = prefs.biometricUnlockEnabled
                )
            }
        }
    }
}

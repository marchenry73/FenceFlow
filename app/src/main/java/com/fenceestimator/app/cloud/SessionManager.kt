package com.fenceestimator.app.cloud

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

data class SessionState(
    val signedIn: Boolean = false,
    val email: String? = null,
    val companyId: String? = null,
    /**
     * Signed-out means local-only mode on your own phone, so it gets full
     * access -- the restricted CREW level only applies to a real crew login.
     */
    val role: UserRole = UserRole.OWNER
) {
    val canSeeMoney: Boolean get() = role != UserRole.CREW
    val canEditCatalogAndSettings: Boolean get() = role != UserRole.CREW
}

/** App-wide view of who is signed in and what they're allowed to see. */
class SessionManager(private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state

    /**
     * Supplies this device's push token. Injected rather than imported so the
     * cloud layer stays free of any Firebase dependency -- if Firebase is ever
     * swapped out, nothing here changes.
     */
    var pushTokenProvider: (() -> String?)? = null

    /** Set by the app on startup so signing in can restore company settings. */
    var settingsStore: com.fenceestimator.app.data.SettingsStore? = null

    fun refresh() {
        if (!SupabaseModule.isConfigured) return
        scope.launch {
            val email = runCatching { SupabaseModule.currentUserEmail() }.getOrNull()
            if (email == null) {
                _state.value = SessionState()
                return@launch
            }
            val profile = runCatching { SupabaseModule.fetchProfile() }.getOrNull()
            _state.value = SessionState(
                signedIn = true,
                email = email,
                companyId = profile?.companyId,
                role = profile?.userRole ?: UserRole.OWNER
            )

            // Bring down the company's saved settings so a reinstall or a new
            // crew phone starts with the right pricing and templates rather than
            // the built-in defaults.
            profile?.companyId?.let { company ->
                settingsStore?.let { store ->
                    runCatching { SettingsSync.pull(store, company) }
                }
            }

            // Register this phone for push once we know which company it belongs to.
            // Failure here must never block sign-in -- notifications are a bonus,
            // not a prerequisite for using the app.
            if (profile?.companyId != null) {
                pushTokenProvider?.invoke()?.let { token ->
                    runCatching { SupabaseModule.registerDeviceToken(token) }
                }
            }
        }
    }
}

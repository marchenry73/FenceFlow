package com.fenceestimator.app.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.Manufacturer
import com.fenceestimator.app.data.PricingTier
import com.fenceestimator.app.cloud.SettingsSync
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.SettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * [appScope] must outlive this ViewModel (pass the Application's own scope).
 * Settings are saved via an explicit "Save" tap followed almost immediately
 * by navigating back -- if the write ran on viewModelScope, that navigation
 * clears the ViewModel and cancels the in-flight DataStore write before it
 * lands, so the save silently disappears. Running on the app-level scope
 * (with NonCancellable around the write itself) guarantees it completes.
 */
class SettingsViewModel(
    private val settingsStore: SettingsStore,
    private val repository: Repository,
    private val appScope: CoroutineScope
) : ViewModel() {
    // Null until the real persisted value has loaded -- the screen must not seed its
    // edit buffer from a placeholder default, or a fast reload can make already-saved
    // settings look reset (see SettingsScreen for the other half of this fix).
    val profile: StateFlow<BusinessProfile?> = settingsStore.profile
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val pricingTiers: StateFlow<List<PricingTier>> = repository.observePricingTiers()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val manufacturers: StateFlow<List<Manufacturer>> = repository.observeManufacturers()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _saved = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val saved: SharedFlow<Unit> = _saved

    fun save(profile: BusinessProfile) {
        appScope.launch {
            // Local write first and uncancellable: settings must survive even if
            // the cloud is unreachable or the user backs out immediately.
            withContext(NonCancellable) { settingsStore.save(profile) }
            _saved.tryEmit(Unit)

            // Then push to the company account so a reinstall or a second phone
            // gets the same setup. Failure here is not worth interrupting anyone
            // over -- the next save or sync retries it.
            if (SupabaseModule.isConfigured) {
                runCatching { SettingsSync.push(profile) }
            }
        }
    }

    fun saveTier(tier: PricingTier) {
        appScope.launch { withContext(NonCancellable) { repository.savePricingTier(tier) } }
    }

    fun deleteTier(tier: PricingTier) {
        appScope.launch { withContext(NonCancellable) { repository.deletePricingTier(tier) } }
    }
}

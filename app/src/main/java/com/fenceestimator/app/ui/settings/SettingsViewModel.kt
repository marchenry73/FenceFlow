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

    /** True when the save reached the cloud, false when it only landed on this phone. */
    private val _saved = MutableSharedFlow<Boolean>(extraBufferCapacity = 1)
    val saved: SharedFlow<Boolean> = _saved

    fun save(profile: BusinessProfile) {
        appScope.launch {
            // Local write first and uncancellable: settings must survive even if
            // the cloud is unreachable or the user backs out immediately. This
            // write is never gated on the push below, so a dead connection
            // cannot slow down or block the local save.
            withContext(NonCancellable) { settingsStore.save(profile) }

            // Then push to the company account so a reinstall or a second phone
            // gets the same setup. This used to fail silently -- the "Saved"
            // snackbar fired from the local write alone, so a failed push here
            // was invisible until someone noticed the other phone never got it.
            val synced = if (SupabaseModule.isConfigured) {
                runCatching { SettingsSync.push(profile) }.isSuccess
            } else {
                true // Nothing to sync to, so the local save is the whole story.
            }
            _saved.tryEmit(synced)
        }
    }

    fun saveTier(tier: PricingTier) {
        appScope.launch { withContext(NonCancellable) { repository.savePricingTier(tier) } }
    }

    fun deleteTier(tier: PricingTier) {
        appScope.launch { withContext(NonCancellable) { repository.deletePricingTier(tier) } }
    }
}

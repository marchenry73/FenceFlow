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
import com.fenceestimator.app.data.guestEditableOver
import kotlinx.coroutines.flow.first
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
    private val appScope: CoroutineScope,
    /**
     * Whether the person using the app right now is in the guest demo.
     *
     * A function, read at save time, not a value captured when this view model
     * was built: a demo can end while the settings screen is open, and a
     * snapshot taken at construction would still be refusing (or still be
     * allowing) afterwards.
     *
     * Defaults to "not a guest" so every existing construction site and test
     * keeps its current meaning; the app passes the real answer.
     */
    private val guestDemo: () -> Boolean = { false },
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

    /**
     * THE ONE FUNNEL every settings edit goes through, which is why the guest
     * rule lives here and not on the screen.
     *
     * THE GAP THIS CLOSES. Every other guest write in the app lands in Room,
     * where the demo wipe can take it back. This one lands in DataStore, which
     * the wipe does not touch and GuestWriteGuard does not cover -- so a
     * business name, a labour rate or a set of contract terms typed during a
     * demo SURVIVED the demo, and SettingsSync's null-coalescing merge would
     * then let a real company adopt it as their own.
     *
     * It is not a blanket refusal, and that is the point: the theme and the
     * language are this phone's, and a guest who cannot switch the app to
     * Spanish has been broken rather than protected. [guestEditableOver] is
     * the allow-list, and it is an allow-list so that a field added later is
     * refused until somebody decides it should not be.
     *
     * Silent on purpose. The company controls on that screen are already
     * disabled for a guest (`editable`), so nothing a guest can actually touch
     * reaches this branch -- there is no action to report the refusal of. This
     * is the backstop for the paths that gate did not cover, not a second
     * place to tell somebody no.
     *
     * NOTE what this does NOT do: it does not arm [GuestWriteGuard]. That file
     * states at length why flipping it on without per-screen work would trade
     * "silently wrong" for "crashes, at random, per screen", and that reasoning
     * is unchanged. This closes the one write that escapes the demo entirely.
     */
    fun save(profile: BusinessProfile) {
        appScope.launch {
            val profile = if (guestDemo()) {
                profile.guestEditableOver(settingsStore.profile.first())
            } else {
                profile
            }
            // Local write first and uncancellable: settings must survive even if
            // the cloud is unreachable or the user backs out immediately. This
            // write is never gated on the push below, so a dead connection
            // cannot slow down or block the local save.
            withContext(NonCancellable) { settingsStore.save(profile) }

            // Then push to the company account so a reinstall or a second phone
            // gets the same setup. This used to fail silently -- the "Saved"
            // snackbar fired from the local write alone, so a failed push here
            // was invisible until someone noticed the other phone never got it.
            // SettingsSync.push already catches everything and ANSWERS with a
            // Result, so it does not throw. Wrapping it in another runCatching
            // asked the wrong question: `runCatching { push() }` is a
            // Result<Result<Unit>> whose isSuccess is true whenever the call
            // RETURNED -- including when what it returned was a failure. Every
            // failed push therefore reported "Saved", and the
            // set_saved_not_synced message ("saved on this phone only") could
            // not be reached at all. Ask the Result that push actually hands
            // back.
            val synced = if (SupabaseModule.isConfigured) {
                SettingsSync.push(profile).isSuccess
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

    /**
     * Opt-in "Copy FenceFlow's starting tiers" action. The five tiers carry a
     * real-looking labor rate and markup, not a placeholder like a catalog
     * price -- so, like the catalog, they only land here when the owner
     * explicitly asks for them.
     */
    fun copyStartingTiers() {
        appScope.launch { withContext(NonCancellable) { repository.copyFenceFlowStartingPricingTiers() } }
    }
}

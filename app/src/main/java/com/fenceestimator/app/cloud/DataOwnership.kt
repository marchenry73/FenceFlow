package com.fenceestimator.app.cloud

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.UnsyncedSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

private val Context.ownershipStore by preferencesDataStore(name = "data_ownership")

/**
 * Makes the data on this phone belong to an account rather than to the phone.
 *
 * Without this, the local database is simply whatever the last person left
 * behind. Sign out and it is all still there; sign in as somebody else and you
 * are looking at the previous company's jobs, customers and revenue. On a
 * shared crew phone that is one company's books shown to another.
 *
 * So the phone remembers which company its data belongs to, and wipes it the
 * moment that stops matching who is signed in. The cloud copy is untouched --
 * signing back in downloads it again.
 */
class DataOwnership(
    private val context: Context,
    private val repository: Repository,
    private val settingsStore: com.fenceestimator.app.data.SettingsStore? = null
) {

    /**
     * Work that belongs on this phone but never reached the cloud, discovered
     * at the moment a wipe was about to run for a company that no longer
     * matches -- and refused instead.
     *
     * [companyId] is whichever company the phone's data is stamped as
     * belonging to (see [currentOwner]), not the one that just signed in --
     * this state exists precisely because those two differ. Nothing here
     * builds a screen for it; a UI owns turning this into something shown.
     */
    data class HeldWork(val companyId: String, val summary: UnsyncedSummary)

    private val _heldWork = MutableStateFlow<HeldWork?>(null)
    /** Non-null while a wipe is being withheld because it would destroy unsynced work. */
    val heldWork: StateFlow<HeldWork?> = _heldWork.asStateFlow()

    /**
     * Clearing the database is not enough on its own.
     *
     * Survey photos, customer signatures, job photos and generated PDFs are
     * files on disk. Wiping the tables removes the rows that point at them and
     * leaves the files themselves -- one company's customer signatures and
     * property photos sitting on a phone now used by another. The settings
     * store is worse again: it holds the business name, licence number,
     * pricing, and the Square access token, which is a live payment credential.
     */
    private suspend fun wipeEverything() {
        repository.clearAllLocalData()
        settingsStore?.clearAll()

        listOf("surveys", "signatures", "photos", "job_photos").forEach { name ->
            runCatching { java.io.File(context.filesDir, name).deleteRecursively() }
        }
        runCatching { java.io.File(context.cacheDir, "pdfs").deleteRecursively() }
    }

    private val companyKey = stringPreferencesKey("local_data_company_id")

    /** Which company the data currently on this phone belongs to, if any. */
    suspend fun currentOwner(): String? =
        context.ownershipStore.data.map { it[companyKey] }.first()

    private suspend fun setOwner(companyId: String?) {
        context.ownershipStore.edit { prefs ->
            if (companyId == null) prefs.remove(companyKey) else prefs[companyKey] = companyId
        }
    }

    /**
     * Called when someone signs in. Wipes the phone if the data on it belongs
     * to a different company.
     *
     * Data with no owner is kept and adopted. That is the person who tried the
     * app offline before making an account -- it is their own work on their own
     * phone, and throwing it away at the moment they sign up would be the wrong
     * end of this trade entirely.
     *
     * @return true if local data was wiped.
     */
    suspend fun onSignedIn(companyId: String): Boolean {
        val owner = currentOwner()
        if (owner == companyId) {
            // Matches again. If a mismatch earlier had this held back, that
            // is resolved now -- nothing left to warn about.
            _heldWork.value = null
            return false
        }

        if (owner == null) {
            // Unclaimed local work: adopt it into this company.
            setOwner(companyId)
            _heldWork.value = null
            return false
        }

        // Belongs to someone else. Ordinarily that is already safe in that
        // company's cloud, so removing it here loses nothing recoverable --
        // but only once it has actually gotten there. A phone that took
        // photos and a signature with no signal, and was moved to a
        // different company before it ever got a chance to push them, has
        // not backed anything up yet. Wiping on the strength of "it's in
        // the cloud" when it demonstrably is not is exactly the loss this
        // class exists to prevent, so the wipe is refused and the work is
        // recorded instead of destroyed.
        if (repository.hasUnsyncedWork()) {
            _heldWork.value = HeldWork(owner, repository.unsyncedSummary())
            return false
        }

        wipeEverything()
        setOwner(companyId)
        _heldWork.value = null
        return true
    }

    /**
     * Called when someone signs in who has not joined a company.
     *
     * They are entitled to nothing that belongs to one. This case was missed
     * entirely: the ownership check only ran when a company id was present, so
     * signing in with a fresh account left the previous company's jobs,
     * customers and revenue sitting on screen -- while the app reported
     * "working on this phone only", which made it read like a local quirk
     * rather than another company's books.
     *
     * Unclaimed work is still kept. Somebody who tried the app before making an
     * account is looking at their own work on their own phone, and taking it
     * away at the moment they sign up would be the wrong end of this trade.
     *
     * @return true if local data was wiped.
     */
    suspend fun onSignedInWithoutCompany(): Boolean {
        val owner = currentOwner() ?: return false

        // The person most likely to hit this branch is someone the owner just
        // removed from the crew -- profile.company_id went null out from under
        // them. If they took photos and a signature in a yard with no signal
        // and only got connectivity back after being removed, this is the one
        // moment that work can still be saved: RLS will refuse their own push
        // (they are nobody's crew now), so the only honest thing left is to
        // leave the data on the phone and say so, rather than wipe it on the
        // assumption it is already safe somewhere else.
        if (repository.hasUnsyncedWork()) {
            _heldWork.value = HeldWork(owner, repository.unsyncedSummary())
            return false
        }

        wipeEverything()
        setOwner(null)
        _heldWork.value = null
        return true
    }

    /**
     * Called on sign-out. Clears the phone so the next person sees nothing.
     *
     * Refuses while anything is still waiting to upload, so signing out can
     * never be the thing that destroys a day's work recorded in a yard with no
     * signal. The caller is expected to tell the user to get signal first.
     *
     * The guard used to check only [Repository.pendingDeletions] -- queued
     * deletes -- and missed everything else waiting to go up: an edited job
     * that had not pushed yet, a signature or photo sitting on the phone with
     * no storage path. [Repository.hasUnsyncedWork] is the same check the
     * rest of this class now uses, so "signing out is safe" means the same
     * thing everywhere it is asked.
     *
     * @return true if the data was cleared, false if unsynced work blocked it.
     */
    suspend fun onSignedOut(force: Boolean = false): Boolean {
        if (!force && repository.hasUnsyncedWork()) return false
        wipeEverything()
        setOwner(null)
        _heldWork.value = null
        return true
    }

    /**
     * Sign-out for a phone whose access has just been cut off by
     * [ServiceGate] -- another device took the login and this session is
     * blocked from syncing before it can even try.
     *
     * That used to mean signing out here always forced past the unsynced-work
     * guard: the reasoning was that a blocked phone can never get its work up
     * anyway, so waiting for signal cannot help. But "blocked from syncing"
     * and "the work is expendable" are not the same fact, and a phone forced
     * off a job with a freshly captured signature and photos lost them with
     * no warning. This takes the ordinary, non-forcing path -- refuses and
     * says so if there is unsynced work, so the person holding the phone gets
     * a chance to say "wipe it anyway" instead of it happening silently.
     */
    suspend fun signOutKeepingUnsynced(): Boolean = onSignedOut(force = false)

    /**
     * The person has seen what is held and chosen to sign out with it still
     * on the phone. Nothing is wiped and the owner stamp stays, so signing
     * back in as that company adopts the work and syncs it as usual. The
     * hold itself is lifted because the screen it drives must not follow
     * them to the sign-in page.
     */
    fun releaseHold() {
        _heldWork.value = null
    }

    /**
     * The person has seen what is held and chosen, twice, to lose it. Only
     * reached through that second tap; the wipe that was refused runs now,
     * and the next session resolve adopts whatever account is signed in.
     */
    suspend fun discardHeldWork() {
        wipeEverything()
        setOwner(null)
        _heldWork.value = null
    }
}

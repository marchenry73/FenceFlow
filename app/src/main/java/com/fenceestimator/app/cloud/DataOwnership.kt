package com.fenceestimator.app.cloud

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.UnsyncedSummary
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

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
    // Off the main thread explicitly: the Account screen reaches this from
    // viewModelScope, and deleting a phone's worth of photos there would freeze it.
    private suspend fun wipeEverything() = withContext(Dispatchers.IO) {
        repository.clearAllLocalData()
        settingsStore?.clearAll()

        listOf("surveys", "signatures", "photos", "job_photos").forEach { name ->
            runCatching { java.io.File(context.filesDir, name).deleteRecursively() }
        }
        runCatching { java.io.File(context.cacheDir, "pdfs").deleteRecursively() }
    }

    private val companyKey = stringPreferencesKey("local_data_company_id")

    companion object {
        /**
         * The owner stamp a phone carries while the guest demo is running.
         *
         * A second, independent way of knowing that the data on this phone is
         * sample data, and the one that does not depend on anything a visitor
         * can type. The demo's rows are recognised elsewhere by two pieces of
         * free text -- a customer name prefix and a referral tag -- and free
         * text is only as durable as the rule that stops a visitor editing it.
         * This stamp lives in its own preferences file with no screen anywhere
         * that writes it, so it survives an edit, a crash, and a demo cleanup
         * that never finished.
         *
         * Not a company id and not shaped like one, so it can never collide
         * with a real company: [onSignedIn] compares against what the signed-in
         * account actually is, and no account is this.
         */
        const val GUEST_DEMO_OWNER = "fenceflow-guest-demo"
    }

    /**
     * Stamps this phone as holding demo data, before the demo has written a
     * single row.
     *
     * Called when somebody starts the demo. The order matters: stamped first,
     * seeded second, so a process that dies between the two leaves a phone
     * marked as demo with nothing on it -- harmless -- rather than a phone full
     * of sample jobs with nothing saying so.
     */
    suspend fun onGuestDemoStarted() = setOwner(GUEST_DEMO_OWNER)

    /**
     * Clears the demo stamp once the demo's rows are actually gone.
     *
     * Called last by the demo cleanup, after the rows have been removed and the
     * countdown flag cleared, so every earlier step failing still leaves the
     * stamp in place for [onSignedIn] to catch.
     *
     * Only ever clears the demo stamp. Without that condition this would be a
     * way to un-own a real company's data, which is the opposite of what this
     * class is for.
     */
    suspend fun onGuestDemoEnded() {
        if (currentOwner() == GUEST_DEMO_OWNER) setOwner(null)
    }

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
     * Data stamped as the guest demo is the one case that is wiped without
     * being weighed against anything, because there is nothing on the other
     * side of the scale: see the branch itself.
     *
     * @return true if local data was wiped.
     */
    suspend fun onSignedIn(companyId: String): Boolean {
        val owner = currentOwner()

        // Demo data never becomes a real company's data.
        //
        // Signing in during a demo used to reach the branch below with no owner
        // stamp at all, which reads as "unclaimed local work" -- somebody who
        // tried the app offline before making an account -- and adopted the
        // sample jobs into the company that just signed in. From there the
        // ordinary rule that anything the cloud has never seen is new work
        // pushed them up as that company's real jobs.
        //
        // Wiped rather than held: the held-work path exists because unsynced
        // work may be the only copy of a real day on a real site, and there is
        // no version of that argument for a sample company that was generated
        // on this phone minutes ago and is due to be deleted anyway. Nothing
        // here is recoverable because nothing here was ever real.
        if (owner == GUEST_DEMO_OWNER) {
            wipeEverything()
            setOwner(companyId)
            _heldWork.value = null
            return true
        }

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

        // Demo data, same as in onSignedIn and for the same reason. Checked
        // here too because an account that has not joined a company still
        // syncs once it joins one, and a phone that kept its sample jobs
        // through this branch would push them then.
        if (owner == GUEST_DEMO_OWNER) {
            wipeEverything()
            setOwner(null)
            _heldWork.value = null
            return true
        }

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
        if (!force && repository.hasUnsyncedWork()) {
            // Sign-out refusals used to leave no trace anywhere but a
            // Snackbar the person could easily miss (a fast double-tap past
            // the confirm dialog, or a screen recomposition swallowing it).
            // A log line at least makes the refusal diagnosable afterwards,
            // e.g. from a bug report that just says "sign out did nothing".
            android.util.Log.w(
                "DataOwnership",
                "sign-out refused: unsynced work still present (force=$force)"
            )
            return false
        }
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

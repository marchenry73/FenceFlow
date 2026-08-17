package com.fenceestimator.app.cloud

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.fenceestimator.app.data.Repository
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
        if (owner == companyId) return false

        if (owner == null) {
            // Unclaimed local work: adopt it into this company.
            setOwner(companyId)
            return false
        }

        // Belongs to someone else. It is already in that company's cloud, so
        // removing it here loses nothing that isn't recoverable by them.
        wipeEverything()
        setOwner(companyId)
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
        wipeEverything()
        setOwner(null)
        return true
    }

    /**
     * Called on sign-out. Clears the phone so the next person sees nothing.
     *
     * Refuses while anything is still waiting to upload, so signing out can
     * never be the thing that destroys a day's work recorded in a yard with no
     * signal. The caller is expected to tell the user to get signal first.
     *
     * @return true if the data was cleared, false if unsynced work blocked it.
     */
    suspend fun onSignedOut(force: Boolean = false): Boolean {
        if (!force && repository.pendingDeletions().isNotEmpty()) return false
        wipeEverything()
        setOwner(null)
        return true
    }
}

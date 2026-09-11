package com.fenceestimator.app.guest

import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.SettingsStore
import kotlinx.coroutines.flow.first

/**
 * The one place in the app allowed to delete a guest's demo data, and the
 * only irreversible delete this product runs without a person tapping
 * something first.
 *
 * The owner's standing rule is "I don't want to delete anything on the app.
 * No data at all." He authorized exactly one exception: the guest wipe. So
 * every condition below is a reason a wipe must NOT happen unless it is
 * unambiguously true, checked fresh at the moment of wiping rather than
 * trusted from whatever the caller remembered a screen redraw ago:
 *
 *  1. Nobody is signed in right now. A signed-in phone is somebody's real
 *     company; even if a guest session flag is technically still set (see
 *     the sign-in race in the class-level report), real data must never be
 *     touched by this path.
 *  2. A guest session is actually active (SettingsStore's one flag is
 *     nonzero). Otherwise there is nothing to end.
 *  3. The five minutes are actually up. Otherwise this would be firing
 *     early off a stale caller.
 *
 * If any of those is not exactly true, this does nothing and returns false.
 * A wipe that fails to run is a countdown banner that lingers a bit too
 * long -- cosmetic. A wipe that runs when it should not have destroys a
 * business's books. Given a choice between the two failure modes, this code
 * always leans toward doing nothing.
 *
 * What it deletes, when it does run: only jobs carrying BOTH of
 * [GuestMarker]'s markers, via [Repository.deleteJobLocallyOnly] -- never
 * `clearAllLocalData()` (a full-table wipe that exists elsewhere in this
 * repository for the very different case of a phone changing owners) and
 * never a bare "delete everything." Room's ON DELETE CASCADE on jobId takes
 * every fence run, line item, photo, checklist item, site marker, change
 * order, job step and time entry belonging to that job with it, which is
 * exactly the seeded rows and nothing else. deleteJobLocallyOnly, not
 * deleteJob: these rows were never synced (guest mode never talks to the
 * cloud), so there is no cloud tombstone to queue -- queuing one would be
 * pointless at best.
 */
object GuestWipe {
    /**
     * Runs the wipe if, and only if, every guard above is true right now.
     * Safe to call on every app launch and on every tick of the countdown --
     * it is a no-op whenever the guest session isn't genuinely over.
     *
     * @return true if a wipe actually ran.
     */
    suspend fun wipeIfDue(
        repository: Repository,
        settingsStore: SettingsStore,
        session: SessionManager
    ): Boolean {
        // Checked here, not passed in from a remembered Compose state: a
        // stale "signedIn" captured before this suspend function was even
        // scheduled is exactly the kind of remembered-state bug that once
        // let a suspended company's phone keep working (see MainActivity's
        // service-gate comments for the general shape of that mistake).
        if (session.state.value.signedIn) return false

        val profile = settingsStore.profile.first()
        if (!GuestSession.isActive(profile)) return false
        if (!GuestSession.isExpired(profile)) return false

        val guestJobs = repository.getAllJobs().filter(GuestMarker::isGuestSeeded)
        guestJobs.forEach { job -> repository.deleteJobLocallyOnly(job) }

        // Only the flag, not settingsStore.clearAll() -- see endGuestSession's
        // own doc for why a full settings wipe has no place here.
        settingsStore.endGuestSession()
        return true
    }
}

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
 * trusted from whatever the caller remembered a screen redraw ago.
 *
 * There are two ways a demo ends, and they do not share the same guards --
 * read each entry point's own doc rather than assuming this list covers both.
 * [wipeIfDue] is the countdown running out and holds all three:
 *
 *  1. Nobody is signed in right now. A signed-in phone is somebody's real
 *     company; even if a guest session flag is technically still set, real
 *     data must never be touched by that path.
 *  2. A guest session is actually active (SettingsStore's one flag is
 *     nonzero). Otherwise there is nothing to end.
 *  3. The countdown is actually up ([GuestSession.DURATION_MS], the one place
 *     the length of a demo is written down). Otherwise this would be firing
 *     early off a stale caller.
 *
 * [wipeOnSignIn] is a real account signing in mid-demo and holds only the
 * second. It cannot hold the first -- being signed in is the reason it runs --
 * and holding the third is what let a sample company reach a real database.
 * What keeps it safe instead is that it is reachable only while the demo flag
 * is set, and that it still deletes nothing but rows carrying both markers.
 *
 * If a guard is not exactly true, the call does nothing and returns false.
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
        session: SessionManager,
        dataOwnership: com.fenceestimator.app.cloud.DataOwnership
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

        clearDemo(repository, settingsStore, dataOwnership)
        return true
    }

    /**
     * Ends a demo because somebody has just signed in to a real account, which
     * is the one case [wipeIfDue] must refuse and cannot handle.
     *
     * This used to clear the countdown flag and leave every sample row on the
     * phone, on the reasoning that a signed-in phone's rows must never be
     * touched. That reasoning is right about real rows and wrong about these:
     * the moment the flag was cleared the sample jobs stopped being marked as a
     * demo in any way the rest of the app could act on, and two mechanisms
     * built for the honest case took over -- the phone adopted its own
     * unclaimed local work into the company that just signed in, and the sync
     * pushed up everything the cloud had never seen. The sample company went up
     * as somebody's real one, complete with fake customers and fake payments,
     * in a real database.
     *
     * So the rows go first and the flag goes second. There is no expiry check:
     * a real sign-in ends the demo whenever it happens, and waiting for the
     * clock is exactly how the sample rows survived into a real account. There
     * is no signed-out check either -- being signed in is the reason this runs.
     *
     * Still only rows carrying BOTH of [GuestMarker]'s markers, still local
     * only, still never a full-table wipe. The set of rows deleted is the same
     * set [wipeIfDue] would have deleted a minute later; only the trigger
     * differs.
     *
     * @return true if a demo was running and has now been cleared.
     */
    suspend fun wipeOnSignIn(
        repository: Repository,
        settingsStore: SettingsStore,
        dataOwnership: com.fenceestimator.app.cloud.DataOwnership
    ): Boolean {
        val profile = settingsStore.profile.first()
        if (!GuestSession.isActive(profile)) return false

        clearDemo(repository, settingsStore, dataOwnership)
        return true
    }

    /**
     * The rows, then the countdown flag, then the phone's demo stamp -- in that
     * order, because each step is a guard for the ones after it.
     *
     * If the row delete throws, the flag stays set and the next launch tries
     * again. If the flag write throws, the stamp stays and the ownership check
     * at sign-in catches the phone instead. Doing it the other way round -- the
     * cheap bookkeeping first -- is what turned an interrupted cleanup into a
     * phone full of sample jobs that nothing recognised as samples any more.
     */
    private suspend fun clearDemo(
        repository: Repository,
        settingsStore: SettingsStore,
        dataOwnership: com.fenceestimator.app.cloud.DataOwnership
    ) {
        val guestJobs = repository.getAllJobs().filter(GuestMarker::isGuestSeeded)
        guestJobs.forEach { job -> repository.deleteJobLocallyOnly(job) }

        // Only the flag, not settingsStore.clearAll() -- see endGuestSession's
        // own doc for why a full settings wipe has no place here.
        settingsStore.endGuestSession()

        // Last, so that everything above failing leaves this phone still
        // marked as holding demo data.
        dataOwnership.onGuestDemoEnded()
    }
}

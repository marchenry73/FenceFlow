package com.fenceestimator.app.guest

import com.fenceestimator.app.data.Job

/**
 * How a guest-mode job is told apart from a real one, for the one place that
 * has to get this right: the wipe that runs at the end of a guest session
 * (see GuestWipe).
 *
 * Two independent markers must both match before a row is treated as
 * seeded-demo data:
 *  - [NAME_PREFIX] on the customer name -- visible, so a person looking at
 *    the job list can never mistake a sample job for a real one, which is
 *    the whole point of marking "in the names themselves."
 *  - [REFERRAL_TAG] in a field a real job practically never contains free
 *    text like this.
 *
 * One marker could plausibly collide with something a real user typed (a
 * customer literally named "Guest", a coincidence in a free-text field).
 * Requiring both to line up before a delete is allowed to touch a row is
 * what makes the marker "unmistakable" rather than merely "usually right."
 */
object GuestMarker {
    /** Prepended to every seeded job's customer name. */
    const val NAME_PREFIX = "★ Guest Demo — "

    /** A sentinel nobody would type into "how did you hear about us" by hand. */
    const val REFERRAL_TAG = "FENCEFLOW_GUEST_DEMO_v1"

    fun mark(customerName: String): String = "$NAME_PREFIX$customerName"

    /** True only when BOTH markers are present. See the class doc for why. */
    fun isGuestSeeded(job: Job): Boolean =
        job.customerName.startsWith(NAME_PREFIX) && job.referralSource == REFERRAL_TAG
}

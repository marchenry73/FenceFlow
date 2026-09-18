package com.fenceestimator.app.reapproval

/**
 * The pure half of the sign-out guard in [com.fenceestimator.app.cloud.DataOwnership.onSignedOut]:
 * whether a sign-out attempt should proceed, or be refused because it would
 * throw away work the cloud does not have a copy of yet. No SQLite, no
 * Supabase -- the caller already knows whether there is unsynced work and
 * whether the person confirmed "sign out anyway".
 */
fun allowSignOut(hasUnsyncedWork: Boolean, force: Boolean): Boolean = force || !hasUnsyncedWork

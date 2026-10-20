package com.fenceestimator.app.ui.admin

/**
 * WHETHER THE ADMIN CONSOLE OPENS ON THIS PHONE, AND IF NOT, WHY.
 *
 * The platform console (website/admin.html) controls every fence company on
 * FenceFlow: who exists, what they pay, who is invited, what release they get.
 * This decides whether the same powers appear in the app.
 *
 * THE SERVER IS THE REAL GATE, NOT THIS. Every admin power is a SECURITY
 * DEFINER function behind is_platform_admin(), and since
 * supabase_r7_admin_second_factor.sql that function requires **aal2** -- a
 * session that did password AND the authenticator -- reading auth.sessions.aal
 * first and the signed `aal` claim second. Before that change the second
 * factor was enforced only by admin.html refusing to render, which a client
 * could simply not do; see FINDING_admin_mfa_is_browser_only.md. So this file
 * decides what to SHOW. If it ever gets that wrong in the generous direction,
 * the database still refuses, and the screen reports the refusal rather than
 * inventing an answer.
 *
 * HIDDEN, NOT DISABLED, FOR NON-ADMINS. Everywhere else this app explains a
 * control it will not let you use. Not here: a crew member or an owner of one
 * fence company has no business learning that a platform console exists, and a
 * greyed-out "Admin" row is an invitation to ask what it is. [Hidden] means the
 * entry is not drawn at all. That is the one case where absence beats an
 * explanation, and the NO FAKE FEATURES rule allows it explicitly -- a control
 * must work, say why it does not, or NOT BE THERE.
 *
 * Pure, so the decision is tested without a phone, a session or a server.
 */
enum class AdminEntry {
    /** Not an admin, or not signed in. Draw nothing. */
    HIDDEN,

    /** Admin, and this session already did the second factor. Open it. */
    OPEN,

    /** Admin, enrolled, but this session is password-only. Ask for the code. */
    NEEDS_CODE,

    /**
     * Admin, but no authenticator is enrolled on the account, so this session
     * can never reach aal2 and the server will refuse every admin call.
     * Enrolment happens on the console, not here: enrolling a second factor
     * from a phone that is already signed in weakens the factor to "whoever
     * holds this phone", which is the thing it exists to rule out.
     */
    NEEDS_ENROLMENT,
}

/**
 * What the admin entry should do.
 *
 * @param signedIn          there is a session at all
 * @param isPlatformAdmin   the account is a platform admin (from the server;
 *                          never guessed from an email address or a role name)
 * @param aalCurrent        what this session HAS done: "aal1", "aal2", or null
 *                          when it has not been read yet
 * @param aalNext           what this session COULD reach. Supabase returns
 *                          "aal2" here exactly when a verified factor exists,
 *                          which is how enrolled-but-not-yet-verified is told
 *                          apart from not-enrolled-at-all.
 */
fun adminEntryFor(
    signedIn: Boolean,
    isPlatformAdmin: Boolean,
    aalCurrent: String?,
    aalNext: String?,
): AdminEntry = when {
    !signedIn || !isPlatformAdmin -> AdminEntry.HIDDEN

    // Already stepped up. The only state that opens anything.
    aalCurrent == "aal2" -> AdminEntry.OPEN

    // A factor exists to be asked for.
    aalNext == "aal2" -> AdminEntry.NEEDS_CODE

    // Supabase has answered and says there is nothing to step up to.
    aalNext != null -> AdminEntry.NEEDS_ENROLMENT

    // Not read yet. Ask for the code rather than claiming there is no factor:
    // this account IS an admin, admins are required to have one, and sending
    // him to "enrol an authenticator" when he already has one in his hand is
    // the worse of the two wrong answers.
    else -> AdminEntry.NEEDS_CODE
}

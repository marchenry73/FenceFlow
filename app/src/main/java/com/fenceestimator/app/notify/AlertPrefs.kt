package com.fenceestimator.app.notify

import com.fenceestimator.app.cloud.SupabaseModule
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Reads the SAME per-person mute list the office web dashboard writes to
 * (notification_prefs.muted_alerts -- see supabase_notification_prefs.sql),
 * so a preference means the same thing on a phone as it does on a screen in
 * the office.
 *
 * Launch audit §28: "One architecture across push and the office is still
 * missing." Before this, the office's fourteen exception detectors (see
 * ALERT_DEFS in website/dashboard.html) each checked mutedAlerts before
 * showing anything, and the app's own locally-detected notifications
 * (OverdueWatcher, WeeklySummary) checked nothing at all -- a person could
 * mute an alert in Settings on the web and still have their phone buzz about
 * the exact same condition. This does not merge the two vocabularies (the
 * office's fourteen keys and the app's own notification keys are still
 * different lists, deliberately -- see CrewAttentionItem's own note on why a
 * phone's alert vocabulary is closed and separate from the office's); it
 * gives the app's OWN keys a place in the SAME table and the SAME "muted
 * means this user turned it off, nothing else does" rule, so a key added to
 * both ALERT_DEFS and here in the future is honoured identically on both
 * surfaces.
 *
 * Reads only this signed-in user's own row -- notification_prefs RLS only
 * ever allows that, by design (see supabase_notification_prefs.sql), so
 * there is no risk of muting an alert for anyone but the person holding this
 * phone.
 */
object AlertPrefs {

    /** This app's own mutable notification keys, kept in one place so a
     * future notification can be added here without hunting for every
     * call site that might need to know its name. */
    object Keys {
        const val JOB_OVERDUE = "job_overdue"
        const val WEEKLY_DIGEST = "weekly_digest"
    }

    @Serializable
    private data class Row(
        @SerialName("muted_alerts") val mutedAlerts: List<String> = emptyList()
    )

    /**
     * True only if this user has explicitly turned [key] off. Every failure
     * mode -- signed out, offline, the table not existing yet on an older
     * database -- reads as false (not muted), the same "absence means on"
     * rule supabase_notification_prefs.sql documents for the office side.
     * The alternative (treating a failed read as muted) would mean a network
     * hiccup silently swallows a real notification with nothing to show for
     * it, which is exactly the kind of quiet failure this product has
     * already decided against elsewhere (see the mail-key boundary in
     * WeeklySummary and the dashboard's automation rules).
     */
    suspend fun isMuted(key: String): Boolean {
        val userId = SupabaseModule.currentUserId() ?: return false
        return runCatching {
            SupabaseModule.client.postgrest.from("notification_prefs")
                .select {
                    filter { eq("user_id", userId) }
                }
                .decodeSingleOrNull<Row>()
                ?.mutedAlerts
                ?.contains(key) == true
        }.getOrDefault(false)
    }
}

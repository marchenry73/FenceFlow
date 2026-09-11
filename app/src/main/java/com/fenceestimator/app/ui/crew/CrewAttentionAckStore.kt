package com.fenceestimator.app.ui.crew

import android.content.Context

/**
 * "I have seen this one" for the crew attention list, kept on the phone.
 *
 * There is no column anywhere -- local or in Supabase -- for a crew member
 * having acknowledged a specific alert; only the office side has a seen-state
 * idea (`alerts_seen` in Settings, see supabase_alerts_seen.sql) and it is
 * scoped to the office's own fourteen detectors, not this list. Rather than
 * add a synced column this task was not asked to wire up end to end, a
 * dismissal here is honestly what it is: this phone remembers you tapped Got
 * it. It does not follow you to another device, and a reinstall forgets it.
 *
 * That is why every [CrewAttentionItem.key] carries the fact that could
 * change (a rejection's timestamp, a decision's timestamp) rather than just
 * an id: dismissing a shift's rejection does not also dismiss its NEXT
 * rejection, because the next one is a different key. Silence here always
 * means "this exact fact was seen", never "this job was seen".
 */
class CrewAttentionAckStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences("crew_attention_ack", Context.MODE_PRIVATE)

    fun dismissedKeys(): Set<String> = prefs.getStringSet(KEY, emptySet()) ?: emptySet()

    fun dismiss(key: String) {
        val current = dismissedKeys().toMutableSet()
        current += key
        // Capped so a phone that never uninstalls the app doesn't grow this
        // set forever. A Set has no reliable order to trim the oldest from,
        // so past the cap this simply starts over empty -- every key still
        // showing at that point is, by construction, for a fact that has not
        // changed in a very long time, so re-dismissing it once costs nothing.
        val bounded = if (current.size > MAX_KEPT) setOf(key) else current
        prefs.edit().putStringSet(KEY, bounded).apply()
    }

    companion object {
        private const val KEY = "dismissed"
        private const val MAX_KEPT = 500
    }
}

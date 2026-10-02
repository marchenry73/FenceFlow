package com.fenceestimator.app.ui.crew

import android.content.Context

/**
 * What has already gone on the truck, and what was taken instead, kept on this
 * phone.
 *
 * A YARD HAS NO SIGNAL. That is the whole reason this is SharedPreferences and
 * not a synced column: every read and write here is a local file, so ticking a
 * line works identically with the radio off, and nothing on this page can fail
 * because a request did not come back. It survives the screen being left, the
 * phone sleeping, the app being swept away and the phone being rebooted, which
 * is the list of things that actually happen between the posts aisle and the
 * concrete aisle.
 *
 * It does NOT follow you to another device and a reinstall forgets it. Same
 * honest limit as [CrewAttentionAckStore], and for the same reason: there is no
 * column anywhere -- local or in Supabase -- for "this line has been loaded",
 * and inventing one means a Room migration plus a sync field, in files this
 * task does not hold. The page says so in words rather than implying the office
 * can see it.
 *
 * TICKS ARE SCOPED TO A JOB AND TO A LINE'S EXACT CONTENT. The key handed in
 * ([PullSheetLine.key]) carries the product, the unit, the fence height and the
 * QUANTITY, so a takeoff that changes a count drops that line's tick. At a
 * supply counter, a tick inherited by a different number is worse than a tick
 * that has to be made again.
 */
class PullSheetTickStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences("pull_sheet", Context.MODE_PRIVATE)

    fun tickedKeys(jobId: Long): Set<String> =
        prefs.getStringSet(ticksKey(jobId), emptySet()) ?: emptySet()

    fun setTicked(jobId: Long, lineKey: String, ticked: Boolean) {
        val current = tickedKeys(jobId).toMutableSet()
        if (ticked) current += lineKey else current -= lineKey
        // Bounded so a phone that never reinstalls cannot grow this for ever.
        // Past the cap it keeps only the tick just made: every key still in the
        // set at that point is, by construction, for a line whose quantity has
        // not moved in a very long time, so re-ticking costs one tap.
        val bounded = if (current.size > MAX_TICKS_PER_JOB) setOf(lineKey) else current
        prefs.edit().putStringSet(ticksKey(jobId), bounded).apply()
    }

    /** Clears every tick for a job, for the "start this trip again" action. */
    fun clearTicks(jobId: Long) {
        prefs.edit().remove(ticksKey(jobId)).apply()
    }

    /**
     * What was actually taken when the yard was out of something.
     *
     * A NOTE, NOT AN EDIT, and that is a decision rather than a shortcut. The
     * line is what the estimate, the post count and the customer's price were
     * all built from, so letting a supply counter rewrite the product or the
     * count is letting a job quietly stop matching what was signed -- the same
     * reasoning [CrewFencePlanScreen]'s change card is built on, where the crew
     * ASK to move a fence line rather than moving it.
     *
     * So the note records the substitution next to the line, the quantity and
     * the product stay exactly as the takeoff wrote them, and the page states
     * plainly that this stays on the phone.
     */
    fun substitution(jobId: Long, lineKey: String): String =
        prefs.getString(noteKey(jobId, lineKey), "") ?: ""

    fun setSubstitution(jobId: Long, lineKey: String, note: String) {
        val trimmed = note.trim().take(MAX_NOTE_CHARS)
        val editor = prefs.edit()
        if (trimmed.isEmpty()) editor.remove(noteKey(jobId, lineKey))
        else editor.putString(noteKey(jobId, lineKey), trimmed)
        editor.apply()
    }

    /** Every substitution on a job, for the summary at the top of the sheet. */
    fun substitutions(jobId: Long, lineKeys: List<String>): Map<String, String> =
        lineKeys.mapNotNull { key ->
            val note = substitution(jobId, key)
            if (note.isBlank()) null else key to note
        }.toMap()

    private fun ticksKey(jobId: Long) = "ticks_$jobId"

    // The line key is hashed into the preference name rather than concatenated:
    // a product name can contain anything a supplier types, and a raw name in a
    // preference key is a key that changes meaning when two products differ
    // only by a character the key swallows.
    private fun noteKey(jobId: Long, lineKey: String) = "note_${jobId}_${lineKey.hashCode()}"

    companion object {
        private const val MAX_TICKS_PER_JOB = 400
        private const val MAX_NOTE_CHARS = 200
    }
}

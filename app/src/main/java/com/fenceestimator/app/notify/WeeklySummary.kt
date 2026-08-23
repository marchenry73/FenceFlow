package com.fenceestimator.app.notify

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.isWon
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Calendar
import java.util.Locale

private val Context.weeklyStore by preferencesDataStore(name = "weekly_summary")

/**
 * Monday morning: last week in one line, this week in another.
 *
 * A business owner's week starts with a question -- how did we do, and what
 * is coming -- and the answer used to mean opening three screens. One
 * notification with both numbers is read in the truck before the first job.
 *
 * Quiet by design: once a week, only after 7am, only once per week even if
 * the app restarts, and only the money line for someone allowed to see money.
 * Piggybacks on the same hourly tick the overdue watcher uses, so there is no
 * second scheduler to go wrong.
 */
class WeeklySummary(
    private val scope: CoroutineScope,
    private val repository: Repository,
    private val session: SessionManager,
    private val context: Context
) {
    private val lastSentKey = longPreferencesKey("last_sent_week_start")

    fun start() {
        scope.launch {
            while (true) {
                runCatching { checkOnce() }
                delay(CHECK_INTERVAL_MS)
            }
        }
    }

    suspend fun checkOnce() {
        if (!Notifications.hasPermission(context)) return
        val cal = Calendar.getInstance()
        if (cal.get(Calendar.DAY_OF_WEEK) != Calendar.MONDAY) return
        if (cal.get(Calendar.HOUR_OF_DAY) < 7) return

        val thisWeekStart = startOfWeek(cal)
        val prefs = context.weeklyStore.data.first()
        if (prefs[lastSentKey] == thisWeekStart) return

        val lastWeekStart = thisWeekStart - WEEK_MS
        val jobs = repository.getAllJobs()
        val wonLastWeek = jobs.count {
            it.status.isWon && (it.scheduledDate ?: it.createdAt) in lastWeekStart until thisWeekStart
        }
        val bookedThisWeek = jobs.count {
            val d = it.scheduledDate ?: return@count false
            d >= thisWeekStart && d < thisWeekStart + WEEK_MS
        }

        val canSeeMoney = session.state.value.canSeeMoney
        val body = buildString {
            if (canSeeMoney) {
                val collected = repository.getAllPayments()
                    .filter { it.receivedAt in lastWeekStart until thisWeekStart }
                    .sumOf { it.amount }
                val money = NumberFormat.getCurrencyInstance(Locale.US).format(collected)
                append(context.getString(R.string.weekly_last_week_money, money, wonLastWeek))
            } else {
                append(context.getString(R.string.weekly_last_week_jobs, wonLastWeek))
            }
            append(' ')
            append(context.getString(R.string.weekly_this_week, bookedThisWeek))
        }

        val shown = Notifications.show(
            context = context,
            id = WEEKLY_NOTIFICATION_ID,
            title = context.getString(R.string.weekly_title),
            body = body
        )
        // Only remembered once it actually went out, so a denied permission
        // this Monday does not silence next Monday.
        if (shown) context.weeklyStore.edit { it[lastSentKey] = thisWeekStart }
    }

    private fun startOfWeek(from: Calendar): Long = (from.clone() as Calendar).apply {
        firstDayOfWeek = Calendar.MONDAY
        set(Calendar.DAY_OF_WEEK, Calendar.MONDAY)
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    private companion object {
        const val CHECK_INTERVAL_MS = 60 * 60 * 1000L
        const val WEEK_MS = 7 * 24 * 60 * 60 * 1000L
        const val WEEKLY_NOTIFICATION_ID = 910_001
    }
}

package com.fenceestimator.app.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import com.fenceestimator.app.FenceEstimatorApp
import com.fenceestimator.app.MainActivity
import com.fenceestimator.app.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale

class TodaysJobsWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        val pendingResult = goAsync()
        val app = context.applicationContext as FenceEstimatorApp
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val startOfDay = Calendar.getInstance().apply {
                    set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
                }.timeInMillis
                val endOfDay = startOfDay + 24 * 60 * 60 * 1000L
                val jobs = app.repository.getJobsScheduledBetween(startOfDay, endOfDay)
                val timeFormat = SimpleDateFormat("h:mm a", Locale.US)

                val text = if (jobs.isEmpty()) {
                    "No jobs scheduled today"
                } else {
                    jobs.joinToString("\n") { job ->
                        val time = job.scheduledDate?.let { timeFormat.format(it) } ?: ""
                        "$time  ${job.customerName.ifBlank { "Job" }}\n${job.address}".trim()
                    }
                }

                val openAppIntent = Intent(context, MainActivity::class.java)
                val pendingIntent = PendingIntent.getActivity(
                    context, 0, openAppIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )

                for (widgetId in appWidgetIds) {
                    val views = RemoteViews(context.packageName, R.layout.widget_todays_jobs)
                    views.setTextViewText(R.id.widget_title, "Today's Jobs (${jobs.size})")
                    views.setTextViewText(R.id.widget_jobs, text)
                    views.setOnClickPendingIntent(R.id.widget_jobs, pendingIntent)
                    views.setOnClickPendingIntent(R.id.widget_title, pendingIntent)
                    appWidgetManager.updateAppWidget(widgetId, views)
                }
            } finally {
                pendingResult.finish()
            }
        }
    }
}

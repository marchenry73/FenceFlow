package com.fenceestimator.app.notify

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.fenceestimator.app.MainActivity
import com.fenceestimator.app.R

/**
 * One place that actually puts a notification on screen.
 *
 * Deliberately independent of where the trigger came from: today the app's own
 * sync calls this when it spots a change, and a Firebase message handler can
 * call the exact same function later without any of this being rewritten.
 */
object Notifications {

    const val CHANNEL_JOBS = "job_updates"
    const val CHANNEL_CREW = "crew_alerts"

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return

        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_JOBS,
                "Job updates",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply { description = "Changes to jobs you're working on" }
        )
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_CREW,
                "Crew alerts",
                NotificationManager.IMPORTANCE_HIGH
            ).apply { description = "New assignments and completed jobs" }
        )
    }

    /**
     * Returns false and does nothing if the user hasn't granted notification
     * permission -- posting without it throws on Android 13+.
     */
    fun show(
        context: Context,
        id: Int,
        title: String,
        body: String,
        channelId: String = CHANNEL_JOBS
    ): Boolean {
        if (!hasPermission(context)) return false
        ensureChannels(context)

        val openApp = PendingIntent.getActivity(
            context,
            id,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .build()

        // Checked here as well as at the call sites: any future caller that
        // forgets is a silent SecurityException on Android 13+, and a
        // notification that quietly never fires is the hardest kind of bug to
        // hear about.
        if (!hasPermission(context)) return false
        return runCatching {
            NotificationManagerCompat.from(context).notify(id, notification)
            true
        }.getOrDefault(false)
    }

    fun hasPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
    }
}

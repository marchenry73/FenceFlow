package com.fenceestimator.app.notify

import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlin.random.Random

/**
 * Receives push messages from Firebase and hands them to the same
 * [Notifications] code the app's own sync uses, so a pushed alert and a
 * locally-detected one look and behave identically.
 *
 * Messages are expected to be "data" messages (not "notification" messages)
 * so this runs even when the app is backgrounded and we control how it looks.
 */
class FenceFlowMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val title = data["title"] ?: message.notification?.title ?: "FenceFlow"
        val body = data["body"] ?: message.notification?.body ?: return

        // A job id lets tapping the notification reuse that job's slot instead
        // of stacking duplicates for the same job.
        val id = data["jobId"]?.toIntOrNull() ?: Random.nextInt(10_000, 99_999)

        Notifications.show(
            context = applicationContext,
            id = id,
            title = title,
            body = body,
            channelId = Notifications.CHANNEL_CREW
        )
    }

    /**
     * Fires when Firebase issues or rotates this device's token. The token is
     * what a server addresses to reach this specific phone; it must be stored
     * server-side before any push can be sent here.
     */
    override fun onNewToken(token: String) {
        PushTokenStore.cache(applicationContext, token)
    }
}

/**
 * Holds the device's push token until there's somewhere to put it.
 *
 * Sending a push needs a server that knows this token. That server piece
 * (a Supabase Edge Function calling Firebase) isn't built yet, so the token
 * is kept locally and shown in Settings rather than being silently dropped --
 * that way the moment the server side exists, the token is already here.
 */
object PushTokenStore {
    private const val PREFS = "push_token"
    private const val KEY = "fcm_token"

    fun cache(context: android.content.Context, token: String) {
        context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
            .edit().putString(KEY, token).apply()
    }

    fun cached(context: android.content.Context): String? =
        context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
            .getString(KEY, null)

    /** Asks Firebase for the current token and caches it. */
    fun refresh(context: android.content.Context, onResult: (String?) -> Unit = {}) {
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token ->
                cache(context, token)
                onResult(token)
            }
            .addOnFailureListener { onResult(null) }
    }
}

package com.fenceestimator.app.notify

import android.content.Context
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.ServiceGate
import com.fenceestimator.app.cloud.SupabaseModule
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import io.github.jan.supabase.auth.status.SessionStatus
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.util.concurrent.atomic.AtomicBoolean
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

        // Not a notification, a question. notify-device-displaced sends this
        // when another handset took this login, and it deliberately carries no
        // words and no verdict -- DeviceClaimPush asks the server itself and
        // writes its own sentence only if the answer is definite. Handled
        // before the generic path below, which would otherwise find no body
        // and drop the message without a trace.
        if (data["kind"] == DeviceClaimPush.PUSH_KIND) {
            DeviceClaimPush.onNudge(applicationContext)
            return
        }

        val title = data["title"] ?: message.notification?.title ?: getString(R.string.app_name)
        val body = data["body"] ?: message.notification?.body ?: return

        // A job id lets tapping the notification reuse that job's slot instead
        // of stacking duplicates for the same job.
        val id = data["jobId"]?.toIntOrNull() ?: Random.nextInt(10_000, 99_999)

        // §28: no server sends a push carrying this field today. Not for want
        // of anywhere to send it from -- notify-job-change and the payment
        // webhooks have been addressing this phone by its token for months --
        // but because none of them tags what it sends with one of this app's
        // own notification keys. (This comment used to say the Edge Function
        // that would address a device by its token did not exist yet, and that
        // the token was therefore only kept on the phone. Both stopped being
        // true when device_tokens shipped.) It is here so that when a server
        // does tag one, a push carrying an AlertPrefs.Keys value -- or a future
        // office ALERT_DEFS key given the same treatment -- is honoured the
        // same way a locally-detected one already is, rather than that server
        // needing to duplicate the mute check itself. Absent, as it always is
        // today, this changes nothing: a message with no alertKey was never
        // checked before and still isn't.
        //
        // The displacement nudge handled above deliberately carries no alertKey
        // and never reaches this check. DeviceClaimPush says why: a muted "you
        // have been signed out here" is a handset that looks completely normal
        // and silently stops working.
        val alertKey = data["alertKey"]
        if (alertKey != null) {
            val muted = runBlocking {
                withTimeoutOrNull(3_000) { AlertPrefs.isMuted(alertKey) } ?: false
            }
            if (muted) return
        }

        Notifications.show(
            context = applicationContext,
            id = id,
            title = title,
            body = body,
            channelId = Notifications.CHANNEL_CREW
        )

        // Pull straight away rather than waiting for the heartbeat.
        //
        // A push means something changed on the server this second -- a payment
        // cleared, a job was reassigned. Showing "Payment received: $500" while
        // the job behind it still reads unpaid for the next fifteen minutes is
        // worse than not notifying at all: it tells someone the app is wrong.
        //
        // Only once the app is running on its database. A push can start the
        // process while the app is being updated, when the database may not
        // load (FenceEstimatorApp.startIfPossible); reaching for autoSync
        // then built the database here instead and crashed the process. The
        // notification above still shows, and the next launch syncs anyway.
        (applicationContext as? com.fenceestimator.app.FenceEstimatorApp)
            ?.takeIf { it.started }
            ?.autoSync?.requestSync()
    }

    /**
     * Fires when Firebase issues or rotates this device's token. The token is
     * what a server addresses to reach this specific phone; it must be stored
     * server-side before any push can be sent here.
     */
    override fun onNewToken(token: String) {
        PushTokenStore.cache(applicationContext, token)
        // A rotated token is a new address for the same handset, so the
        // pairing the server holds has to be rewritten or the next
        // displacement nudge goes to a token Firebase has retired.
        PushTokenStore.bindInstall(applicationContext)
    }
}

/**
 * Two facts about this one handset: the token that addresses it, and which
 * handset it is.
 *
 * The token is cached here because AutoSync uses "is there a token" as its
 * test for whether the server's own pushes can reach this phone at all, and
 * because Settings shows it. It is sent to the server at sign-in by
 * SessionManager, which is what lets the job and payment pushes arrive.
 *
 * The install id is the other half, and it is new. It is the value ServiceGate
 * keeps in the app's own preferences and claim_device stores in
 * profiles.active_device_id. Until [bindInstall] existed, nothing ever sent
 * it, so the server knew WHOSE a phone was and never WHICH phone -- and the
 * only way to reach a displaced handset would have been to push every phone
 * the login has registered. That is what makes "use this phone stops the
 * other phone" addressable rather than a fan-out.
 *
 * (What used to be written here said that the server piece "isn't built yet"
 * and that the token was therefore kept only on the phone. That stopped being
 * true when device_tokens and register_device_token shipped: SessionManager
 * registers the token on every sign-in, and notify-job-change has been
 * sending to it for months.)
 */
object PushTokenStore {
    private const val PREFS = "push_token"
    private const val KEY = "fcm_token"

    /**
     * Its own scope because nothing hands this object one. It is reached from a
     * Firebase service callback and from Application.startServices, neither of
     * which has a scope to lend, and giving them one would mean changing files
     * outside this package. Process-lifetime, like the object itself.
     */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val watchingSession = AtomicBoolean(false)

    /**
     * Which account and token were last successfully paired, so an ordinary
     * token refresh does not re-send the same fact every time the session
     * plugin emits. Only a success is recorded: a phone that could not reach
     * the server must try again, not decide it is already done.
     */
    @Volatile private var boundAs: String? = null

    fun cache(context: android.content.Context, token: String) {
        context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
            .edit().putString(KEY, token).apply()
    }

    fun cached(context: android.content.Context): String? =
        context.getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE)
            .getString(KEY, null)

    /** Asks Firebase for the current token, caches it, and pairs it with this install. */
    fun refresh(context: android.content.Context, onResult: (String?) -> Unit = {}) {
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token ->
                cache(context, token)
                bindInstall(context)
                onResult(token)
            }
            .addOnFailureListener { onResult(null) }
    }

    /**
     * Tells the server that this token belongs to this handset -- now if there
     * is a session, and again the moment one arrives.
     *
     * Driven by the session rather than by a retry count, deliberately. The app
     * starts before anybody signs in, and a person can sign in ten minutes
     * later; a bounded retry at launch would have given up long before, leaving
     * a phone that can never be told it was displaced and nothing anywhere
     * saying so. Watching the session costs nothing while nobody signs in and
     * fires exactly when somebody does, including a sign-in as a different
     * person on the same handset.
     *
     * Every failure here is silent and costs only speed: an unpaired phone is a
     * phone that learns it was displaced on its next resume, which is what every
     * phone did before any of this existed. It is not invisible, though --
     * supabase_r9_displaced_device_push.sql ends by counting the phones that
     * have no install id recorded, so "nobody is paired" cannot pass for "it
     * works".
     */
    fun bindInstall(context: Context) {
        if (!SupabaseModule.isConfigured) return
        scope.launch { bindOnce(context) }
        if (!watchingSession.compareAndSet(false, true)) return
        scope.launch {
            SupabaseModule.sessionStatus.collect { status ->
                if (status is SessionStatus.Authenticated) bindOnce(context)
            }
        }
    }

    private suspend fun bindOnce(context: Context) {
        if (!SupabaseModule.isConfigured || !SupabaseModule.hasLiveSession()) return
        val token = cached(context)?.takeIf { it.isNotBlank() } ?: return
        val userId = SupabaseModule.currentUserId() ?: return
        // Keyed on the account as well as the token: signing out and back in as
        // somebody else has to move the row to them, and the token has not
        // changed.
        val key = userId + "|" + token
        if (boundAs == key) return
        val installId = runCatching { ServiceGate.deviceId(context) }
            .getOrNull()?.takeIf { it.isNotBlank() } ?: return
        val paired = runCatching {
            SupabaseModule.client.postgrest.rpc(
                "register_device_install",
                buildJsonObject {
                    put("device_token", JsonPrimitive(token))
                    put("p_device_id", JsonPrimitive(installId))
                }
            )
        }.isSuccess
        if (paired) boundAs = key
    }
}

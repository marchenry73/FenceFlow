package com.fenceestimator.app.notify

import android.content.Context
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.ServiceGate
import com.fenceestimator.app.cloud.SupabaseModule
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull

/**
 * What this phone does when the server nudges it to check whether it still
 * holds the login.
 *
 * ## Why a nudge and not an instruction
 *
 * The message that arrives here carries one field -- its kind -- and no
 * verdict. It cannot say "you have been signed out", and this code would not
 * believe it if it did. The phone asks the server itself and acts only on that
 * answer.
 *
 * That is a security property, not tidiness. The push is authorised by a shared
 * secret held by a database trigger and an edge function. If a message could
 * carry the verdict, then anyone who ever came to hold that secret could stop a
 * working crew's app from the other side of the world. Because the answer comes
 * from device_still_mine, asked by this phone with its own session, the worst a
 * forged message can do is cost one handset one request.
 *
 * ## What happens when the re-check cannot complete
 *
 * NOTHING. Every one of these -- no session, no signal, a timeout, a refused
 * call, an exception -- leaves this phone exactly as it was: still working,
 * still syncing, no notification, nothing on screen.
 *
 * This is the constraint the whole gate is built around, and ServiceGate says
 * it in its own words about the code being called here: "Only ever false on a
 * definite answer from the server. Offline, or any failure, leaves it true -- a
 * crew member in a dead spot must not be thrown out of the app on a guess." The
 * file's header is blunter still: "A locked-out crew standing in a yard is a
 * real cost to a real customer. So the gate closes only on a definite answer: a
 * company is blocked when the server said to block it, never because the phone
 * could not ask."
 *
 * A push that arrives and cannot be answered therefore changes nothing at all,
 * which is the same position this phone was in before any of this existed: it
 * finds out on its next resume. The nudge can only ever make the truth arrive
 * SOONER, never make a lie arrive at all.
 *
 * Note the deliberate consequence of asking through [ServiceGate.stillMine]:
 * that function answers true both for "yes, still yours" and for "could not
 * tell", and does not distinguish them. Here that is exactly right, because
 * both mean do nothing. Nothing in this file may ever be changed to treat a
 * failure as a displacement.
 */
object DeviceClaimPush {

    /**
     * The one field the message carries. The same word lives in
     * supabase/functions/notify-device-displaced/index.ts; a mismatch means the
     * message falls through to the ordinary notification path, finds no body,
     * and is dropped without a trace -- so it is a constant on both sides
     * rather than a literal typed twice.
     */
    const val PUSH_KIND = "device_displaced"

    /**
     * Fixed, so a second claim replaces the first notice instead of stacking a
     * second one. Chosen clear of every other id in the app: the job pushes use
     * the job's own id or a random 10,000-99,999, AutoSync uses 9,000 and
     * 9,001, and WeeklySummary uses 910,001.
     */
    private const val DISPLACED_NOTIFICATION_ID = 910_002

    /**
     * How long the re-check may take before this gives up and does nothing.
     *
     * Android allows a data message's handler about ten seconds. Running past
     * that gets the process killed mid-call, which would leave the question
     * unanswered anyway -- so it is asked with a budget and abandoned cleanly.
     */
    private const val CHECK_BUDGET_MS = 9_000L

    private enum class Verdict {
        /** The server said another phone holds this login. The only actionable case. */
        NOT_MINE,

        /** The server said this phone still holds it, OR the question could not be asked. */
        NOTHING_TO_DO,
    }

    /**
     * Handles one displacement nudge. Called from
     * [FenceFlowMessagingService.onMessageReceived], which is already off the
     * main thread, so this blocks that thread for at most [CHECK_BUDGET_MS] the
     * same way the mute check beside it does.
     */
    fun onNudge(context: Context) {
        val verdict = runBlocking {
            withTimeoutOrNull(CHECK_BUDGET_MS) { ask(context) }
        } ?: Verdict.NOTHING_TO_DO   // timed out: the question was never answered
        if (verdict != Verdict.NOT_MINE) return

        // Only now, after the server itself has said so. ServiceGate has
        // already written the displaced flag as part of answering, which is
        // what stops AutoSync pushing this phone's work over the phone that
        // holds the login now.
        //
        // Deliberately carries no alertKey, so it is not checked against the
        // per-person mute list the way job and digest notifications are. A
        // muted "you have been signed out here" is a handset that looks
        // completely normal and silently stops working, which is the failure
        // this whole item exists to remove.
        Notifications.show(
            context = context,
            id = DISPLACED_NOTIFICATION_ID,
            title = context.getString(R.string.svc_elsewhere_title),
            body = context.getString(R.string.push_displaced_body),
            channelId = Notifications.CHANNEL_CREW
        )
    }

    /**
     * Asks the server, and says only whether there is something to do.
     *
     * Every early return is "nothing to do". A phone with no configured
     * backend, no session, or no way to get a token is a phone that cannot be
     * told anything definite, and a guess is not allowed to stand in for an
     * answer.
     */
    private suspend fun ask(context: Context): Verdict {
        if (!SupabaseModule.isConfigured) return Verdict.NOTHING_TO_DO

        // A background push often arrives with the in-memory token expired.
        // Asking for a fresh one first is the difference between answering the
        // question and shrugging at it -- and it is safe to ask, because
        // tryRefreshSession defers to the Auth plugin rather than racing it.
        if (!SupabaseModule.hasLiveSession()) {
            runCatching { SupabaseModule.tryRefreshSession() }
            if (!SupabaseModule.hasLiveSession()) return Verdict.NOTHING_TO_DO
        }

        val stillMine = runCatching { ServiceGate.stillMine(context) }.getOrDefault(true)
        return if (stillMine) Verdict.NOTHING_TO_DO else Verdict.NOT_MINE
    }
}

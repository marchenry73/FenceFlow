package com.fenceestimator.app.cloud

import io.github.jan.supabase.realtime.PostgresAction
import io.github.jan.supabase.realtime.channel
import io.github.jan.supabase.realtime.postgresChangeFlow
import io.github.jan.supabase.realtime.realtime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Keeps the phone live on the money, with nothing to press.
 *
 * Everything else that brings a payment down has a gap in it. A sync pass runs
 * on a heartbeat. A push notification needs notifications to be allowed and
 * Firebase to be able to reach the phone. Opening the job screen pulls, but
 * only once you open it. All of those leave a window where Stripe has the money
 * and the app says the customer still owes it -- and that window is exactly
 * when someone is standing in front of the customer.
 *
 * A Postgres change feed has no such window: the row commits, the socket
 * delivers, the phone syncs. This subscribes to the company's own rows only,
 * and does not trust the payload -- it triggers a sync and lets the existing
 * merge rules decide what to keep, so a spoofed or partial message cannot write
 * anything the normal path would refuse.
 */
class RealtimeWatcher(
    private val scope: CoroutineScope,
    private val session: SessionManager,
    private val autoSync: AutoSync
) {
    private var subscription: Job? = null

    fun start() {
        if (!SupabaseModule.isConfigured) return

        // Re-subscribe whenever the company changes, including the first time
        // it resolves after sign-in. Subscribing before then would filter on a
        // null company and listen to nothing.
        scope.launch {
            session.state
                .map { it.companyId }
                .distinctUntilChanged()
                .filterNotNull()
                .collect { companyId ->
                    subscription?.cancel()
                    subscription = scope.launch { listen(companyId) }
                }
        }
    }

    private suspend fun listen(companyId: String) {
        // Reconnects for as long as this company is signed in. A dropped socket
        // is normal on a phone -- a tunnel, a dead spot, a screen-off doze --
        // and a watcher that gives up on the first drop is worse than none,
        // because it looks like it is working.
        var backoffMs = INITIAL_BACKOFF_MS
        while (true) {
            val result = runCatching {
                val channel = SupabaseModule.client.channel("company-$companyId")

                val jobChanges = channel.postgresChangeFlow<PostgresAction.Update>(schema = "public") {
                    table = "jobs"
                    filter("company_id", io.github.jan.supabase.postgrest.query.filter.FilterOperator.EQ, companyId)
                }
                val paymentChanges = channel.postgresChangeFlow<PostgresAction>(schema = "public") {
                    table = "job_payments"
                    filter("company_id", io.github.jan.supabase.postgrest.query.filter.FilterOperator.EQ, companyId)
                }

                scope.launch { paymentChanges.collect { autoSync.requestSync() } }

                SupabaseModule.client.realtime.connect()
                channel.subscribe(blockUntilSubscribed = true)
                backoffMs = INITIAL_BACKOFF_MS

                // Pull rather than apply. The payload says what changed; the
                // sync path knows the rules -- that a cleared payment never
                // goes backwards, that a pull must not wipe the calibration.
                // Bypassing it here would be a second, weaker merge.
                jobChanges.collect { autoSync.requestSync() }
            }
            if (result.isSuccess) return

            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
        }
    }

    private companion object {
        const val INITIAL_BACKOFF_MS = 2_000L
        const val MAX_BACKOFF_MS = 60_000L
    }
}

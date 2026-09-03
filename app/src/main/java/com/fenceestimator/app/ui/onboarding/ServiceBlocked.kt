package com.fenceestimator.app.ui.onboarding

import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.ServiceStatus

/**
 * Shown when a company's access has genuinely ended.
 *
 * Written for the person holding the phone, who is usually not the person who
 * pays. A crew member seeing this has done nothing wrong and can do nothing
 * about it, so the screen tells them what happened, that their work is safe,
 * and who to ask -- rather than presenting a wall.
 *
 * Their data is deliberately NOT deleted and not hidden from the company that
 * owns it. Access ending is a billing state, not a reason to destroy somebody's
 * records; everything is still there the moment it is sorted out.
 */
@Composable
fun ServiceBlockedScreen(
    status: ServiceStatus,
    /** True while an answer is being fetched. */
    checking: Boolean = false,
    /** True when the last attempt never reached the server. */
    couldNotCheck: Boolean = false,
    /** True while signing out, which involves the network and is not instant. */
    signingOut: Boolean = false,
    onRetry: () -> Unit,
    onSignOut: () -> Unit
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    // A company that has never subscribed is not a company that has been cut
    // off, and telling somebody who just created their business that FenceFlow
    // "is paused" is a dead end: no explanation they can act on, and only
    // Check again and Sign out to choose between. That was the first thing a
    // new customer saw after signing up on the phone.
    //
    // Subscribing stays on the website deliberately -- selling it inside the
    // app would put it through Play billing and its cut -- so the honest move
    // is to say so and open the page.
    val neverSubscribed = status.subscriptionStatus.isBlank() ||
        status.subscriptionStatus in setOf("pending", "none")

    // What Sign out from here would actually throw away.
    //
    // This screen's sign-out used to skip straight to a forced wipe -- the
    // gate above already blocks syncing, so the reasoning was that waiting
    // for signal could never help anyway. True right up until somebody hits
    // this screen holding a signature or photos taken with no signal that
    // never got a chance to go up before their access was cut off. Checked
    // locally so the warning below is accurate on its own, independent of
    // whatever onSignOut itself ends up doing with force.
    var unsynced by remember { mutableStateOf<com.fenceestimator.app.data.UnsyncedSummary?>(null) }
    LaunchedEffect(Unit) {
        val app = context.applicationContext as? com.fenceestimator.app.FenceEstimatorApp
        unsynced = app?.let { runCatching { it.repository.unsyncedSummary() }.getOrNull() }
    }
    val holdsUnsyncedWork = unsynced?.isEmpty == false
    // The first tap only warns. Signing out -- and losing whatever is
    // counted above -- takes a second, deliberate tap once that warning is
    // on screen, the same "are you sure" shape as any other destructive
    // confirmation in this app.
    var confirmingLoss by remember { mutableStateOf(false) }

    // Scrollable, and that is not a detail.
    //
    // This screen grew: a heading, three paragraphs, a status line and three
    // buttons. A Column that does not scroll still LAYS OUT everything past
    // the bottom of the screen -- it is drawn, but it sits outside the
    // parent's bounds, and anything outside those bounds cannot be touched.
    // So the buttons at the end looked present and did nothing when pressed,
    // including Sign out, which is the one way off a screen somebody is stuck
    // on. Reported as "it won't let me click", which is exactly right.
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            stringResource(
                if (neverSubscribed) R.string.onb_trial_title else R.string.onb_paused_title
            ),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold
        )
        Text(
            if (neverSubscribed) stringResource(R.string.onb_trial_explain)
            else status.reason.ifBlank { stringResource(R.string.onb_paused_default_reason) },
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        if (!neverSubscribed) {
            Text(
                stringResource(R.string.onb_paused_nothing_lost),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Text(
            stringResource(
                if (neverSubscribed) R.string.onb_trial_where else R.string.onb_paused_crew_note
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        // What the last check actually did.
        //
        // Check again re-asked, got no answer, and changed nothing on screen --
        // which is indistinguishable from a button that does not work, and is
        // what somebody sitting on this screen reports. It says so now.
        if (checking) {
            Text(
                stringResource(R.string.onb_checking),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        } else if (couldNotCheck) {
            Text(
                stringResource(R.string.onb_check_failed),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error
            )
        }

        Button(
            onClick = {
                runCatching {
                    context.startActivity(
                        android.content.Intent(
                            android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse(BILLING_URL)
                        )
                    )
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                stringResource(
                    if (neverSubscribed) R.string.onb_trial_open else R.string.onb_paused_open_billing
                )
            )
        }
        OutlinedButton(
            onClick = onRetry,
            enabled = !checking,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(stringResource(if (checking) R.string.onb_checking else R.string.onb_check_again))
        }
        // Told before it is lost, not after -- shown as soon as the first tap
        // asks for it, so the button's changed label ("Sign out anyway and
        // lose it") is not the first anyone hears of what it now means.
        if (holdsUnsyncedWork && confirmingLoss) {
            Text(
                stringResource(
                    R.string.onb_sign_out_unsynced_warning,
                    unsynced?.jobs ?: 0,
                    unsynced?.files ?: 0
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error
            )
        }
        // Signing out talks to the server before it takes effect, so it is not
        // instant -- and with no sign of that, a second or two of nothing reads
        // as a button that does not work. It says what it is doing.
        OutlinedButton(
            onClick = {
                if (holdsUnsyncedWork && !confirmingLoss) {
                    // First tap: ask, don't act. The actual sign-out below is
                    // unchanged by this -- it is whatever onSignOut already
                    // does -- but nobody reaches it without seeing this first.
                    confirmingLoss = true
                } else {
                    onSignOut()
                }
            },
            enabled = !signingOut,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                stringResource(
                    when {
                        signingOut -> R.string.onb_signing_out
                        confirmingLoss -> R.string.onb_sign_out_anyway
                        else -> R.string.onb_sign_out
                    }
                )
            )
        }
    }
}

/** Where a plan is chosen. Web only, so Play billing never applies. */
private const val BILLING_URL = "https://fenceflowapp.com/dashboard.html"

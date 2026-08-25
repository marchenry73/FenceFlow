package com.fenceestimator.app.ui.onboarding

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

    Column(
        modifier = Modifier.fillMaxSize().padding(28.dp),
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
        OutlinedButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.onb_sign_out))
        }
    }
}

/** Where a plan is chosen. Web only, so Play billing never applies. */
private const val BILLING_URL = "https://marchenry73.github.io/FenceFlow/dashboard.html"

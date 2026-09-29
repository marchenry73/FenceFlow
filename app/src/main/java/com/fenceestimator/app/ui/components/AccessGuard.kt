package com.fenceestimator.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R

/**
 * Shuts a screen the moment the person loses the right to be on it.
 *
 * Access was only ever checked on the way in. Someone already sitting on
 * Reports or Settings when their access changed stayed there until they
 * happened to navigate away -- so removing somebody's access did not remove
 * what they could see, which is the part that matters when you are removing it
 * because you no longer trust them with it.
 *
 * The change now arrives within seconds (the session state is a flow, and a
 * revocation reaches the phone by Realtime or push), and this closes the screen
 * as soon as it does.
 *
 * Deliberately a visible panel rather than a silent jump back. A screen that
 * empties itself with no explanation reads as the app breaking, and the person
 * affected is owed a straight answer about what happened -- they will ask
 * either way, and "your access changed" is a shorter conversation than "the app
 * is broken".
 *
 * This is a courtesy, not the security boundary. Row Level Security refuses the
 * data itself; hiding the screen stops somebody reading what is already loaded.
 */
@Composable
fun AccessGuard(
    allowed: Boolean,
    /** What they no longer have, in the words used on the access screen. */
    permissionName: String,
    onLeave: () -> Unit,
    content: @Composable () -> Unit
) {
    if (allowed) {
        content()
        return
    }

    // Read locally rather than threaded through every call site, the same
    // way JobDetailScreen's own money fields reach the session for
    // themselves. A guest in the read-only demo landing here has not had
    // anything taken away -- nobody revoked anything, there is no owner to
    // ask -- so "your access changed" is the wrong sentence for them even
    // though the panel underneath is the right one. onb_access_changed_guest_body
    // exists for exactly this and was sitting unused.
    val isGuestDemo = currentApp().session.state.collectAsState().value.isGuestDemo

    Column(
        modifier = Modifier.fillMaxSize().padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            stringResource(R.string.onb_access_changed_title),
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold
        )
        Text(
            if (isGuestDemo) stringResource(R.string.onb_access_changed_guest_body)
            else stringResource(R.string.onb_access_changed_body, permissionName),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        // "Ask an owner" makes no sense to somebody in a sample company with
        // no owner but themselves -- the guest body above already tells them
        // the one thing they can actually do, which is sign in for real.
        if (!isGuestDemo) {
            Text(
                stringResource(R.string.onb_access_changed_ask_owner),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Button(onClick = onLeave) { Text(stringResource(R.string.onb_go_back)) }
    }
}

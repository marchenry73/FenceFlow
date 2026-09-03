package com.fenceestimator.app.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.DataOwnership
import com.fenceestimator.app.ui.theme.Space

/**
 * The phone is holding work the cloud never got, and a wipe was refused.
 *
 * Two ways this happens: somebody was taken off the crew before a signature
 * and photos taken with no signal had a chance to upload, or a shared phone
 * was signed into a different company while the previous one's work was
 * still waiting. Either way the old rule -- "it is already in the cloud, so
 * clearing it here loses nothing" -- is false for exactly this phone, so
 * instead of clearing it the app stops here and says so.
 *
 * There is deliberately no "sync it now" button. A removed crew member's
 * push is refused by the server, and a phone signed into a different company
 * would push the old company's work into the new one's books. The only
 * honest way up is the account the work belongs to: sign out keeping it,
 * get put back on the crew, sign in as that account, and it goes up on its
 * own. Discarding is the other door, behind a second tap, in the colour
 * every other irreversible thing in this app wears.
 */
@Composable
fun HeldWorkScreen(
    held: DataOwnership.HeldWork,
    signingOut: Boolean,
    onSignOutKeeping: () -> Unit,
    onDiscard: () -> Unit
) {
    var confirmingDiscard by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(Space.xxl),
        verticalArrangement = Arrangement.spacedBy(Space.md, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            stringResource(R.string.held_work_title),
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold
        )
        Text(
            stringResource(
                R.string.data_ownership_held_work,
                stringResource(R.string.held_work_previous_business),
                held.summary.jobs,
                held.summary.files
            ),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Button(
            onClick = onSignOutKeeping,
            enabled = !signingOut,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(stringResource(if (signingOut) R.string.onb_signing_out else R.string.held_work_sign_out_keep))
        }
        if (confirmingDiscard) {
            Text(
                stringResource(R.string.held_work_discard_warning),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error
            )
        }
        OutlinedButton(
            onClick = { if (confirmingDiscard) onDiscard() else confirmingDiscard = true },
            enabled = !signingOut,
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)
        ) {
            Text(stringResource(if (confirmingDiscard) R.string.held_work_discard_confirm else R.string.held_work_discard))
        }
    }
}

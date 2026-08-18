package com.fenceestimator.app.ui.onboarding

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.cloud.AppRelease

/**
 * "There is a newer version, and here is what changed."
 *
 * The only launch-time message worth showing. One that appears every time gets
 * dismissed without reading; one that appears only when something actually
 * changed gets read -- which matters, because the version people most need to
 * install is the one fixing something about their money.
 *
 * Notes are printed as written rather than summarised into "bug fixes and
 * improvements", which tells nobody anything and is why nobody reads them.
 */
@Composable
fun UpdateAvailableDialog(
    release: AppRelease,
    onDownload: () -> Unit,
    onLater: () -> Unit
) {
    AlertDialog(
        // A mandatory update has no way out -- not even tapping outside it.
        // Reserved for the cases where staying put risks data or money, since
        // an app that insists on updating for a colour change teaches people to
        // ignore the one that matters.
        onDismissRequest = { if (!release.isMandatory) onLater() },
        title = {
            Text(
                if (release.isMandatory) "Update needed" else "New version available",
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (release.notes.isNotBlank()) {
                    Text(release.notes, style = MaterialTheme.typography.bodyMedium)
                }
                Text(
                    "Version " + release.versionName,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (release.isMandatory) {
                    Text(
                        "This one fixes something worth not putting off.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
                // Said plainly because it is the part people worry about, and
                // the worry is what stops them updating.
                Text(
                    "Installing an update keeps everything -- your jobs, drawings, " +
                        "photos and payments all stay exactly as they are.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            Button(
                enabled = release.downloadUrl.isNotBlank(),
                onClick = onDownload
            ) { Text("Get it") }
        },
        dismissButton = {
            if (!release.isMandatory) {
                TextButton(onClick = onLater) { Text("Later") }
            }
        }
    )
}

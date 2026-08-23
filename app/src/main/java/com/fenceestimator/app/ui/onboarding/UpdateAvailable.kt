package com.fenceestimator.app.ui.onboarding

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R
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
    /** Non-null once downloading has started. */
    progress: com.fenceestimator.app.cloud.ApkUpdater.Progress? = null,
    onDownload: () -> Unit,
    /** The way out when the link cannot be downloaded here. */
    onOpenInBrowser: () -> Unit = {},
    onLater: () -> Unit
) {
    val downloading = progress is com.fenceestimator.app.cloud.ApkUpdater.Progress.Downloading
    val installing = progress is com.fenceestimator.app.cloud.ApkUpdater.Progress.Installing
    val failed = progress as? com.fenceestimator.app.cloud.ApkUpdater.Progress.Failed
    val busy = downloading || installing
    AlertDialog(
        // A mandatory update has no way out -- not even tapping outside it.
        // Reserved for the cases where staying put risks data or money, since
        // an app that insists on updating for a colour change teaches people to
        // ignore the one that matters.
        onDismissRequest = { if (!release.isMandatory && !busy) onLater() },
        title = {
            Text(
                if (release.isMandatory) stringResource(R.string.onb_update_needed) else stringResource(R.string.onb_new_version_available),
                fontWeight = FontWeight.Bold
            )
        },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (release.notes.isNotBlank()) {
                    Text(release.notes, style = MaterialTheme.typography.bodyMedium)
                }
                Text(
                    stringResource(R.string.onb_version_label, release.versionName),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (release.isMandatory) {
                    Text(
                        stringResource(R.string.onb_update_worth_not_putting_off),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
                // Said plainly because it is the part people worry about, and
                // the worry is what stops them updating.
                if (release.downloadUrl.isBlank()) {
                    Text(
                        stringResource(R.string.onb_update_in_shared_folder),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (downloading) {
                    val percent = (progress as com.fenceestimator.app.cloud.ApkUpdater.Progress.Downloading).percent
                    LinearProgressIndicator(
                        progress = { percent / 100f },
                        modifier = Modifier.fillMaxWidth()
                    )
                    Text(
                        stringResource(R.string.onb_downloading_percent, percent),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (installing) {
                    Text(
                        stringResource(R.string.onb_update_ready_to_install),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (failed != null) {
                    Text(
                        failed.reason,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
                Text(
                    stringResource(R.string.onb_update_keeps_everything),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            // A greyed-out button with no explanation reads as the app being
            // broken. If a release was published without a download link, say
            // where to get it instead of offering a control that does nothing.
            when {
                release.downloadUrl.isBlank() -> TextButton(onClick = onLater) { Text(stringResource(R.string.onb_ok)) }
                // Once the download has failed, the honest offer is the browser
                // rather than the same button that just did not work.
                failed != null -> Button(onClick = onOpenInBrowser) { Text(stringResource(R.string.onb_open_in_browser)) }
                else -> Button(enabled = !busy, onClick = onDownload) {
                    Text(if (busy) stringResource(R.string.onb_working) else stringResource(R.string.onb_update_now))
                }
            }
        },
        dismissButton = {
            if (!release.isMandatory && !busy) {
                TextButton(onClick = onLater) { Text(stringResource(R.string.onb_later)) }
            }
        }
    )
}

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
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
    onRetry: () -> Unit,
    onSignOut: () -> Unit
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(
            "FenceFlow is paused",
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold
        )
        Text(
            status.reason.ifBlank { "This company's access to FenceFlow has ended." },
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            "Nothing has been lost. Every job, drawing, photo and payment is exactly " +
                "where it was, and comes straight back as soon as this is sorted out.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            "If you are on the crew, this is one for the office -- there is nothing " +
                "for you to fix here.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
            Text("Check again")
        }
        OutlinedButton(onClick = onSignOut, modifier = Modifier.fillMaxWidth()) {
            Text("Sign out")
        }
    }
}

package com.fenceestimator.app.guest

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R

/**
 * The honest, always-visible countdown the owner asked for: how long is
 * left, and what happens when it runs out. It sits at the top of the app
 * for the whole guest session rather than showing once and being dismissed
 * -- a timer nobody can see again is a surprise wipe by another name.
 */
@Composable
fun GuestBanner(remainingMs: Long) {
    Surface(
        color = MaterialTheme.colorScheme.tertiaryContainer,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
            Text(
                stringResource(R.string.guest_banner_time_left, GuestSession.formatRemaining(remainingMs)),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onTertiaryContainer
            )
            Text(
                stringResource(R.string.guest_banner_explain),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onTertiaryContainer
            )
        }
    }
}

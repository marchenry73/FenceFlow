package com.fenceestimator.app.ui.components

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import com.fenceestimator.app.ui.theme.Space

/**
 * What an empty list says, so that empty and broken never look alike.
 *
 * A heading with nothing under it is indistinguishable from a load that
 * failed, and on a phone in a yard the difference matters: one means "add
 * something", the other means "sync, then look again". Every list gets one
 * of these; the wording says which of the two it is.
 */
@Composable
fun EmptyState(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier.fillMaxWidth().padding(vertical = Space.md),
    )
}

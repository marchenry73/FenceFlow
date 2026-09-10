package com.fenceestimator.app.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
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

/**
 * True once [timeoutMs] has passed since this was first composed.
 *
 * A record that keeps a screen's `val x = record ?: return` waiting forever
 * looks identical to one that loaded fine and has nothing in it -- both are a
 * blank body with just a back arrow. This gives a screen a moment to let the
 * local database answer before it commits to "not on this phone", so a slow
 * cold start does not get misread as a missing record.
 */
@Composable
fun rememberLoadTimedOut(timeoutMs: Long = 4000): Boolean {
    var timedOut by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        kotlinx.coroutines.delay(timeoutMs)
        timedOut = true
    }
    return timedOut
}

/**
 * What a screen shows in place of its body while the record it needs has not
 * arrived yet. Spinning while [stillLoading], the same [EmptyState] wording
 * every other empty list on this app uses once it isn't -- so a crew member
 * on a weak connection can tell "wait" from "this is not on this phone"
 * instead of staring at a screen that looks broken either way.
 */
@Composable
fun LoadingOrMissing(stillLoading: Boolean, notFoundText: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (stillLoading) {
            CircularProgressIndicator()
        } else {
            EmptyState(notFoundText)
        }
    }
}

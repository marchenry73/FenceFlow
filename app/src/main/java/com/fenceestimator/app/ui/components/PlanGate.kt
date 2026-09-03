package com.fenceestimator.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.fenceestimator.app.R
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.ui.theme.Space

/**
 * A feature the plan does not include, shown rather than hidden.
 *
 * Plan-gated sections used to be wrapped in a bare `if (entitled)`, so on a
 * Solo phone the card-payment block, the profit tiles and the crew screen
 * were simply absent -- and a tile that was there but did nothing on tap read
 * as the app being broken. [AccessGuard] already answers the same question
 * for roles ("you no longer have X, ask the owner"); this answers it for
 * plans: what this is, which plan has it, where to turn it on.
 *
 * The server still enforces the boundary. This only stops the silence.
 */
@Composable
fun PlanGate(
    allowed: Boolean,
    /** What is behind the gate, as the user would name it: "Card payments". */
    feature: String,
    /** The plan that includes it, from [R.string.plan_crew] or [R.string.plan_pro]. */
    plan: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    if (allowed) {
        content()
        return
    }
    LockedNote(feature = feature, plan = plan, modifier = modifier)
}

/** The locked panel on its own, for places that shape their own layout. */
@Composable
fun LockedNote(feature: String, plan: String, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier.fillMaxWidth(),
        shape = MaterialTheme.shapes.medium,
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = Space.lg, vertical = Space.md),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Space.md),
        ) {
            Icon(
                Icons.Outlined.Lock,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(feature, style = MaterialTheme.typography.titleSmall)
                Text(
                    stringResource(R.string.plan_locked_body, plan),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

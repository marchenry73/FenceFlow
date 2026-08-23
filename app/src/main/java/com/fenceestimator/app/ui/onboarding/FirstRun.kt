package com.fenceestimator.app.ui.onboarding

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R

/**
 * The first thing a new company sees.
 *
 * Deliberately short. A long tour of an app somebody has not used yet is
 * forgotten before they reach the end -- what actually helps is knowing the
 * three or four things that are not obvious, and being able to get out.
 *
 * It covers what would otherwise be found the hard way: that the estimate is
 * provisional until a supplier quotes, that the customer's document is not the
 * one with your prices on it, and that deleting is recoverable. None of those
 * are guessable, and all of them cost money when discovered late.
 */
private data class Step(@StringRes val title: Int, @StringRes val body: Int)

private val STEPS = listOf(
    Step(R.string.onb_step1_title, R.string.onb_step1_body),
    Step(R.string.onb_step2_title, R.string.onb_step2_body),
    Step(R.string.onb_step3_title, R.string.onb_step3_body),
    Step(R.string.onb_step4_title, R.string.onb_step4_body),
    Step(R.string.onb_step5_title, R.string.onb_step5_body)
)

/**
 * @param onFinished called when they finish or skip -- either way it does not
 *   come back. Somebody who skipped it does not want it again tomorrow.
 */
@Composable
fun FirstRunTour(onFinished: () -> Unit) {
    var index by remember { mutableStateOf(0) }
    val step = STEPS[index]
    val isLast = index == STEPS.lastIndex

    AlertDialog(
        onDismissRequest = onFinished,
        title = { Text(stringResource(step.title), fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(stringResource(step.body), style = MaterialTheme.typography.bodyMedium)
                Text(
                    stringResource(R.string.onb_step_counter, index + 1, STEPS.size),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            Button(onClick = { if (isLast) onFinished() else index++ }) {
                Text(if (isLast) stringResource(R.string.onb_start_using_it) else stringResource(R.string.onb_next))
            }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (index > 0) {
                    OutlinedButton(onClick = { index-- }) { Text(stringResource(R.string.action_back)) }
                }
                // An escape on every step, not only the first. Being trapped in
                // a tour is what makes people uninstall before they have seen
                // anything.
                TextButton(onClick = onFinished) { Text(stringResource(R.string.onb_skip)) }
            }
        }
    )
}

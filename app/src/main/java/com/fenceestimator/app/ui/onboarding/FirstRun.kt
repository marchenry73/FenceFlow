package com.fenceestimator.app.ui.onboarding

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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

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
private data class Step(val title: String, val body: String)

private val STEPS = listOf(
    Step(
        "Draw the fence, get a number",
        "Draw the line on the grid or on a survey photo, then press Suggest " +
            "Quantities. You'll have posts, panels, concrete and a price in about " +
            "a minute -- accurate enough to quote from on the spot."
    ),
    Step(
        "That price is provisional, and the app says so",
        "Materials are costed from your catalog, which is a good guess and not " +
            "what you'll pay. Send the material list to your supplier, put their " +
            "prices back in, and everything downstream re-prices itself."
    ),
    Step(
        "The customer never sees your material costs",
        "They get a contract: the scope, the agreed price, your terms. Your " +
            "supplier gets quantities with no prices. Your own working copy has " +
            "everything. Three documents, three readers."
    ),
    Step(
        "Your crew see the plan, not the money",
        "Crew get the drawing, the checklists and their own pay -- never the " +
            "customer's price or your margin. If they think the plan is wrong they " +
            "ask, and you approve it."
    ),
    Step(
        "Nothing is really deleted",
        "Deleted jobs go to Account & Team → Deleted Items and can be put back " +
            "for everyone. Set up your business details and pricing in Settings " +
            "before your first real quote."
    )
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
        title = { Text(step.title, fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(step.body, style = MaterialTheme.typography.bodyMedium)
                Text(
                    "${index + 1} of ${STEPS.size}",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        },
        confirmButton = {
            Button(onClick = { if (isLast) onFinished() else index++ }) {
                Text(if (isLast) "Start using it" else "Next")
            }
        },
        dismissButton = {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (index > 0) {
                    OutlinedButton(onClick = { index-- }) { Text("Back") }
                }
                // An escape on every step, not only the first. Being trapped in
                // a tour is what makes people uninstall before they have seen
                // anything.
                TextButton(onClick = onFinished) { Text("Skip") }
            }
        }
    )
}

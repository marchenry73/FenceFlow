package com.fenceestimator.app.ui.runs

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R
import com.fenceestimator.app.data.MaterialRole

/**
 * The colours this company stocks for this fence type, under the colour field.
 *
 * UNDER the field and not instead of it. The field stays free text because a
 * customer can ask for a colour that is not loaded into the catalog yet, and a
 * closed list would have made that impossible on the day it shipped. These are
 * an offer, not a constraint.
 *
 * Every number and every warning comes from [RunColourOptions], which is pure
 * and has its own tests and canary. Nothing is decided in this file: a rule
 * written inside a Composable is a rule no unit test can reach, and this one
 * is about money.
 */
@Composable
fun ColourChoices(
    options: List<RunColourOptions.Option>,
    typed: String,
    enabled: Boolean,
    onPick: (String) -> Unit
) {
    if (options.isEmpty()) {
        Text(
            stringResource(R.string.colour_none_in_catalog),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 6.dp)
        )
        return
    }

    val selected = RunColourOptions.match(options, typed)

    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Text(
            stringResource(R.string.colour_in_your_catalog),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(top = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            options.forEach { option ->
                FilterChip(
                    selected = option.colour == selected?.colour,
                    onClick = { onPick(option.colour) },
                    enabled = enabled,
                    colors = FilterChipDefaults.filterChipColors(),
                    label = {
                        Column {
                            Text(option.colour, style = MaterialTheme.typography.labelLarge)
                            // The price he asked to see. A colour with no panel
                            // says so instead of showing nothing, because a
                            // colour you cannot buy a panel in is not a colour
                            // you can build in.
                            Text(
                                option.panelPrice?.let {
                                    stringResource(R.string.colour_panel_price, money(it))
                                } ?: stringResource(R.string.colour_no_panel),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                )
            }
        }

        // WHAT THE CHOSEN COLOUR CANNOT DRESS. This is the half that is not a
        // convenience: before it, a tan fence was quoted with white corner
        // posts and nothing said so until the estimate -- and before
        // 2026.11.18, not even then.
        val note: String? = when {
            typed.isBlank() -> null
            selected == null -> stringResource(R.string.colour_not_stocked)
            selected.coversEverything -> stringResource(R.string.colour_covers_all)
            else -> stringResource(R.string.colour_short_parts, selected.missingRoles.readable())
        }
        if (note != null) {
            Text(
                note,
                style = MaterialTheme.typography.bodySmall,
                textAlign = TextAlign.Start,
                color = if (selected != null && selected.coversEverything)
                    MaterialTheme.colorScheme.onSurfaceVariant
                else MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(top = 6.dp)
            )
        }
    }
}

/**
 * "corner post, trim" -- the roles as a fencer says them, not as the enum
 * spells them.
 *
 * Deliberately not a per-role translated string table: there are thirty-odd
 * roles, this would be thirty-odd strings in three languages for a warning
 * line, and a missing one would render a raw enum name at the customer. The
 * underscore-to-space reading is the same one the phone's unmatched-role
 * warning has always used, so the two lines read alike.
 */
/**
 * The same two decimals and the same US locale the rest of this app prints
 * money with (EstimateEngine.money, DataExporter.money). Local because the ui
 * package has no shared formatter today, and inventing a second convention for
 * one chip is how two parts of a screen start disagreeing about a price.
 */
private fun money(value: Double): String = "$" + "%.2f".format(java.util.Locale.US, value)

private fun List<MaterialRole>.readable(): String =
    joinToString(", ") { it.name.replace('_', ' ').lowercase() }

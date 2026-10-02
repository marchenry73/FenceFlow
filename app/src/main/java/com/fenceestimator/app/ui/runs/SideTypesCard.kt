package com.fenceestimator.app.ui.runs

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.label
import com.fenceestimator.app.ui.theme.Space

/**
 * WHAT KIND OF FENCE IS ON EACH SIDE -- on the screen he is already on when
 * he has finished drawing.
 *
 * His words: "after I create the drawing I need a spot to set what kind of
 * fence is on each side." He has just drawn three sides and wants to say "this
 * one is the 4 ft". Until now the only picker was on RunEditScreen, reached by
 * backing out of the drawing, finding the job screen, and tapping the side in
 * its fence-run list -- two navigations away from the thing he is looking at.
 *
 * A LIST OF SIDES WITH A DROPDOWN EACH, not a picker for the selected side.
 * The run picker above this already changes which side he is DRAWING on, and
 * a type control that followed that selection would mean four taps to set
 * four sides and a real chance of typing the wrong one -- the selection moves
 * the canvas under him, so the feedback for "did that land on the right side"
 * is a redraw rather than a row changing. Every side on one list, each row
 * naming itself, is one tap per answer and the answer is visible beside the
 * question.
 *
 * COLLAPSED TO ONE LINE BY DEFAULT. 12 of his 13 jobs are a single type
 * throughout (live, read-only, 2 Oct 2026), so on a normal day this is a
 * summary he never opens -- "3 sides - Vinyl" -- and costs one row of height
 * above a drawing canvas that wants all of it. It opens expanded when the job
 * is ALREADY mixed, because on that job the per-side answer is the thing worth
 * seeing.
 *
 * Every row goes through [SideTypesViewModel.setType], so the spacing follow,
 * the height carry and the RE-PRICE happen wherever the type is set. The
 * picker itself is the same composable RunEditScreen uses ([FenceTypeDropdown]).
 */
@Composable
fun SideTypesCard(
    jobId: Long,
    /**
     * Whether this phone may change the row at all -- the drawing screen's own
     * `editable`, passed in rather than recomputed, so this card and the
     * tools beside it can never disagree about who is holding the phone.
     */
    editable: Boolean,
    modifier: Modifier = Modifier.fillMaxWidth()
) {
    val app = currentApp()
    val viewModel: SideTypesViewModel = viewModel(
        key = "side_types_$jobId",
        factory = GenericViewModelFactory { SideTypesViewModel(app.repository, jobId, app.session) }
    )
    val runs by viewModel.runs.collectAsState()
    val lastResult by viewModel.lastResult.collectAsState()
    if (runs.isEmpty()) return

    val mixed = runs.map { it.fenceType }.distinct().size > 1
    // remember(mixed) and not remember(Unit): a job that becomes mixed while
    // this is on screen -- which is exactly what happens the moment he sets
    // the second side to something else -- should not then hide the list it
    // just helped him build.
    var expanded by remember(mixed) { mutableStateOf(mixed) }

    Card(modifier = modifier.padding(horizontal = Space.sm, vertical = Space.xs)) {
        Column(
            modifier = Modifier.padding(Space.card),
            verticalArrangement = Arrangement.spacedBy(Space.row)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        stringResource(R.string.sides_types_title),
                        style = MaterialTheme.typography.titleSmall
                    )
                    Text(
                        summaryLine(runs),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Icon(
                    if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = stringResource(
                        if (expanded) R.string.sides_types_collapse else R.string.sides_types_expand
                    )
                )
            }
            if (!expanded) return@Column

            runs.forEach { run ->
                SideTypeRow(run, editable) { newType -> viewModel.setType(run.id, newType) }
            }

            // The one outcome that has to be said out loud. Everything else is
            // the price quietly following, which is what he expects; this is
            // the price NOT following because his catalog has no rows for the
            // type he picked, and the alternative (leaving the old type's
            // lines) is a quote for a fence nobody is building.
            if (lastResult == com.fenceestimator.app.estimate.TakeoffRefresher
                    .TypeChangeResult.CLEARED_NOTHING_PRICED
            ) {
                Text(
                    stringResource(R.string.sides_types_nothing_priced),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error
                )
            }
        }
    }
}

/**
 * One side: what it is called, how it is spec'd, and what kind of fence it is.
 *
 * The teardown badge and the "(Vinyl)" in the name are deliberately NOT
 * repeated here -- the dropdown beside the label already says the type, and
 * the run picker above the card says it the other way. What this row adds is
 * the SPEC, because "this one is the 4 ft" is a height, and a type picker that
 * does not show the height it is about cannot answer the sentence he said.
 */
@Composable
private fun SideTypeRow(run: FenceRun, editable: Boolean, onSelect: (com.fenceestimator.app.data.FenceType) -> Unit) {
    val untitled = stringResource(R.string.misc_survey_untitled)
    Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                run.label.ifBlank { untitled } +
                    if (run.isTeardown) " · " + stringResource(R.string.draw_run_teardown_badge) else "",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f)
            )
        }
        FenceTypeDropdown(
            current = run.fenceType,
            editable = editable,
            label = run.label.ifBlank { untitled }
        ) { onSelect(it) }
        // "Not set yet", never a price built on a zero. RunTypeChange.specProblem
        // is the one place that decides whether a side can be priced honestly.
        val problem = RunTypeChange.specProblem(run)
        if (problem != null) {
            Text(
                stringResource(specProblemRes(problem)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error
            )
        } else {
            Text(
                specLine(run),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

private fun specProblemRes(problem: RunTypeChange.SpecProblem): Int = when (problem) {
    RunTypeChange.SpecProblem.POST_SPACING -> R.string.sides_spec_missing_post_spacing
    RunTypeChange.SpecProblem.PANEL_WIDTH -> R.string.sides_spec_missing_panel_width
    RunTypeChange.SpecProblem.PANEL_HEIGHT -> R.string.sides_spec_missing_panel_height
    RunTypeChange.SpecProblem.PICKET_PITCH -> R.string.sides_spec_missing_picket
    RunTypeChange.SpecProblem.RAIL_COUNT -> R.string.sides_spec_missing_rails
    RunTypeChange.SpecProblem.FABRIC_HEIGHT -> R.string.sides_spec_missing_fabric_height
}

/**
 * The height this side actually is, read from the column its OWN type uses.
 *
 * Chain link keeps its height in `fabricHeightFt` and every other type in
 * `panelHeightFt`. Showing `panelHeightFt` for all of them is how a chain-link
 * side reads "6 ft" on screen while the engine buys a 4 ft roll -- the exact
 * shape of the panel-height blindness already written up in
 * docs/PANEL_HEIGHT_BLINDNESS.md. [RunTypeChange.apply] keeps the two in step
 * on a type change; this reads whichever one is load-bearing so a side that
 * drifted anyway still SAYS what it will be priced at.
 */
@Composable
private fun specLine(run: FenceRun): String {
    val h = if (run.fenceType == com.fenceestimator.app.data.FenceType.CHAIN_LINK) {
        run.fabricHeightFt
    } else {
        run.panelHeightFt
    }
    return stringResource(R.string.sides_spec_height_ft, trimFt(h))
}

private fun trimFt(v: Float): String =
    if (v == v.toInt().toFloat()) v.toInt().toString() else String.format("%.1f", v)

/** "3 sides - Vinyl", or "3 sides - 2 Vinyl, 1 Wood" once it is mixed. */
@Composable
private fun summaryLine(runs: List<FenceRun>): String {
    val counts = runs.groupingBy { it.fenceType }.eachCount()
    val ordered = counts.entries.sortedByDescending { it.value }
    // Built with a for loop, not joinToString.
    //
    // FenceType.label() is @Composable (EnumLabels.kt:132 -- it reads a string
    // resource), and Compose refuses a composable call from inside an ordinary
    // lambda like joinToString's. A `for` body IS composable scope, so the label
    // is read there and only plain strings are joined afterwards. Written this
    // way on purpose: making label() non-composable instead would mean building
    // these names without the locale, and this card is one of the few places the
    // three fence-type names appear together.
    val parts = ArrayList<String>(ordered.size)
    for (entry in ordered) parts.add("${entry.value} ${entry.key.label()}")
    val body = if (ordered.size == 1) ordered.first().key.label() else parts.joinToString(", ")
    return stringResource(R.string.sides_types_summary, runs.size, body)
}

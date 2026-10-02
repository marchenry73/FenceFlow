package com.fenceestimator.app.ui.crew

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.ui.components.EmptyState
import com.fenceestimator.app.ui.components.FencePlanCanvas
import com.fenceestimator.app.ui.components.FencePlanLegend
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.label
import com.fenceestimator.app.ui.theme.Space

/**
 * The page the person at the supply counter works from.
 *
 * In the owner's words: "when picking up materials, I want to have the whole
 * process too for the person picking up. I want them to have a whole page to
 * check if we have everything according to the job. It would show the grid and
 * the drawing and how many post there needs and what type of post."
 *
 * In the order a counter is actually worked:
 *
 *  1. Which job and where, exactly as much as the app already shows a crew
 *     member -- [CrewJobScreen] prints `job.address` plainly and offers a
 *     "search nearby" button on it, so the address is not a new disclosure and
 *     this does not loosen it. No phone number and no email, because no other
 *     crew-facing screen shows those and a pull sheet has no use for them.
 *  2. The drawing, with every side labelled, so the shape being bought for is
 *     visible. Drawn by the SHARED renderer
 *     ([com.fenceestimator.app.ui.components.FencePlanCanvas]) that the crew
 *     plan screen uses, not a second one.
 *  3. Posts, broken out by type, each with its product (whose name carries the
 *     post's length) and the fence height it is for.
 *  4. Everything else, grouped the way a yard is picked.
 *  5. A tick per line that survives the phone sleeping, with no signal.
 *
 * NO MONEY, ANYWHERE. Not conditionally -- structurally. See [PullSheetLogic]
 * for the three layers and for why this screen has no MoneyScope gate on it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PullSheetScreen(jobId: Long, onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: PullSheetViewModel = viewModel(
        key = "pull_sheet_$jobId",
        factory = GenericViewModelFactory { PullSheetViewModel(app.repository, jobId, app) }
    )
    val job by viewModel.job.collectAsState()
    val runs by viewModel.runs.collectAsState()
    val markers by viewModel.siteMarkers.collectAsState()
    val sheet by viewModel.sheet.collectAsState()
    val ticked by viewModel.ticked.collectAsState()
    val notes by viewModel.notes.collectAsState()
    var noteFor by remember { mutableStateOf<PullSheetLine?>(null) }

    val topBar: @Composable () -> Unit = {
        TopAppBar(
            title = { Text(stringResource(R.string.pull_sheet_title)) },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.pull_sheet_back))
                }
            }
        )
    }

    // A job not yet on this phone and a job that never arrives look the same
    // to `job ?: return`. Same wait-then-say-so the plan screen uses.
    if (job == null) {
        val loadTimedOut = com.fenceestimator.app.ui.components.rememberLoadTimedOut()
        Scaffold(topBar = topBar) { padding ->
            com.fenceestimator.app.ui.components.LoadingOrMissing(
                stillLoading = !loadTimedOut,
                notFoundText = stringResource(R.string.pull_sheet_not_on_phone),
                modifier = Modifier.padding(padding)
            )
        }
        return
    }
    val currentJob = job!!

    Scaffold(topBar = topBar) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(Space.screen),
            verticalArrangement = Arrangement.spacedBy(Space.section)
        ) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
                    Text(
                        currentJob.customerName.ifBlank { stringResource(R.string.pull_sheet_untitled_job) },
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold
                    )
                    if (currentJob.address.isNotBlank()) {
                        Text(currentJob.address, style = MaterialTheme.typography.bodyMedium)
                    }
                    Text(
                        stringResource(R.string.pull_sheet_no_money_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            // The drawing: fence to BUILD only. You are not buying for a fence
            // being taken out, so a teardown run has no place on a pull sheet
            // even as a picture -- it would read as more shape to buy for.
            val drawn = viewModel.drawableRuns(runs)
            if (drawn.isNotEmpty()) {
                item {
                    Text(
                        stringResource(R.string.pull_sheet_drawing_heading),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                }
                // Side lengths are labelled ONLY on runs whose own takeoff lines
                // are on this sheet, which is what PullSheetState.Ready's
                // runIdsOnSheet exists for. Everything else is drawn as an
                // unlabelled shape.
                //
                // This read `labelSegments = true` -- a parameter that does not
                // exist, so the build would not compile; and had it existed, it
                // would have printed a dimension on every run including ones
                // that cannot be measured, where the scale falls back to a
                // guessed 20 px/ft. A figure in feet beside a shape is a figure
                // somebody buys panels against, so an unmeasured run gets a
                // shape and no number. The shape still earns its place: it is
                // how the person at the counter recognises the yard.
                item {
                    FencePlanCanvas(
                        currentJob, drawn, markers,
                        labelLengthsForRunIds = (sheet as? PullSheetState.Ready)?.runIdsOnSheet ?: emptySet(),
                    )
                }
                item { FencePlanLegend(drawn, markers) }
            }

            when (val state = sheet) {
                PullSheetState.NoRuns -> item {
                    EmptyState(stringResource(R.string.pull_sheet_empty_no_runs))
                }

                PullSheetState.OnlyTeardown -> item {
                    LoudCard(stringResource(R.string.pull_sheet_empty_only_teardown))
                }

                is PullSheetState.NoTakeoff -> item {
                    // THE WORST OUTCOME THIS PAGE COULD PRODUCE is an empty
                    // sheet that reads as a short shopping list. So this is a
                    // loud card that says the takeoff has not been run, not a
                    // blank section, and it names the runs so it is obvious
                    // this is about THIS job.
                    LoudCard(
                        stringResource(
                            R.string.pull_sheet_empty_no_takeoff,
                            state.runLabels.joinToString(", ") { it.ifBlank { "-" } }
                        )
                    )
                }

                is PullSheetState.NotMeasurable -> item {
                    LoudCard(
                        stringResource(
                            R.string.pull_sheet_empty_not_measurable,
                            state.runLabels.joinToString(", ") { it.ifBlank { "-" } }
                        )
                    )
                }

                is PullSheetState.Ready -> {
                    // A PARTIAL sheet is the dangerous one: four runs, one
                    // priced, and a page that looks finished. Said first, in
                    // the loud card, before anything is loaded.
                    if (state.runsWithoutTakeoff.isNotEmpty()) {
                        item {
                            LoudCard(
                                stringResource(
                                    R.string.pull_sheet_partial,
                                    state.runsWithoutTakeoff.joinToString(", ") { it.ifBlank { "-" } }
                                )
                            )
                        }
                    }
                    if (state.runsNotMeasurable.isNotEmpty()) {
                        item {
                            LoudCard(
                                stringResource(
                                    R.string.pull_sheet_partial_not_measurable,
                                    state.runsNotMeasurable.joinToString(", ") { it.ifBlank { "-" } }
                                )
                            )
                        }
                    }

                    val allLines = state.groups.flatMap { it.lines }
                    item {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                stringResource(
                                    R.string.pull_sheet_loaded_count,
                                    allLines.count { ticked.contains(it.key) },
                                    allLines.size
                                ),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold
                            )
                            TextButton(onClick = { viewModel.clearTicks() }) {
                                Text(stringResource(R.string.pull_sheet_start_over))
                            }
                        }
                    }
                    item {
                        Text(
                            stringResource(R.string.pull_sheet_total_posts, fmt(state.totalPosts)),
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                    if (state.hadTeardownRuns) {
                        item {
                            Text(
                                stringResource(R.string.pull_sheet_teardown_excluded),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }

                    state.groups.forEach { group ->
                        item {
                            Text(
                                stringResource(sectionHeadingRes(group.section)),
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Bold
                            )
                        }
                        items(group.lines.size) { index ->
                            val line = group.lines[index]
                            LineRow(
                                line = line,
                                isTicked = ticked.contains(line.key),
                                note = notes[line.key].orEmpty(),
                                onTick = { viewModel.setTicked(line.key, it) },
                                onNote = { noteFor = line }
                            )
                        }
                    }

                    item {
                        Text(
                            stringResource(R.string.pull_sheet_ticks_local_only),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }

    noteFor?.let { line ->
        SubstitutionDialog(
            initial = notes[line.key].orEmpty(),
            onDismiss = { noteFor = null },
            onSave = { text ->
                viewModel.setSubstitution(line.key, text)
                noteFor = null
            }
        )
    }
}

/** One thing to load: tick it, read it, and see what to ask about it. */
@Composable
private fun LineRow(
    line: PullSheetLine,
    isTicked: Boolean,
    note: String,
    onTick: (Boolean) -> Unit,
    onNote: () -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Row(
            Modifier.padding(Space.md),
            verticalAlignment = Alignment.Top
        ) {
            Checkbox(checked = isTicked, onCheckedChange = onTick)
            Column(
                Modifier.padding(start = Space.sm),
                verticalArrangement = Arrangement.spacedBy(Space.xs)
            ) {
                Text(
                    stringResource(R.string.pull_sheet_qty_line, fmt(line.quantity), line.unit, line.role.label()),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    // Struck through once loaded, so a glance down the page
                    // separates what is on the truck from what is not without
                    // reading every checkbox.
                    textDecoration = if (isTicked) TextDecoration.LineThrough else null
                )
                Text(line.product, style = MaterialTheme.typography.bodyMedium)

                line.fenceHeightFt?.let { height ->
                    Text(
                        stringResource(R.string.pull_sheet_for_fence_height, fmt(height.toDouble())),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (line.runLabels.isNotEmpty()) {
                    Text(
                        stringResource(R.string.pull_sheet_for_runs, line.runLabels.joinToString(", ")),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (line.handAdded) {
                    Text(
                        stringResource(R.string.pull_sheet_hand_added),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                if (line.heightNotDeclared && line.doubts.isEmpty()) {
                    Text(
                        stringResource(R.string.pull_sheet_no_height_declared),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                // ASK, do not guess. The count is right either way; what may be
                // wrong is which product it is a count OF.
                line.doubts.forEach { doubt ->
                    Text(
                        when (doubt) {
                            PullSheetDoubt.NOT_IN_CATALOG ->
                                stringResource(R.string.pull_sheet_doubt_not_in_catalog)
                            PullSheetDoubt.FILING_UNCHECKED ->
                                stringResource(R.string.pull_sheet_doubt_filing)
                            PullSheetDoubt.WRONG_HEIGHT -> stringResource(
                                R.string.pull_sheet_doubt_wrong_height,
                                fmt((line.catalogHeightFt ?: 0f).toDouble()),
                                fmt((line.fenceHeightFt ?: 0f).toDouble())
                            )
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.error
                    )
                }

                if (note.isNotBlank()) {
                    Text(
                        stringResource(R.string.pull_sheet_substitution_shown, note),
                        style = MaterialTheme.typography.bodySmall,
                        fontWeight = FontWeight.Medium
                    )
                }
                OutlinedButton(onClick = onNote) {
                    Text(
                        stringResource(
                            if (note.isBlank()) R.string.pull_sheet_substitution_add
                            else R.string.pull_sheet_substitution_edit
                        )
                    )
                }
            }
        }
    }
}

/**
 * Noting what was taken instead -- a note, never an edit.
 *
 * The quantity and the product on the line do not move. The line is what the
 * estimate, the post count and the price the customer agreed were all built
 * from, so a supply counter rewriting it is a job quietly ceasing to match
 * what was signed. The dialog says out loud that the note stays on the phone,
 * rather than implying the office will see it, because there is no column
 * anywhere for it to travel in.
 */
@Composable
private fun SubstitutionDialog(initial: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var text by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.pull_sheet_substitution_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Text(
                    stringResource(R.string.pull_sheet_substitution_local_only),
                    style = MaterialTheme.typography.bodySmall
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text(stringResource(R.string.pull_sheet_substitution_hint)) },
                    modifier = Modifier.fillMaxWidth()
                )
            }
        },
        confirmButton = {
            TextButton(onClick = { onSave(text) }) {
                Text(stringResource(R.string.pull_sheet_substitution_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.pull_sheet_substitution_cancel))
            }
        }
    )
}

/**
 * Something that must not be mistaken for a detail.
 *
 * The error container, deliberately, not a grey caption: every message that
 * uses this one says the sheet is not the whole job, and a caption at a supply
 * counter is a caption nobody reads.
 */
@Composable
private fun LoudCard(text: String) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Text(
            text,
            modifier = Modifier.padding(Space.card),
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onErrorContainer
        )
    }
}

private fun sectionHeadingRes(section: PullSheetSection): Int = when (section) {
    PullSheetSection.POSTS -> R.string.pull_sheet_section_posts
    PullSheetSection.PANELS -> R.string.pull_sheet_section_panels
    PullSheetSection.CAPS_AND_TRIM -> R.string.pull_sheet_section_caps
    PullSheetSection.CONCRETE -> R.string.pull_sheet_section_concrete
    PullSheetSection.GATE_HARDWARE -> R.string.pull_sheet_section_gates
    PullSheetSection.OTHER -> R.string.pull_sheet_section_other
}

/**
 * A count a person reads. Whole where it is whole -- "22", not "22.0" -- and
 * one decimal otherwise, because a yard sells whole bags and whole posts and a
 * fractional foot of fabric is still a real number.
 */
private fun fmt(value: Double): String =
    if (kotlin.math.abs(value - Math.round(value)) < 0.005) Math.round(value).toString()
    else "%.1f".format(value)

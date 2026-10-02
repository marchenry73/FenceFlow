package com.fenceestimator.app.ui.runs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.data.AluminumStyle
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.WoodStyle
import com.fenceestimator.app.ui.components.DraftNumberField
import com.fenceestimator.app.ui.components.DraftTextField
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.label
// A65: the number guards and the sentence for each refusal live with the
// drawing screen's view model rather than being copied here, so the gate
// width dialog and these spec fields cannot drift about what counts as a
// usable measurement. They are pure functions in a companion object -- no
// repository, no Context -- which is also what lets plain node check them
// (tests/a65-run-selection-and-input-guards.test.mjs).
import com.fenceestimator.app.ui.survey.SurveyViewModel
import com.fenceestimator.app.ui.survey.numberRefusalMessage
import com.fenceestimator.app.ui.theme.Space

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunEditScreen(
    runId: Long,
    onBack: () -> Unit,
    onDeleted: () -> Unit,
    /**
     * Opens the drawing on a particular run: (jobId, runId).
     *
     * The run id is the fix for A65 finding 1. This used to be `(Long) ->
     * Unit` taking the JOB id alone, so the drawing screen had no way to know
     * which side the person had been looking at and fell back to the job's
     * first run -- and every corner they then placed went onto that run's
     * polyline instead. Both ids are passed because the route needs both; the
     * drawing screen is per-job and the selection is per-run.
     */
    onDrawRun: (Long, Long) -> Unit
) {
    val app = currentApp()
    // This screen never read the session at all, which is how its delete button
    // came to be the one delete in the app with no permission behind it.
    val session by app.session.state.collectAsState()
    // Every field below wrote straight to the run with nothing asking a
    // permission, the same hole the delete button had. isGuestDemo rather than
    // canEditJobs on purpose: this table lets any company member write, and a
    // real crew phone reaches this screen from the job's own fence-run list to
    // size runs and fix specs on site, the same way drawing one is deliberately
    // open to them. Only the guest demo -- signed out, no company to actually
    // hold this write -- loses it.
    val editable = !session.isGuestDemo
    var pendingDelete by remember { mutableStateOf(false) }
    val viewModel: RunEditViewModel = viewModel(
        key = "run_edit_$runId",
        factory = GenericViewModelFactory { RunEditViewModel(app.repository, runId, app.session) }
    )
    val run by viewModel.run.collectAsState()
    // `run ?: return` used to show the same bare back arrow whether the run
    // was still loading or had never made it to this phone. Waits out a slow
    // cold start before calling it missing, same treatment as the other
    // screens that key off a single record.
    if (run == null) {
        val loadTimedOut = com.fenceestimator.app.ui.components.rememberLoadTimedOut()
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(stringResource(R.string.est2_fence_run_title)) },
                    navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
                )
            }
        ) { padding ->
            com.fenceestimator.app.ui.components.LoadingOrMissing(
                stillLoading = !loadTimedOut,
                notFoundText = stringResource(R.string.misc_run_not_on_phone),
                modifier = Modifier.padding(padding)
            )
        }
        return
    }
    val currentRun = run!!

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(currentRun.label.ifBlank { stringResource(R.string.est2_fence_run_title) }) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(padding),
            contentPadding = PaddingValues(Space.screen),
            verticalArrangement = Arrangement.spacedBy(Space.section)
        ) {
            item {
                // The natural next step after naming a run is drawing it. Without
                // this you had to back out to the job and find the survey screen,
                // which broke the flow every single time.
                //
                // Left reachable for a guest on purpose, not hidden behind
                // `editable` the way the fields below are. The drawing screen
                // this leads to has its own guest check now (SurveyDrawScreen,
                // SurveyViewModel) and renders read-only rather than refusing
                // entry -- a visitor can still look at a sample job's fence
                // line, its gates and its markers, exactly the "see
                // everything" half of the rule. Gating the button too would
                // only have routed a guest away from a screen that is now
                // actually safe to open.
                val hasLine = currentRun.pointsEncoded.isNotBlank()
                androidx.compose.material3.Button(
                    // currentRun.id, not just its jobId: this button is ON a
                    // run's own screen, so "this fence" is never ambiguous
                    // here -- it was only ambiguous by the time the drawing
                    // screen opened, because the run id was dropped on the way.
                    onClick = { onDrawRun(currentRun.jobId, currentRun.id) },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Filled.Edit, contentDescription = null)
                    Text("  " + stringResource(if (hasLine) R.string.est2_edit_drawing else R.string.est2_next_draw_fence))
                }
                if (!hasLine) {
                    Text(
                        stringResource(R.string.est2_set_type_first),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item {
                SectionCard(stringResource(R.string.est2_section_run)) {
                    DraftTextField(
                        stableKey = currentRun.id, initialValue = currentRun.label,
                        label = stringResource(R.string.est2_run_label_hint), enabled = editable, modifier = Modifier.fillMaxWidth()
                    ) { viewModel.update { r -> r.copy(label = it) } }
                    FenceTypeDropdown(currentRun.fenceType, editable) { newType ->
                        viewModel.update { r ->
                            r.copy(
                                fenceType = newType,
                                postSpacingFt = FenceRunListViewModel.defaultSpacingFor(newType, r.panelWidthFt, r.postSpacingFt)
                            )
                        }
                    }
                    DraftTextField(
                        stableKey = currentRun.id, initialValue = currentRun.colorOrFinish,
                        label = stringResource(R.string.est2_color_finish), enabled = editable, modifier = Modifier.fillMaxWidth()
                    ) { viewModel.update { r -> r.copy(colorOrFinish = it) } }
                    // The field existed in the data model and synced to every
                    // phone -- and nothing anywhere let a person SET it. So the
                    // first time somebody drew their customer's old fence, every
                    // board of it was billed as new fence to build: quantities
                    // jumped by the old fence's whole takeoff and the estimate
                    // looked possessed.
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(stringResource(R.string.est2_is_teardown))
                            Text(
                                stringResource(R.string.est2_is_teardown_hint),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(
                            checked = currentRun.isTeardown,
                            enabled = editable,
                            onCheckedChange = { checked ->
                                viewModel.update { r -> r.copy(isTeardown = checked) }
                            }
                        )
                    }
                }
            }
            item {
                when (currentRun.fenceType) {
                    FenceType.VINYL -> SectionCard(stringResource(R.string.est2_spec_vinyl)) { VinylFields(currentRun, editable, viewModel) }
                    FenceType.ALUMINUM -> SectionCard(stringResource(R.string.est2_spec_aluminum)) { AluminumFields(currentRun, editable, viewModel) }
                    FenceType.ORNAMENTAL_IRON -> SectionCard(stringResource(R.string.est2_spec_ornamental_iron)) { VinylFields(currentRun, editable, viewModel) }
                    FenceType.WOOD -> SectionCard(stringResource(R.string.est2_spec_wood)) { WoodFields(currentRun, editable, viewModel) }
                    FenceType.COMPOSITE -> SectionCard(stringResource(R.string.est2_spec_composite)) { WoodFields(currentRun, editable, viewModel) }
                    FenceType.SPLIT_RAIL -> SectionCard(stringResource(R.string.est2_spec_split_rail)) { SplitRailFields(currentRun, editable, viewModel) }
                    FenceType.CHAIN_LINK -> SectionCard(stringResource(R.string.est2_spec_chain_link)) { ChainLinkFields(currentRun, editable, viewModel) }
                    FenceType.UNIVERSAL -> {}
                }
            }
            item {
                SectionCard(stringResource(R.string.est2_section_posts_concrete)) {
                    val locked = currentRun.fenceType == FenceType.VINYL || currentRun.fenceType == FenceType.ALUMINUM || currentRun.fenceType == FenceType.ORNAMENTAL_IRON
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.row)) {
                        // Post spacing divides the footage to get the post
                        // count. Zero or non-finite is not a wide fence, it is
                        // a fence with no posts priced on it at all.
                        PositiveNumberField(
                            stableKey = currentRun.id,
                            label = stringResource(R.string.est2_post_spacing_ft),
                            initialValue = currentRun.postSpacingFt,
                            enabled = editable && !locked,
                            modifier = Modifier.weight(1f)
                        ) { viewModel.update { r -> r.copy(postSpacingFt = it) } }
                        // Zero bags is a real answer: a wall-hung gate post
                        // takes none. Negative and non-finite are not.
                        NonNegativeNumberField(
                            stableKey = currentRun.id,
                            label = stringResource(R.string.est2_concrete_bags_per_post),
                            initialValue = currentRun.concreteBagsPerPost,
                            enabled = editable,
                            modifier = Modifier.weight(1f)
                        ) { viewModel.update { r -> r.copy(concreteBagsPerPost = it) } }
                    }
                    if (locked) {
                        Text(
                            stringResource(R.string.est2_post_spacing_follows_panel),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
            // Only someone who may delete records sees it at all.
            //
            // It was ungated, and reachable: crew accounts open the job screen,
            // its fence-run list is not gated, and every row leads here. So a
            // crew phone could delete the fence line, its gates and the takeoff
            // priced from it -- the one delete in this app with nothing behind
            // it, while the four beside it on the job screen all ask
            // session.canDelete.
            //
            // A server trigger does refuse the tombstone without the delete
            // permission -- confirmed live, not assumed -- but that is not a
            // substitute for this gate, for a different reason than "nothing
            // stops it": the repository writes the pending-deletion record and
            // deletes this phone's local copy of the run in the same call,
            // before the server ever gets a chance to say no, and the priced
            // lines under the run cascade with it locally. So a phone without
            // this gate loses the run and its takeoff on itself regardless of
            // what the cloud row does afterward. The app-side check is what
            // stops the loss from happening at all, not the server's refusal
            // of a write that already cost the phone its own copy.
            //
            // Hidden rather than disabled, the same way the job screen hides its
            // own: a greyed-out delete invites a crew member to ask the office to
            // enable something they should not be doing.
            if (session.canDelete) item {
                // Asked, not assumed.
                //
                // This button used to delete the run the instant it was
                // touched -- no dialog, no undo -- while deleting the JOB
                // that contains it asks you to type the customer's name.
                // The run is where the drawing lives: the fence line, every
                // gate on it, and the takeoff priced from it. Losing that to
                // one mis-tap in a truck is the exact accident this product
                // is supposed to make impossible.
                OutlinedButton(
                    onClick = { pendingDelete = true },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Filled.Delete, contentDescription = null)
                    Text("  " + stringResource(R.string.est2_delete_this_run))
                }
            }
        }
    }
    // The gate is repeated on the dialog rather than trusted to the button that
    // sets the flag. A permission read once at the top of a screen and acted on
    // further down is a permission that survives the screen being recomposed
    // with a different session -- a sign-out, a role change pushed down mid-use.
    if (pendingDelete && session.canDelete) {
        val name = currentRun.label.takeIf { it.isNotBlank() }
            ?: stringResource(R.string.run_untitled)
        AlertDialog(
            onDismissRequest = { pendingDelete = false },
            title = { Text(stringResource(R.string.run_delete_title)) },
            text = { Text(stringResource(R.string.run_delete_body, name)) },
            confirmButton = {
                // Red is spent only on the button that cannot be undone --
                // the same rule the job list follows, so the colour keeps
                // meaning one thing across the app.
                Button(
                    onClick = { pendingDelete = false; viewModel.delete(onDeleted) },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError
                    )
                ) { Text(stringResource(R.string.action_delete)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { pendingDelete = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            }
        )
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.row)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FenceTypeDropdown(current: FenceType, editable: Boolean, onSelect: (FenceType) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { if (editable) expanded = it }) {
        OutlinedTextField(
            value = current.label(), onValueChange = {}, readOnly = true,
            enabled = editable,
            label = { Text(stringResource(R.string.est2_fence_type)) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            FenceType.values().filter { it != FenceType.UNIVERSAL }.forEach { type ->
                DropdownMenuItem(
                    text = { Text(type.label()) },
                    onClick = { onSelect(type); expanded = false }
                )
            }
        }
    }
}

/**
 * A spec number that a fence cannot have at zero, negative or non-finite:
 * panel width, panel height, post spacing, picket width, fabric height.
 *
 * WHY THIS WRAPPER EXISTS (A65 finding 2). These boxes write straight to the
 * run on every keystroke, and [DraftNumberField] pushes `0f` for a blank box
 * by a deliberate decision made for a different field -- a markup percentage
 * wiped out to leave it at nothing used to stay at 15%, and the blank box
 * said otherwise. Right for a markup, wrong here: clearing the panel-width
 * box committed 0, and a panel width of zero takes the panel and line-post
 * lines out of a vinyl, aluminium or ornamental quote. The person was not
 * editing a number, they were halfway through replacing it.
 *
 * So [DraftNumberField] is left exactly as it is -- narrowing the shared
 * field would change every screen that uses it, including the markup it was
 * written for -- and the refusal is applied here, at the call site that needs
 * it. The last good value is KEPT: nothing is written, the run still has the
 * size it had, and the field says so. Blurring the box restores the stored
 * number on screen too, because DraftNumberField re-seeds an unfocused field
 * whose upstream value no longer matches what it last pushed.
 *
 * BLANK and a typed 0 are indistinguishable by the time they reach here, and
 * both are refused, so nothing is lost by not telling them apart -- the
 * message is [SurveyViewModel.NumberRefusal.NOT_POSITIVE] either way.
 */
@Composable
private fun PositiveNumberField(
    stableKey: Any,
    label: String,
    initialValue: Float,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onAccepted: (Float) -> Unit
) {
    var refusal by remember(stableKey) {
        mutableStateOf<SurveyViewModel.NumberRefusal?>(null)
    }
    Column(modifier) {
        DraftNumberField(
            stableKey = stableKey,
            label = label,
            initialValue = initialValue,
            enabled = enabled,
            modifier = Modifier.fillMaxWidth()
        ) { value ->
            val problem = SurveyViewModel.checkPositive(value)
            refusal = problem
            if (problem == null) onAccepted(value)
        }
        refusal?.let { problem ->
            Text(
                stringResource(numberRefusalMessage(problem)) + " " +
                    stringResource(R.string.num_kept_last_good, formatSpecValue(initialValue)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error
            )
        }
    }
}

/**
 * [PositiveNumberField] for a count that is stored as an Int and must be at
 * least 1: wood rail count, rails per split-rail section.
 *
 * Its own wrapper because `it.toInt()` is where these went wrong in a way a
 * Float field does not: `Float.NaN.toInt()` is 0, which `coerceAtLeast(1)`
 * then quietly turned into 1 (a silently wrong answer rather than a refused
 * one), and `Float.POSITIVE_INFINITY.toInt()` is Int.MAX_VALUE, which
 * `coerceAtLeast(1)` happily passes through as a rail count of two billion.
 */
@Composable
private fun PositiveCountField(
    stableKey: Any,
    label: String,
    initialValue: Int,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onAccepted: (Int) -> Unit
) {
    PositiveNumberField(
        stableKey = stableKey,
        label = label,
        initialValue = initialValue.toFloat(),
        enabled = enabled,
        modifier = modifier
    ) { value -> onAccepted(value.toInt().coerceAtLeast(1)) }
}

/**
 * [PositiveNumberField] for a number where zero IS a real answer: concrete
 * bags per post (a wall-hung gate takes none) and picket gap (a privacy fence
 * has none). Only a negative or non-finite entry is refused.
 */
@Composable
private fun NonNegativeNumberField(
    stableKey: Any,
    label: String,
    initialValue: Float,
    enabled: Boolean,
    modifier: Modifier = Modifier,
    onAccepted: (Float) -> Unit
) {
    var refusal by remember(stableKey) {
        mutableStateOf<SurveyViewModel.NumberRefusal?>(null)
    }
    Column(modifier) {
        DraftNumberField(
            stableKey = stableKey,
            label = label,
            initialValue = initialValue,
            enabled = enabled,
            modifier = Modifier.fillMaxWidth()
        ) { value ->
            val problem = SurveyViewModel.checkNonNegative(value)
            refusal = problem
            if (problem == null) onAccepted(value)
        }
        refusal?.let { problem ->
            Text(
                stringResource(numberRefusalMessage(problem)) + " " +
                    stringResource(R.string.num_kept_last_good, formatSpecValue(initialValue)),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error
            )
        }
    }
}

/** The stored value as the field itself would show it, for "still using X". */
private fun formatSpecValue(value: Float): String =
    if (value.isFinite() && value % 1f == 0f) value.toInt().toString() else value.toString()

@Composable
private fun VinylFields(run: FenceRun, editable: Boolean, viewModel: RunEditViewModel) {
    Row(horizontalArrangement = Arrangement.spacedBy(Space.row)) {
        PositiveNumberField(stableKey = run.id, label = stringResource(R.string.est2_panel_width_ft), initialValue = run.panelWidthFt, enabled = editable, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelWidthFt = it, postSpacingFt = it) }
        }
        PositiveNumberField(stableKey = run.id, label = stringResource(R.string.est2_panel_height_ft), initialValue = run.panelHeightFt, enabled = editable, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelHeightFt = it) }
        }
    }
}

@Composable
private fun AluminumFields(run: FenceRun, editable: Boolean, viewModel: RunEditViewModel) {
    Row(horizontalArrangement = Arrangement.spacedBy(Space.row)) {
        PositiveNumberField(stableKey = run.id, label = stringResource(R.string.est2_panel_width_ft), initialValue = run.panelWidthFt, enabled = editable, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelWidthFt = it, postSpacingFt = it) }
        }
        PositiveNumberField(stableKey = run.id, label = stringResource(R.string.est2_panel_height_ft), initialValue = run.panelHeightFt, enabled = editable, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(panelHeightFt = it) }
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.est2_rackable), modifier = Modifier.weight(1f))
        Switch(
            checked = run.aluminumStyle == AluminumStyle.RACKABLE,
            enabled = editable,
            onCheckedChange = { checked ->
                viewModel.update { r -> r.copy(aluminumStyle = if (checked) AluminumStyle.RACKABLE else AluminumStyle.FLAT_TOP) }
            }
        )
    }
}

@Composable
private fun WoodFields(run: FenceRun, editable: Boolean, viewModel: RunEditViewModel) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(stringResource(R.string.est2_spaced_picket), modifier = Modifier.weight(1f))
        Switch(
            checked = run.woodStyle == WoodStyle.SPACED_PICKET,
            enabled = editable,
            onCheckedChange = { checked ->
                viewModel.update { r ->
                    r.copy(
                        woodStyle = if (checked) WoodStyle.SPACED_PICKET else WoodStyle.PRIVACY,
                        picketGapIn = if (checked) r.picketGapIn.takeIf { it > 0f } ?: 2f else 0f
                    )
                }
            }
        )
    }
    Row(horizontalArrangement = Arrangement.spacedBy(Space.row)) {
        PositiveNumberField(stableKey = run.id, label = stringResource(R.string.est2_fence_height_ft), initialValue = run.panelHeightFt, enabled = editable, modifier = Modifier.weight(1f)) { newHeight ->
            viewModel.update { r ->
                r.copy(panelHeightFt = newHeight, woodRailCount = if (newHeight > 4f) 3 else 2)
            }
        }
        PositiveCountField(stableKey = run.id, label = stringResource(R.string.est2_rail_count), initialValue = run.woodRailCount, enabled = editable, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(woodRailCount = it) }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(Space.row)) {
        PositiveNumberField(stableKey = run.id, label = stringResource(R.string.est2_picket_width_in), initialValue = run.picketWidthIn, enabled = editable, modifier = Modifier.weight(1f)) {
            viewModel.update { r -> r.copy(picketWidthIn = it) }
        }
        if (run.woodStyle == WoodStyle.SPACED_PICKET) {
            // Zero is a real answer here and only here in this row: a privacy
            // fence has no gap between pickets. Only negative and non-finite
            // are refused.
            NonNegativeNumberField(stableKey = run.id, label = stringResource(R.string.est2_picket_gap_in), initialValue = run.picketGapIn, enabled = editable, modifier = Modifier.weight(1f)) {
                viewModel.update { r -> r.copy(picketGapIn = it) }
            }
        }
    }
}

@Composable
private fun ChainLinkFields(run: FenceRun, editable: Boolean, viewModel: RunEditViewModel) {
    PositiveNumberField(stableKey = run.id, label = stringResource(R.string.est2_fabric_height_ft), initialValue = run.fabricHeightFt, enabled = editable, modifier = Modifier.fillMaxWidth()) {
        viewModel.update { r -> r.copy(fabricHeightFt = it) }
    }
    ToggleRow(stringResource(R.string.est2_include_top_rail), run.includeTopRail, editable) { viewModel.update { r -> r.copy(includeTopRail = it) } }
    ToggleRow(stringResource(R.string.est2_include_tension_wire), run.includeTensionWire, editable) { viewModel.update { r -> r.copy(includeTensionWire = it) } }
    ToggleRow(stringResource(R.string.est2_barbed_wire_arms), run.includeBarbedWireArms, editable) { viewModel.update { r -> r.copy(includeBarbedWireArms = it) } }
    ToggleRow(stringResource(R.string.est2_privacy_slats), run.includePrivacySlats, editable) { viewModel.update { r -> r.copy(includePrivacySlats = it) } }
}

@Composable
private fun SplitRailFields(run: FenceRun, editable: Boolean, viewModel: RunEditViewModel) {
    PositiveCountField(stableKey = run.id, label = stringResource(R.string.est2_rails_per_section), initialValue = run.splitRailCount, enabled = editable, modifier = Modifier.fillMaxWidth()) {
        viewModel.update { r -> r.copy(splitRailCount = it) }
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, enabled = enabled, onCheckedChange = onChange)
    }
}


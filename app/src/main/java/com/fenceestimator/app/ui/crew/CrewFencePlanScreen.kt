package com.fenceestimator.app.ui.crew

import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import kotlinx.coroutines.launch
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.SiteMarker
import com.fenceestimator.app.estimate.PlanExtent
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.ui.components.EmptyState
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.label
import com.fenceestimator.app.ui.survey.SurveyViewModel
import com.fenceestimator.app.ui.theme.Space

/**
 * The fence plan as the crew needs it: what to build and where, with nothing
 * they can accidentally change.
 *
 * The crew used to be sent to the full drawing screen, where a stray tap moves
 * a corner or drops a new point -- and the drawing is what the estimate, the
 * post count and the material order were all built from. Reading it and editing
 * it are different jobs, so this is a separate screen with no edit tools at all.
 * Prices are absent by design; the crew's own pay lives on the job screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CrewFencePlanScreen(jobId: Long, onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: SurveyViewModel = viewModel(
        key = "crew_plan_$jobId",
        // Read-only, so never re-pricing. This screen builds the drawing's
        // view model only to read the drawing, and its init used to start the
        // takeoff refresh on the crew's phone -- whose catalog has every price
        // scrubbed, so it picked different products and pushed its own
        // quantities over the office's on every sync.
        factory = GenericViewModelFactory {
            SurveyViewModel(app.repository, jobId, app, repriceOnDrawingChange = false)
        }
    )
    val job by viewModel.job.collectAsState()
    val runs by viewModel.runs.collectAsState()
    val markers by viewModel.siteMarkers.collectAsState()
    val topBar: @Composable () -> Unit = {
        TopAppBar(
            title = { Text(stringResource(R.string.crew_fence_plan)) },
            navigationIcon = {
                IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
            }
        )
    }
    // A job not yet in the local database and a job that never arrives look
    // the same to `job ?: return` -- a bare back arrow, no clue which one it
    // is. This waits out a slow cold start before calling it missing.
    if (job == null) {
        val loadTimedOut = com.fenceestimator.app.ui.components.rememberLoadTimedOut()
        Scaffold(topBar = topBar) { padding ->
            com.fenceestimator.app.ui.components.LoadingOrMissing(
                stillLoading = !loadTimedOut,
                notFoundText = stringResource(R.string.misc_crew_plan_not_on_phone),
                modifier = Modifier.padding(padding)
            )
        }
        return
    }
    val currentJob = job!!

    Scaffold(
        topBar = topBar
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(Space.screen),
            verticalArrangement = Arrangement.spacedBy(Space.section)
        ) {
            item {
                Text(
                    stringResource(R.string.crew_plan_read_only),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Asking, rather than changing it and telling them afterwards.
            //
            // The crew standing at the fence line often DO know better than the
            // drawing. But footage drives the estimate, the post count and the
            // material order, so a change made on site and discovered later is
            // a job that has quietly stopped matching what the customer agreed
            // to pay. Asking costs a few minutes; finding out at invoicing
            // costs the difference.
            item { RequestChangeCard(jobId = jobId) }

            // A run is on the plan when it has a fence line OR a gate. Only
            // lines counted once, so a gate sold on its own -- a run with no
            // corners -- was never drawn, and a job whose only run was that
            // gate showed no plan at all while its card said there was a gate
            // to hang.
            val drawn = runs.filter { PlanExtent.hasSomethingToDraw(it) }
            if (drawn.isNotEmpty()) {
                item { com.fenceestimator.app.ui.components.FencePlanCanvas(currentJob, drawn, markers) }
                item { com.fenceestimator.app.ui.components.FencePlanLegend(drawn, markers) }
            }

            // Empty and broken look identical on a bare list -- this is the
            // difference between "nothing to build yet" and a sync that never
            // arrived, same wording the job screen uses for the same gap.
            if (runs.isEmpty()) {
                item { EmptyState(stringResource(R.string.misc_crew_no_runs)) }
            } else {
                items(runs.size) { index ->
                    RunCard(currentJob, runs[index])
                }
            }

            if (markers.isNotEmpty()) {
                item { MarkersCard(markers) }
            }

            item {
                Text(
                    stringResource(R.string.crew_plan_debris_rule),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

// PlanCanvas, Legend and LegendDot used to live here as private composables.
//
// They moved, unchanged, to ui/components/FencePlanView.kt as
// [com.fenceestimator.app.ui.components.FencePlanCanvas] and
// [com.fenceestimator.app.ui.components.FencePlanLegend], because the pull
// sheet needs the SAME picture and a fence drawn twice is a fence drawn wrong
// one of those times. Nothing about the geometry, the scale, the grid or the
// colours changed in the move, and every comment recording why a line of it is
// the way it is went with it.

/** The spec for one run, in the terms a crew works in. No prices. */
@Composable
private fun RunCard(job: Job, run: FenceRun) {
    val points = FenceCodec.decodePoints(run.pointsEncoded)
    val gates = FenceCodec.decodeGates(run.gatesEncoded)
    val manual = run.manualLinearFeet
    val usingManual = manual != null && manual > 0f

    // Honour typed-in footage. Reading "no fence line drawn" on a run that was
    // quoted by typing its length tells the crew the job isn't ready when it is.
    // Same scale as the drawing screen's dimensions (see FencePlanCanvas).
    val pxPerFt = SurveyViewModel.drawingScale(job) ?: SurveyViewModel.PIXELS_PER_FOOT_GRID
    val geometry = if (points.size >= 2) FenceGeometryEngine.analyze(points, pxPerFt, run.closedLoop) else null
    val feet = if (usingManual) manual!!.toDouble() else geometry?.totalLinearFeet?.toDouble() ?: 0.0
    val corners = if (usingManual) run.manualCornerCount else geometry?.cornerCount ?: 0

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text(run.label.ifBlank { stringResource(R.string.crew_plan_run_untitled) }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)

            if (feet <= 0.0) {
                Text(
                    stringResource(R.string.crew_plan_not_measured),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error
                )
                return@Column
            }

            SpecRow(stringResource(R.string.crew_plan_spec_type), run.fenceType.label())
            SpecRow(
                stringResource(R.string.crew_plan_spec_length),
                "${"%.0f".format(feet)} ft" +
                    if (usingManual) stringResource(R.string.crew_plan_measured_on_site) else ""
            )
            SpecRow(stringResource(R.string.crew_plan_spec_height), "${run.panelHeightFt.toInt()} ft")
            if (run.colorOrFinish.isNotBlank())
                SpecRow(stringResource(R.string.crew_plan_spec_color), run.colorOrFinish)
            SpecRow(stringResource(R.string.crew_plan_spec_spacing), "${run.postSpacingFt.toInt()} ft")
            SpecRow(
                stringResource(R.string.crew_plan_spec_concrete),
                stringResource(R.string.crew_plan_bags_per_post, run.concreteBagsPerPost.toString())
            )
            SpecRow(stringResource(R.string.crew_plan_spec_corners), corners.toString())
            if (geometry != null)
                SpecRow(stringResource(R.string.crew_plan_spec_ends), geometry.endCount.toString())
            SpecRow(stringResource(R.string.crew_plan_spec_gates), gates.size.toString())
            if (gates.isNotEmpty()) {
                Text(
                    stringResource(
                        R.string.crew_plan_gate_widths,
                        gates.joinToString(", ") { "${"%.0f".format(it.widthFt)} ft" }
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun SpecRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun MarkersCard(markers: List<SiteMarker>) {
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Text(
                stringResource(R.string.crew_plan_watch_out),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onErrorContainer
            )
            markers.forEach { marker ->
                Text(
                    "•  ${marker.kind.label()}" +
                        if (marker.label.isNotBlank()) " — ${marker.label}" else "",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onErrorContainer
                )
            }
        }
    }
}

/**
 * The crew asking the office to change the plan.
 *
 * Deliberately a request and not an edit. The crew at the fence line often know
 * something the drawing does not -- the yard is longer, there is a tree nobody
 * saw, the gate wants to be on the other side. But footage drives the estimate,
 * the post count and the material order, so a change made on site and noticed
 * later is a job that has quietly stopped matching what the customer signed.
 *
 * Sent with what they would do and why, because "can we move the gate" without
 * a reason just produces a phone call to ask why.
 */
@Composable
private fun RequestChangeCard(jobId: Long) {
    val app = currentApp()
    val session by app.session.state.collectAsState()
    // The demo predicate itself, never a permission -- this screen is exactly
    // where a guest is routed for the drawing (see MainActivity's Routes.SURVEY),
    // so it is a screen a visitor definitely reaches, and this card had no
    // guest gate at all: repository.requestPlanChange runs straight through
    // (GuestWriteGuard cannot yet refuse it either, since
    // Repository.isGuestSession is never set). Left un-gated it would have
    // written a real FieldChange row for a sample job -- one that never syncs
    // anywhere in guest mode and that dies with the sample job when the demo
    // wipe runs, all while the button's own copy promises "they will see it
    // straight away". That promise is false for a guest, so the button and
    // that line of copy are both replaced rather than merely disabled.
    //
    // No permission check is added here, and none should be inferred from its
    // absence for a real, signed-in crew member. There is no PERMISSION for
    // *asking* for a plan change -- only APPROVE_PLAN_CHANGES, which governs
    // *deciding* one, is a named permission (see cloud/Permissions.kt), and
    // GUEST_READ_ONLY (cloud/SessionManager.kt) excludes it, so it plays no
    // part in a guest's access to begin with. Read both files plus
    // GuestReadOnlyTest/PermissionsTest before concluding otherwise; do not
    // add a permission check here on a guess.
    val editable = !session.isGuestDemo
    var showDialog by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(false) }
    // The request had no job left to go with (see the send below), so it was
    // not saved -- and the card must not say it was.
    var jobGone by remember { mutableStateOf(false) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()

    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
    ) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text(
                stringResource(
                    when {
                        jobGone -> R.string.crew_plan_not_sent
                        sent -> R.string.crew_plan_change_requested
                        else -> R.string.crew_plan_something_wrong
                    }
                ),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSecondaryContainer
            )
            Text(
                stringResource(
                    when {
                        jobGone -> R.string.crew_plan_job_gone
                        sent -> R.string.crew_plan_office_has_it
                        // Never reachable together with jobGone/sent above --
                        // both require a saved request, which a guest can
                        // never make once the button below is gone.
                        !editable -> R.string.crew_plan_guest_no_office
                        else -> R.string.crew_plan_ask_office
                    }
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSecondaryContainer
            )
            // Asking again would only fail the same way: the job is not coming
            // back to this screen. Absent for a guest outright, not merely
            // disabled -- there is no office on the other end for a demo
            // session to reach.
            if (editable && !sent && !jobGone) {
                OutlinedButton(
                    onClick = { showDialog = true },
                    modifier = Modifier.fillMaxWidth()
                ) { Text(stringResource(R.string.crew_ask_change_plan)) }
            }
        }
    }

    if (showDialog) {
        var what by remember { mutableStateOf("") }
        var why by remember { mutableStateOf("") }

        AlertDialog(
            onDismissRequest = { showDialog = false },
            title = { Text(stringResource(R.string.crew_ask_change_plan)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Space.row)) {
                    OutlinedTextField(
                        value = what,
                        onValueChange = { what = it },
                        label = { Text(stringResource(R.string.crew_what_should_change)) },
                        placeholder = { Text(stringResource(R.string.crew_change_example)) },
                        modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = why,
                        onValueChange = { why = it },
                        label = { Text(stringResource(R.string.crew_change_why)) },
                        placeholder = { Text(stringResource(R.string.crew_change_why_example)) },
                        modifier = Modifier.fillMaxWidth()
                    )
                }
            },
            confirmButton = {
                Button(
                    enabled = what.isNotBlank(),
                    onClick = {
                        // Read now: the dialog, and the state behind these
                        // boxes, is gone by the time the save runs.
                        val summary = what.trim()
                        val detail = why.trim()
                        showDialog = false
                        scope.launch {
                            // A job the sync removed while this screen was
                            // open has no row for the request to hang off:
                            // the insert hit the foreign key and took the
                            // app down. Skipped instead -- see OrphanRows.
                            // "Sent" only once it is saved: this used to be
                            // set whatever happened, so a request thrown away
                            // here read "Change requested ... the office has
                            // it" to the person who asked.
                            val saved = com.fenceestimator.app.cloud.skipIfOrphaned {
                                app.repository.requestPlanChange(
                                    jobId = jobId,
                                    summary = summary,
                                    detail = detail,
                                    by = session.email.orEmpty(),
                                    role = session.role.label
                                )
                            }
                            if (saved == null) {
                                jobGone = true
                                return@launch
                            }
                            sent = true
                            app.autoSync.requestSync()
                        }
                    }
                ) { Text(stringResource(R.string.crew_send_request)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { showDialog = false }) { Text(stringResource(R.string.action_cancel)) }
            }
        )
    }
}

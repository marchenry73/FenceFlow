package com.fenceestimator.app.ui.jobs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.AssignmentKind
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp

/**
 * "Also on this job", under the lead picker: the extra crew and anyone let
 * in on a request, plus this job's waiting requests. See [JobCrewViewModel]
 * for who reads it and why it is absent on a server without the crew scope.
 *
 * Editable with SCHEDULE_AND_ASSIGN ([canAssign]) -- the one permission
 * set_job_crew, end_job_assignment and decide_job_access accept -- and plain
 * names for everyone else. Online only for changes: the list lives on the
 * server, and a change made here is what puts the job on someone's phone.
 *
 * @param canSeePay whether this phone knows which crew records have an app
 *   login (Employee.profileId comes down only with SEE_PAY). Where it does, a
 *   person with none is flagged: they cannot see this job on any phone.
 */
@Composable
internal fun JobCrewSection(job: Job, employees: List<Employee>, canAssign: Boolean, canSeePay: Boolean) {
    val app = currentApp()
    val viewModel: JobCrewViewModel = viewModel(
        key = "job_crew_${job.id}",
        factory = GenericViewModelFactory { JobCrewViewModel(app.session, app.connectivity.online, job.syncId) }
    )
    val state by viewModel.state.collectAsState()
    val online by app.connectivity.online.collectAsState()
    val message by viewModel.message.collectAsState()
    // A toast rather than a snackbar: the job screen has no snackbar host,
    // and this section must not grow one inside a card.
    val context = LocalContext.current
    val messageText = message?.let { m -> stringResource(m.textRes, *m.args.toTypedArray()) }
    LaunchedEffect(message) {
        messageText?.let {
            android.widget.Toast.makeText(context, it, android.widget.Toast.LENGTH_LONG).show()
            viewModel.consumeMessage()
        }
    }
    if (!state.available) return

    val bySync = remember(employees) { employees.associateBy { it.syncId } }
    val lead = employees.firstOrNull { it.id == job.assignedEmployeeId }
    val extra = extraCrewOf(state.assignments, lead?.syncId)
    // Read-only and nobody else on it: nothing worth a heading.
    if (!canAssign && extra.isEmpty()) return

    Column(Modifier.fillMaxWidth().padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            stringResource(R.string.job_crew_also_on),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold
        )
        if (extra.isEmpty()) {
            Text(
                stringResource(R.string.job_crew_nobody_else),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        val letIn = stringResource(R.string.job_crew_let_in)
        val noLogin = stringResource(R.string.job_crew_no_login_short)
        extra.forEach { a ->
            val person = bySync[a.employeeSyncId]
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        person?.name?.ifBlank { null } ?: stringResource(R.string.access_someone),
                        style = MaterialTheme.typography.bodyLarge
                    )
                    val notes = listOfNotNull(
                        letIn.takeIf { a.kind == AssignmentKind.ACCESS },
                        noLogin.takeIf { canSeePay && person != null && person.profileId.isBlank() }
                    )
                    if (notes.isNotEmpty()) {
                        Text(
                            notes.joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                if (canAssign) {
                    IconButton(onClick = { viewModel.remove(a) }, enabled = online && !state.busy) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = stringResource(R.string.job_crew_remove, person?.name.orEmpty())
                        )
                    }
                }
            }
        }
        if (canAssign) {
            val addable = addableCrew(employees, job.assignedEmployeeId, state.assignments)
            var open by remember { mutableStateOf(false) }
            Box {
                OutlinedButton(
                    onClick = { open = true },
                    enabled = online && !state.busy && addable.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(Icons.Filled.Add, contentDescription = null)
                    Text("  " + stringResource(R.string.job_crew_add))
                }
                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                    addable.forEach { e ->
                        DropdownMenuItem(
                            text = {
                                Text(
                                    e.name.ifBlank { stringResource(R.string.jd_unnamed) } +
                                        if (e.role.isNotBlank()) " · ${e.role}" else ""
                                )
                            },
                            onClick = { open = false; viewModel.add(e.syncId) }
                        )
                    }
                }
            }
            if (!online) {
                Text(
                    stringResource(R.string.job_crew_offline),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (state.requests.isNotEmpty()) {
                var declining by remember { mutableStateOf<PendingAsk?>(null) }
                Text(
                    stringResource(R.string.job_crew_asked),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.padding(top = 6.dp)
                )
                state.requests.forEach { r ->
                    val ask = PendingAsk(r, bySync[r.employeeSyncId]?.name?.ifBlank { null }, job)
                    AccessAskCard(
                        ask = ask,
                        showJob = false,
                        enabled = online && !state.busy,
                        onApprove = { viewModel.decide(r.id, approve = true) },
                        onDecline = { declining = ask },
                        onOpenJob = null
                    )
                }
                declining?.let { ask ->
                    DeclineDialog(
                        personName = ask.personName ?: stringResource(R.string.access_someone),
                        onDecline = { note ->
                            viewModel.decide(ask.request.id, approve = false, note = note)
                            declining = null
                        },
                        onDismiss = { declining = null }
                    )
                }
            }
        }
    }
}

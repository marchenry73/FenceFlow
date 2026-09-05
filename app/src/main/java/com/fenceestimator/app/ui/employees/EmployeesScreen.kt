package com.fenceestimator.app.ui.employees

import com.fenceestimator.app.data.Job
import androidx.compose.ui.Alignment
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.material3.RadioButton
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.theme.Space

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmployeesScreen(onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: EmployeesViewModel = viewModel(factory = GenericViewModelFactory { EmployeesViewModel(app.repository) })
    val employees by viewModel.employees.collectAsState()
    var removing by remember { mutableStateOf<Employee?>(null) }

    var editing by remember { mutableStateOf<Employee?>(null) }
    var showNew by remember { mutableStateOf(false) }

    // Whether invite-crew is even worth trying right now -- checked here
    // rather than just letting the call fail offline, because a failed
    // network call and "there is genuinely no connection" read the same to
    // this screen but should not: one is worth a retry message, the other
    // isn't worth attempting at all.
    val online by app.connectivity.online.collectAsState()
    var inviteOutcome by remember { mutableStateOf<InviteCrewApi.Result?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.emp_title)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { showNew = true }) {
                Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.emp_add_employee))
            }
        }
    ) { padding ->
        if (employees.isEmpty()) {
            Column(modifier = Modifier.fillMaxSize().padding(padding).padding(Space.xl)) {
                Text(
                    stringResource(R.string.emp_no_crew_yet),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(Space.screen),
                verticalArrangement = Arrangement.spacedBy(Space.sm)
            ) {
                // People still here first, then people who have left. Former
                // crew stay visible rather than vanishing: you need to find
                // them to check an old timesheet, or to put somebody back on.
                items(
                    employees.sortedWith(compareByDescending<Employee> { it.isActive }
                        .thenBy { it.name.lowercase() }),
                    key = { it.id }
                ) { e ->
                    Card(onClick = { editing = e }, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.fillMaxWidth().padding(Space.md)) {
                            Text(
                                e.name.ifBlank { stringResource(R.string.emp_unnamed) },
                                fontWeight = FontWeight.Medium,
                                color = if (e.isActive) MaterialTheme.colorScheme.onSurface
                                        else MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            if (!e.isActive) {
                                Text(
                                    stringResource(R.string.emp_no_longer_on_crew),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            if (e.role.isNotBlank()) Text(e.role, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (e.phone.isNotBlank()) Text(e.phone, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (e.email.isNotBlank()) Text(e.email, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }

    editing?.let { e ->
        EditEmployeeDialog(
            employee = e,
            onSave = { viewModel.save(it); editing = null },
            onRemoveFromCrew = { editing = null; removing = e },
            onPutBackOnCrew = { viewModel.reactivate(e); editing = null },
            onDismiss = { editing = null }
        )
    }

    // Taking somebody off the crew, and deciding who picks up their work.
    removing?.let { leaver ->
        var openJobs by remember(leaver.id) { mutableStateOf<List<Job>>(emptyList()) }
        LaunchedEffect(leaver.id) { openJobs = viewModel.openJobsFor(leaver) }
        var reassignTo by remember(leaver.id) { mutableStateOf<Long?>(null) }
        val candidates = employees.filter { it.isActive && it.id != leaver.id }

        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(stringResource(R.string.emp_take_off_crew_title, leaver.name.ifBlank { stringResource(R.string.emp_this_person) })) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Space.row)) {
                    Text(
                        stringResource(R.string.emp_take_off_crew_body),
                        style = MaterialTheme.typography.bodyMedium
                    )
                    if (openJobs.isEmpty()) {
                        Text(
                            stringResource(R.string.emp_no_unfinished_jobs),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    } else {
                        Text(
                            stringResource(R.string.emp_unfinished_jobs_who, openJobs.size),
                            fontWeight = FontWeight.Medium
                        )
                        // Finished jobs deliberately keep their name -- they did
                        // that work and the record should say so.
                        candidates.forEach { candidate ->
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.fillMaxWidth()
                                    .clickable { reassignTo = candidate.id }
                            ) {
                                RadioButton(
                                    selected = reassignTo == candidate.id,
                                    onClick = { reassignTo = candidate.id }
                                )
                                Text(candidate.name.ifBlank { stringResource(R.string.emp_unnamed) })
                            }
                        }
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth().clickable { reassignTo = null }
                        ) {
                            RadioButton(selected = reassignTo == null, onClick = { reassignTo = null })
                            Text(stringResource(R.string.emp_leave_unassigned))
                        }
                    }
                }
            },
            confirmButton = {
                Button(onClick = {
                    viewModel.deactivate(leaver, reassignTo)
                    removing = null
                }) { Text(stringResource(R.string.emp_take_them_off)) }
            },
            dismissButton = {
                OutlinedButton(onClick = { removing = null }) { Text(stringResource(R.string.action_cancel)) }
            }
        )
    }
    if (showNew) {
        EditEmployeeDialog(
            employee = Employee(),
            // Only the ADD path invites -- editing an existing crew member
            // reuses plain save() below, so fixing a typo in someone's phone
            // number can never re-trigger their invitation.
            onSave = {
                viewModel.addCrewMember(it, online = online) { outcome -> inviteOutcome = outcome }
                showNew = false
            },
            onDismiss = { showNew = false }
        )
    }

    inviteOutcome?.let { outcome -> InviteOutcomeDialog(outcome) { inviteOutcome = null } }
}

/**
 * Reports what came of inviting a newly-added crew member by email.
 *
 * Three outcomes, three different things a manager standing at a truck needs
 * to do next: nothing (it was emailed), read a code out loud or text it over
 * (no mail path configured server-side), or try again later (a real
 * failure). Collapsing these into one message would hide which one it was.
 */
@Composable
private fun InviteOutcomeDialog(outcome: InviteCrewApi.Result, onDismiss: () -> Unit) {
    when (outcome) {
        is InviteCrewApi.Result.Emailed -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(stringResource(R.string.emp_invite_sent_title)) },
            text = { Text(stringResource(R.string.emp_invite_emailed_body)) },
            confirmButton = { Button(onClick = onDismiss) { Text(stringResource(R.string.action_done)) } }
        )
        is InviteCrewApi.Result.NeedsCode -> {
            val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
            var copied by remember(outcome.code) { mutableStateOf(false) }
            AlertDialog(
                onDismissRequest = onDismiss,
                title = { Text(stringResource(R.string.emp_invite_needs_code_title)) },
                text = {
                    Column {
                        Text(
                            outcome.sentence.ifBlank { stringResource(R.string.emp_invite_needs_code_fallback) },
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Spacer(Modifier.height(Space.sm))
                        Text(stringResource(R.string.emp_team_code_label), style = MaterialTheme.typography.labelLarge)
                        androidx.compose.foundation.text.selection.SelectionContainer {
                            Text(
                                outcome.code,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.Medium
                            )
                        }
                        if (copied) {
                            Spacer(Modifier.height(Space.xs))
                            Text(
                                stringResource(R.string.emp_team_code_copied),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                },
                confirmButton = {
                    Button(onClick = {
                        clipboard.setText(androidx.compose.ui.text.AnnotatedString(outcome.code))
                        copied = true
                    }) { Text(stringResource(R.string.acct_copy_code)) }
                },
                dismissButton = { OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_done)) } }
            )
        }
        is InviteCrewApi.Result.Failed -> AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(stringResource(R.string.emp_invite_failed_title)) },
            text = { Text(outcome.reason) },
            confirmButton = { Button(onClick = onDismiss) { Text(stringResource(R.string.action_done)) } }
        )
    }
}

@Composable
private fun EditEmployeeDialog(
    employee: Employee,
    onSave: (Employee) -> Unit,
    onRemoveFromCrew: () -> Unit = {},
    onPutBackOnCrew: () -> Unit = {},
    onDismiss: () -> Unit
) {
    var name by remember { mutableStateOf(employee.name) }
    var role by remember { mutableStateOf(employee.role) }
    var hourlyRate by remember { mutableStateOf(if (employee.hourlyRate > 0) employee.hourlyRate.toString() else "") }
    var perFootRate by remember { mutableStateOf(if (employee.perFootRate > 0) employee.perFootRate.toString() else "") }
    var payType by remember { mutableStateOf(employee.payType) }
    var phone by remember { mutableStateOf(employee.phone) }
    var email by remember { mutableStateOf(employee.email) }
    var notes by remember { mutableStateOf(employee.notes) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(if (employee.id == 0L) R.string.emp_new_crew_member else R.string.emp_edit_crew_member)) },
        text = {
            Column {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text(stringResource(R.string.emp_name)) }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(Space.sm))
                OutlinedTextField(value = role, onValueChange = { role = it }, label = { Text(stringResource(R.string.emp_role_hint)) }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(Space.sm))
                Text(stringResource(R.string.emp_how_paid), style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                    com.fenceestimator.app.data.PayType.values().forEach { type ->
                        androidx.compose.material3.FilterChip(
                            selected = payType == type,
                            onClick = { payType = type },
                            label = { Text(stringResource(if (type == com.fenceestimator.app.data.PayType.HOURLY) R.string.emp_per_hour else R.string.emp_per_foot)) }
                        )
                    }
                }
                Spacer(Modifier.height(Space.sm))
                if (payType == com.fenceestimator.app.data.PayType.HOURLY) {
                    OutlinedTextField(
                        value = hourlyRate, onValueChange = { hourlyRate = it },
                        label = { Text(stringResource(R.string.emp_hourly_rate)) },
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                            keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                } else {
                    OutlinedTextField(
                        value = perFootRate, onValueChange = { perFootRate = it },
                        label = { Text(stringResource(R.string.emp_rate_per_foot)) },
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                            keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                    Text(
                        stringResource(R.string.emp_hours_still_tracked),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Spacer(Modifier.height(Space.sm))
                OutlinedTextField(value = phone, onValueChange = { phone = it }, label = { Text(stringResource(R.string.field_phone)) }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(Space.sm))
                OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text(stringResource(R.string.field_email)) }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(Space.sm))
                OutlinedTextField(value = notes, onValueChange = { notes = it }, label = { Text(stringResource(R.string.field_notes)) }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            }
        },
        confirmButton = {
            Button(onClick = {
                onSave(
                    employee.copy(
                        name = name, role = role, phone = phone, email = email, notes = notes,
                        payType = payType,
                        hourlyRate = hourlyRate.replace(',', '.').toDoubleOrNull() ?: 0.0,
                        perFootRate = perFootRate.replace(',', '.').toDoubleOrNull() ?: 0.0
                    )
                )
            }) {
                Text(stringResource(R.string.action_save))
            }
        },
        dismissButton = {
            Row {
                // Taking somebody off the crew is the normal way to remove a
                // person: it keeps their hours, their jobs and what those jobs
                // cost, which is the record payroll and tax actually need.
                // Deleting is kept for a record entered by mistake, and stays
                // behind the delete permission.
                if (employee.id != 0L) {
                    if (employee.isActive) {
                        OutlinedButton(onClick = onRemoveFromCrew) { Text(stringResource(R.string.emp_take_off_crew)) }
                    } else {
                        OutlinedButton(onClick = onPutBackOnCrew) { Text(stringResource(R.string.emp_put_back_on)) }
                    }
                    Spacer(Modifier.width(Space.sm))
                }
                OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
            }
        }
    )
}

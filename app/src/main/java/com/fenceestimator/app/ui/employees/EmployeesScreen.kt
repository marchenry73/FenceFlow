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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EmployeesScreen(onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: EmployeesViewModel = viewModel(factory = GenericViewModelFactory { EmployeesViewModel(app.repository) })
    val employees by viewModel.employees.collectAsState()
    val session by app.session.state.collectAsState()
    val canDelete = session.canDelete
    var removing by remember { mutableStateOf<Employee?>(null) }

    var editing by remember { mutableStateOf<Employee?>(null) }
    var showNew by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Crew & Employees") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } }
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { showNew = true }) {
                Icon(Icons.Filled.Add, contentDescription = "Add employee")
            }
        }
    ) { padding ->
        if (employees.isEmpty()) {
            Column(modifier = Modifier.fillMaxSize().padding(padding).padding(24.dp)) {
                Text(
                    "No crew members yet. Add your team so you can assign them to jobs.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
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
                        Column(Modifier.fillMaxWidth().padding(12.dp)) {
                            Text(
                                e.name.ifBlank { "Unnamed" },
                                fontWeight = FontWeight.Medium,
                                color = if (e.isActive) MaterialTheme.colorScheme.onSurface
                                        else MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            if (!e.isActive) {
                                Text(
                                    "No longer on the crew. Their hours and jobs are kept.",
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
            onDelete = { viewModel.delete(e); editing = null },
            canDelete = canDelete,
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
            title = { Text("Take ${leaver.name.ifBlank { "this person" }} off the crew?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        "They stop appearing when you assign work and can no longer " +
                            "sign in. Everything they did stays: their hours, the jobs " +
                            "they worked, and what those jobs cost.",
                        style = MaterialTheme.typography.bodyMedium
                    )
                    if (openJobs.isEmpty()) {
                        Text(
                            "They have no unfinished jobs.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    } else {
                        Text(
                            "${openJobs.size} unfinished job(s) are theirs. Who takes them on?",
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
                                Text(candidate.name.ifBlank { "Unnamed" })
                            }
                        }
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth().clickable { reassignTo = null }
                        ) {
                            RadioButton(selected = reassignTo == null, onClick = { reassignTo = null })
                            Text("Leave them unassigned for now")
                        }
                    }
                }
            },
            confirmButton = {
                Button(onClick = {
                    viewModel.deactivate(leaver, reassignTo)
                    removing = null
                }) { Text("Take them off") }
            },
            dismissButton = {
                OutlinedButton(onClick = { removing = null }) { Text("Cancel") }
            }
        )
    }
    if (showNew) {
        EditEmployeeDialog(
            employee = Employee(),
            onSave = { viewModel.save(it); showNew = false },
            onDelete = { showNew = false },
            canDelete = canDelete,
            onDismiss = { showNew = false }
        )
    }
}

@Composable
private fun EditEmployeeDialog(
    employee: Employee,
    onSave: (Employee) -> Unit,
    onDelete: () -> Unit,
    canDelete: Boolean,
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
        title = { Text(if (employee.id == 0L) "New Crew Member" else "Edit Crew Member") },
        text = {
            Column {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = role, onValueChange = { role = it }, label = { Text("Role (e.g. Foreman, Laborer)") }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                Text("How they're paid", style = MaterialTheme.typography.labelLarge)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    com.fenceestimator.app.data.PayType.values().forEach { type ->
                        androidx.compose.material3.FilterChip(
                            selected = payType == type,
                            onClick = { payType = type },
                            label = { Text(if (type == com.fenceestimator.app.data.PayType.HOURLY) "Per hour" else "Per foot") }
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
                if (payType == com.fenceestimator.app.data.PayType.HOURLY) {
                    OutlinedTextField(
                        value = hourlyRate, onValueChange = { hourlyRate = it },
                        label = { Text("Hourly rate ($)") },
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                            keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                } else {
                    OutlinedTextField(
                        value = perFootRate, onValueChange = { perFootRate = it },
                        label = { Text("Rate per linear foot ($)") },
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                            keyboardType = androidx.compose.ui.text.input.KeyboardType.Decimal
                        ),
                        modifier = Modifier.fillMaxWidth()
                    )
                    Text(
                        "Hours are still tracked so you can see how the rate is working out.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = phone, onValueChange = { phone = it }, label = { Text("Phone") }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = email, onValueChange = { email = it }, label = { Text("Email") }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = notes, onValueChange = { notes = it }, label = { Text("Notes") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
            }
        },
        confirmButton = {
            Button(onClick = {
                onSave(
                    employee.copy(
                        name = name, role = role, phone = phone, email = email, notes = notes,
                        payType = payType,
                        hourlyRate = hourlyRate.toDoubleOrNull() ?: 0.0,
                        perFootRate = perFootRate.toDoubleOrNull() ?: 0.0
                    )
                )
            }) {
                Text("Save")
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
                        OutlinedButton(onClick = onRemoveFromCrew) { Text("Take off crew") }
                    } else {
                        OutlinedButton(onClick = onPutBackOnCrew) { Text("Put back on") }
                    }
                    Spacer(Modifier.width(8.dp))
                }
                OutlinedButton(onClick = onDismiss) { Text("Cancel") }
            }
        }
    )
}

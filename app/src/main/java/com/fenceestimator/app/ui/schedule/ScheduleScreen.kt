package com.fenceestimator.app.ui.schedule

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScheduleScreen(onOpenJob: (Long) -> Unit, onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: ScheduleViewModel = viewModel(factory = GenericViewModelFactory { ScheduleViewModel(app.repository) })
    val jobs by viewModel.scheduledJobs.collectAsState()
    val dateFormat = remember { SimpleDateFormat("EEE, MMM d, yyyy", Locale.US) }
    val profile by app.settingsStore.profile.collectAsState(
        initial = com.fenceestimator.app.data.BusinessProfile()
    )

    // Both views stay. The list answers "what is next"; the month answers "is
    // the week of the twelfth free", which is the question every time somebody
    // rings wanting a date. Neither is a worse version of the other.
    var monthView by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    var monthStart by remember {
        mutableStateOf(
            java.util.Calendar.getInstance().apply {
                set(java.util.Calendar.DAY_OF_MONTH, 1)
                set(java.util.Calendar.HOUR_OF_DAY, 0)
                set(java.util.Calendar.MINUTE, 0)
                set(java.util.Calendar.SECOND, 0)
                set(java.util.Calendar.MILLISECOND, 0)
            }.timeInMillis
        )
    }
    var selectedDay by remember { mutableStateOf<Long?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.misc_schedule_title)) },
                actions = {
                    androidx.compose.material3.TextButton(onClick = { monthView = !monthView }) {
                        Text(stringResource(if (monthView) R.string.misc_schedule_view_list else R.string.misc_schedule_view_month))
                    }
                },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
            )
        }
    ) { padding ->
        if (monthView) {
            val workday = (profile.workdayHours - profile.breakHoursPerDay).coerceAtLeast(1.0)
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                item {
                    MonthCalendar(
                        monthStart = monthStart,
                        jobs = jobs,
                        workdayHours = workday,
                        selectedDay = selectedDay,
                        onSelectDay = { selectedDay = it },
                        onPreviousMonth = {
                            monthStart = java.util.Calendar.getInstance().apply {
                                timeInMillis = monthStart
                                add(java.util.Calendar.MONTH, -1)
                            }.timeInMillis
                        },
                        onNextMonth = {
                            monthStart = java.util.Calendar.getInstance().apply {
                                timeInMillis = monthStart
                                add(java.util.Calendar.MONTH, 1)
                            }.timeInMillis
                        }
                    )
                }

                // What is actually on the chosen day. A grid of dots tells you
                // a day is busy; it does not tell you whose fence it is, which
                // is the next thing anybody asks.
                val day = selectedDay
                if (day != null) {
                    val onDay = jobs.filter { job ->
                        val start = job.scheduledDate ?: return@filter false
                        val days = com.fenceestimator.app.estimate.JobSchedule
                            .plan(job, workday).totalDays
                        (0 until days).any { offset ->
                            com.fenceestimator.app.estimate.JobSchedule.startOfDay(
                                com.fenceestimator.app.estimate.JobSchedule.addDays(start, offset)
                            ) == day
                        }
                    }
                    item {
                        Text(
                            dateFormat.format(java.util.Date(day)),
                            style = MaterialTheme.typography.titleSmall
                        )
                    }
                    if (onDay.isEmpty()) {
                        item {
                            Text(
                                stringResource(R.string.misc_schedule_day_free),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    items(onDay, key = { it.id }) { job ->
                        Card(
                            onClick = { onOpenJob(job.id) },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Column(Modifier.padding(12.dp)) {
                                Text(
                                    job.customerName.ifBlank { stringResource(R.string.jobs_untitled) },
                                    style = MaterialTheme.typography.titleSmall
                                )
                                if (job.address.isNotBlank()) {
                                    Text(
                                        job.address,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                                Text(
                                    com.fenceestimator.app.estimate.JobSchedule
                                        .plan(job, workday, day).crewSummary,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                }
            }
        } else if (jobs.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(stringResource(R.string.misc_schedule_empty), modifier = Modifier.padding(24.dp))
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                item {
                    val context = androidx.compose.ui.platform.LocalContext.current
                    // Today's stops, in scheduled order, as one multi-stop route.
                    val todaysAddresses = remember(jobs) {
                        val start = java.util.Calendar.getInstance().apply {
                            set(java.util.Calendar.HOUR_OF_DAY, 0); set(java.util.Calendar.MINUTE, 0)
                            set(java.util.Calendar.SECOND, 0); set(java.util.Calendar.MILLISECOND, 0)
                        }.timeInMillis
                        val end = start + 24 * 60 * 60 * 1000L
                        jobs.filter { it.scheduledDate != null && it.scheduledDate in start until end }
                            .sortedBy { it.scheduledDate }
                            .map { it.address }
                            .filter { it.isNotBlank() }
                    }
                    if (todaysAddresses.isNotEmpty()) {
                        androidx.compose.material3.Button(
                            onClick = { com.fenceestimator.app.ui.components.IntentHelpers.routeThrough(context, todaysAddresses) },
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(
                                if (todaysAddresses.size == 1) stringResource(R.string.misc_schedule_navigate_today)
                                else stringResource(R.string.misc_schedule_route_stops, todaysAddresses.size)
                            )
                        }
                    }
                }
                items(jobs, key = { it.id }) { job ->
                    Card(onClick = { onOpenJob(job.id) }, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            Text(job.scheduledDate?.let { dateFormat.format(Date(it)) } ?: "", fontWeight = FontWeight.SemiBold)
                            Text(job.customerName.ifBlank { stringResource(R.string.jobs_untitled) }, style = MaterialTheme.typography.bodyLarge)
                            if (job.address.isNotBlank()) {
                                Text(job.address, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        }
    }
}

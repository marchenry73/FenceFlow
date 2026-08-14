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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
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

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Schedule") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } }
            )
        }
    ) { padding ->
        if (jobs.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text("No jobs scheduled yet -- set a date on a job to see it here.", modifier = Modifier.padding(24.dp))
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
                                if (todaysAddresses.size == 1) "Navigate to Today's Job"
                                else "Route Today's ${todaysAddresses.size} Stops"
                            )
                        }
                    }
                }
                items(jobs, key = { it.id }) { job ->
                    Card(onClick = { onOpenJob(job.id) }, modifier = Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(12.dp)) {
                            Text(job.scheduledDate?.let { dateFormat.format(Date(it)) } ?: "", fontWeight = FontWeight.SemiBold)
                            Text(job.customerName.ifBlank { "Untitled job" }, style = MaterialTheme.typography.bodyLarge)
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

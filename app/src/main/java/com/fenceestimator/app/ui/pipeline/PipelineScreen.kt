package com.fenceestimator.app.ui.pipeline

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.jobs.JobsViewModel
import java.text.NumberFormat
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PipelineScreen(onOpenJob: (Long) -> Unit, onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: JobsViewModel = viewModel(factory = GenericViewModelFactory { JobsViewModel(app.repository) })
    val jobs by viewModel.jobs.collectAsState()
    val currency = remember { NumberFormat.getCurrencyInstance(Locale.US) }

    // A job counts as "being estimated" once there's a scheduled date or any
    // money on it -- enough signal to separate real work from a bare lead.
    val grouped = remember(jobs) {
        jobs.groupBy { job ->
            PipelineStage.of(job, hasDrawnWork = job.calibrationPixelsPerFoot != null)
        }
    }
    val lost = grouped[PipelineStage.LOST].orEmpty()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pipeline") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } }
            )
        }
    ) { padding ->
        LazyRow(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(12.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            items(PipelineStage.flow) { stage ->
                StageColumn(
                    stage = stage,
                    jobs = grouped[stage].orEmpty(),
                    currency = currency,
                    onOpenJob = onOpenJob
                )
            }
            if (lost.isNotEmpty()) {
                item {
                    StageColumn(
                        stage = PipelineStage.LOST,
                        jobs = lost,
                        currency = currency,
                        onOpenJob = onOpenJob
                    )
                }
            }
        }
    }
}

@Composable
private fun StageColumn(
    stage: PipelineStage,
    jobs: List<Job>,
    currency: NumberFormat,
    onOpenJob: (Long) -> Unit
) {
    Column(modifier = Modifier.width(260.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Text(stage.label, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium)
            Text(
                jobs.size.toString(),
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary
            )
        }
        if (jobs.isEmpty()) {
            Text(
                "Nothing here",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(jobs, key = { it.id }) { job ->
                Card(
                    modifier = Modifier.fillMaxWidth().clickable { onOpenJob(job.id) },
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text(
                            job.customerName.ifBlank { "Untitled job" },
                            fontWeight = FontWeight.Medium,
                            style = MaterialTheme.typography.bodyMedium
                        )
                        if (job.address.isNotBlank()) {
                            Text(
                                job.address,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        if (job.amountPaid > 0.0) {
                            Text(
                                "Paid ${currency.format(job.amountPaid)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                    }
                }
            }
        }
    }
}

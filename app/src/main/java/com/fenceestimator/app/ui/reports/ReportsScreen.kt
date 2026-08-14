package com.fenceestimator.app.ui.reports

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
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
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import java.text.NumberFormat
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReportsScreen(onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: ReportsViewModel = viewModel(factory = GenericViewModelFactory { ReportsViewModel(app.repository) })
    val period by viewModel.period.collectAsState()
    val totals by viewModel.totals.collectAsState()
    val byInstaller by viewModel.byInstaller.collectAsState()
    val currency = remember { NumberFormat.getCurrencyInstance(Locale.US) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Business Reports") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    ReportPeriod.values().forEach { p ->
                        FilterChip(
                            selected = period == p,
                            onClick = { viewModel.setPeriod(p) },
                            label = { Text(p.label) }
                        )
                    }
                }
            }

            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    BigStat("Jobs Won", totals.jobsWon.toString(), Modifier.weight(1f))
                    BigStat("Collected", currency.format(totals.revenueCollected), Modifier.weight(1f))
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    BigStat("Est. Profit", currency.format(totals.estimatedProfit), Modifier.weight(1f))
                    BigStat("Margin", "${"%.0f".format(totals.profitMarginPercent)}%", Modifier.weight(1f))
                }
            }

            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Money Breakdown", style = MaterialTheme.typography.titleMedium)
                        ReportRow("Contract value (work won)", currency.format(totals.contractValue))
                        ReportRow("Material cost", currency.format(totals.materialCost))
                        if (totals.actualLaborCost > 0.0) {
                            ReportRow(
                                "Labor cost (${"%.1f".format(totals.actualLaborHours)} clocked hours)",
                                currency.format(totals.actualLaborCost)
                            )
                        } else {
                            ReportRow("Labor cost (quoted, no hours clocked)", currency.format(totals.laborCost))
                        }
                        ReportRow("Other expenses (fuel, rentals, permits)", currency.format(totals.otherExpenses))
                        Divider(Modifier.padding(vertical = 6.dp))
                        ReportRow("Estimated profit", currency.format(totals.estimatedProfit), bold = true)
                        ReportRow("Still owed to you", currency.format(totals.outstanding))
                        if (totals.tipsToInstallers > 0.0) {
                            ReportRow("Tips (100% to installers)", currency.format(totals.tipsToInstallers))
                        }
                    }
                }
            }

            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Sales Performance", style = MaterialTheme.typography.titleMedium)
                        ReportRow("Quotes sent", totals.quotesSent.toString())
                        ReportRow("Jobs won", totals.jobsWon.toString())
                        ReportRow("Closing rate", "${"%.0f".format(totals.closingRatePercent)}%")
                        ReportRow("Average job value", currency.format(totals.averageJobValue))
                        ReportRow("Paid in full", totals.jobsCompleted.toString())
                    }
                }
            }

            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("By Installer", style = MaterialTheme.typography.titleMedium)
                        if (byInstaller.isEmpty()) {
                            Text(
                                "Assign crew members to jobs (on the job screen) to see per-installer numbers here.",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        } else {
                            byInstaller.forEach { installer ->
                                ReportRow(
                                    "${installer.name}  (${installer.jobCount} job${if (installer.jobCount == 1) "" else "s"})",
                                    currency.format(installer.contractValue)
                                )
                            }
                        }
                    }
                }
            }

            item {
                Text(
                    "Profit figures are estimates from your catalog prices and labor settings -- they don't include overhead like insurance, vehicles, or office costs.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun BigStat(label: String, value: String, modifier: Modifier = Modifier) {
    Card(modifier, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)) {
        Column(Modifier.padding(14.dp)) {
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSecondaryContainer)
            Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSecondaryContainer)
        }
    }
}

@Composable
private fun ReportRow(label: String, value: String, bold: Boolean = false) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal)
        Text(value, fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium)
    }
}

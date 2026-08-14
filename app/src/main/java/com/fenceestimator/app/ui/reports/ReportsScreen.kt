package com.fenceestimator.app.ui.reports

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone

/**
 * Chart colors. These four were checked for colorblind separation and for
 * contrast against a white card; green and amber sit low enough on contrast
 * that every bar carries a printed value beside it rather than relying on hue.
 */
private val MoneyBlue = Color(0xFF2A78D6)
private val CostOrange = Color(0xFFEB6834)
private val SalesGreen = Color(0xFF1BAF7A)
private val CrewAmber = Color(0xFFEDA100)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReportsScreen(onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: ReportsViewModel = viewModel(factory = GenericViewModelFactory { ReportsViewModel(app.repository) })
    val preset by viewModel.preset.collectAsState()
    val from by viewModel.from.collectAsState()
    val to by viewModel.to.collectAsState()
    val hourFilter by viewModel.hourFilter.collectAsState()
    val data by viewModel.data.collectAsState()
    val totals = data.totals

    val currency = remember { NumberFormat.getCurrencyInstance(Locale.US) }
    val dateFmt = remember { SimpleDateFormat("MMM d, yyyy", Locale.getDefault()) }
    val timeFmt = remember { SimpleDateFormat("MMM d  h:mm a", Locale.getDefault()) }

    var pickingFrom by remember { mutableStateOf(false) }
    var pickingTo by remember { mutableStateOf(false) }

    var moneyOpen by rememberSaveable { mutableStateOf(true) }
    var salesOpen by rememberSaveable { mutableStateOf(true) }
    var crewOpen by rememberSaveable { mutableStateOf(true) }
    var tablesOpen by rememberSaveable { mutableStateOf(false) }

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
            // ---- Filters -------------------------------------------------
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            ReportPreset.values().filter { it != ReportPreset.CUSTOM }.forEach { p ->
                                FilterChip(
                                    selected = preset == p,
                                    onClick = { viewModel.setPreset(p) },
                                    label = { Text(p.label) }
                                )
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = { pickingFrom = true }, modifier = Modifier.weight(1f)) {
                                Text(if (from == 0L) "Start" else dateFmt.format(from), maxLines = 1)
                            }
                            OutlinedButton(onClick = { pickingTo = true }, modifier = Modifier.weight(1f)) {
                                Text(dateFmt.format(to), maxLines = 1)
                            }
                        }
                        Row(
                            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            HourFilter.values().forEach { h ->
                                FilterChip(
                                    selected = hourFilter == h,
                                    onClick = { viewModel.setHourFilter(h) },
                                    label = { Text(h.label) }
                                )
                            }
                        }
                        Text(
                            "Time of day filters the clocked hours and labor cost. Money and job counts always cover the whole date range.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            // ---- Headline numbers ----------------------------------------
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    BigStat("Collected", currency.format(totals.collected), Modifier.weight(1f))
                    BigStat("Profit", currency.format(totals.profit), Modifier.weight(1f))
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    BigStat("Margin", "${"%.0f".format(totals.marginPercent)}%", Modifier.weight(1f))
                    BigStat("Jobs won", totals.jobsWon.toString(), Modifier.weight(1f))
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    BigStat("Close rate", "${"%.0f".format(totals.closeRatePercent)}%", Modifier.weight(1f))
                    BigStat("Hours clocked", "%.1f".format(totals.hoursClocked), Modifier.weight(1f))
                }
            }

            // ---- Money ---------------------------------------------------
            item {
                CategoryHeader("Money", moneyOpen) { moneyOpen = !moneyOpen }
            }
            if (moneyOpen) {
                item {
                    ChartCard(
                        title = "Money collected by month",
                        rows = data.revenueByMonth,
                        color = MoneyBlue,
                        format = { currency.format(it) },
                        empty = "Nothing recorded as paid in this range."
                    )
                }
                item {
                    ChartCard(
                        title = "Where the money goes",
                        rows = data.costBreakdown,
                        colors = listOf(MoneyBlue, CostOrange, SalesGreen, CrewAmber),
                        format = { currency.format(it) },
                        empty = "No money in or out yet for this range."
                    )
                }
                item {
                    ChartCard(
                        title = "Expenses by category",
                        rows = data.expensesByCategory,
                        color = CostOrange,
                        format = { currency.format(it) },
                        empty = "No fuel, rental, or permit expenses logged."
                    )
                }
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("The numbers", style = MaterialTheme.typography.titleMedium)
                            ReportRow("Collected", currency.format(totals.collected))
                            ReportRow("Material cost", currency.format(totals.materialCost))
                            ReportRow("Labor cost (${"%.1f".format(totals.hoursClocked)} clocked hrs)", currency.format(totals.laborCost))
                            ReportRow("Other expenses", currency.format(totals.otherExpenses))
                            Divider(Modifier.padding(vertical = 6.dp))
                            ReportRow("Profit", currency.format(totals.profit), bold = true)
                            ReportRow("Average job", currency.format(totals.averageJob))
                            if (totals.tipsToInstallers > 0.0) {
                                ReportRow("Tips (100% to installers)", currency.format(totals.tipsToInstallers))
                            }
                        }
                    }
                }
            }

            // ---- Sales ---------------------------------------------------
            item {
                CategoryHeader("Sales", salesOpen) { salesOpen = !salesOpen }
            }
            if (salesOpen) {
                item {
                    ChartCard(
                        title = "Jobs by stage",
                        rows = data.jobsByStage,
                        color = SalesGreen,
                        format = { "%.0f".format(it) },
                        empty = "No jobs in this date range."
                    )
                }
                item {
                    ChartCard(
                        title = "Quote to paid",
                        rows = data.funnel,
                        color = SalesGreen,
                        format = { "%.0f".format(it) },
                        empty = "No jobs in this date range."
                    )
                }
                item {
                    ChartCard(
                        title = "Where won jobs came from",
                        rows = data.leadSources,
                        color = SalesGreen,
                        format = { "%.0f".format(it) },
                        empty = "Set a referral source on jobs to see which ads and referrals pay off."
                    )
                }
            }

            // ---- Work & crew ---------------------------------------------
            item {
                CategoryHeader("Work & Crew", crewOpen) { crewOpen = !crewOpen }
            }
            if (crewOpen) {
                item {
                    ChartCard(
                        title = "Hours by crew member",
                        rows = data.hoursByCrew,
                        color = CrewAmber,
                        format = { "%.1f hrs".format(it) },
                        empty = "No one has clocked in during this range."
                    )
                }
                item {
                    ChartCard(
                        title = "Feet built by fence type",
                        rows = data.fenceTypes,
                        color = CrewAmber,
                        format = { "%,.0f ft".format(it) },
                        empty = "Footage shows up once a job is drawn and calibrated."
                    )
                }
            }

            // ---- Detailed tables -----------------------------------------
            item {
                CategoryHeader("Detailed tables", tablesOpen) { tablesOpen = !tablesOpen }
            }
            if (tablesOpen) {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("Crew pay", style = MaterialTheme.typography.titleMedium)
                            if (data.crewDetail.isEmpty()) {
                                EmptyNote("No clocked time in this range.")
                            } else {
                                data.crewDetail.forEach { c ->
                                    ReportRow(
                                        "${c.name}  (${c.jobs} job${if (c.jobs == 1) "" else "s"}, ${"%.1f".format(c.hours)} hrs)",
                                        currency.format(c.cost)
                                    )
                                    Text(
                                        "Works out to ${currency.format(c.perHour)}/hr",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                    }
                }
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("Still owed to you", style = MaterialTheme.typography.titleMedium)
                            if (data.outstanding.isEmpty()) {
                                EmptyNote("Everything in this range is paid up.")
                            } else {
                                data.outstanding.forEach { o ->
                                    ReportRow("${o.customer}  (${o.status.lowercase()})", currency.format(o.outstanding))
                                }
                            }
                        }
                    }
                }
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("Clock in / clock out", style = MaterialTheme.typography.titleMedium)
                            if (data.timeDetail.isEmpty()) {
                                EmptyNote("No finished shifts in this range.")
                            } else {
                                data.timeDetail.take(40).forEach { t ->
                                    ReportRow(
                                        "${t.job} — ${timeFmt.format(t.start)}",
                                        "${"%.1f".format(t.hours)} hrs  ${currency.format(t.cost)}"
                                    )
                                }
                                if (data.timeDetail.size > 40) {
                                    EmptyNote("Showing the 40 most recent of ${data.timeDetail.size} shifts.")
                                }
                            }
                        }
                    }
                }
            }

            item {
                Text(
                    "Profit here is money actually collected minus catalog material cost, clocked labor, and logged expenses. It doesn't include overhead like insurance, vehicles, or office costs.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }

    if (pickingFrom) {
        RangeDatePicker(
            initial = if (from == 0L) System.currentTimeMillis() else from,
            onPicked = { viewModel.setRange(startOfDay(it), to); pickingFrom = false },
            onDismiss = { pickingFrom = false }
        )
    }
    if (pickingTo) {
        RangeDatePicker(
            initial = to,
            onPicked = { viewModel.setRange(from, endOfDay(it)); pickingTo = false },
            onDismiss = { pickingTo = false }
        )
    }
}

/**
 * The picker hands back UTC midnight, so read the calendar fields back out in
 * UTC and rebuild them in local time -- otherwise anyone west of Greenwich
 * picks a day and gets the one before it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RangeDatePicker(initial: Long, onPicked: (Long) -> Unit, onDismiss: () -> Unit) {
    val state = rememberDatePickerState(initialSelectedDateMillis = initial)
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(onClick = {
                val utc = state.selectedDateMillis
                if (utc != null) onPicked(toLocalMidnight(utc)) else onDismiss()
            }) { Text("OK") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } }
    ) {
        DatePicker(state = state)
    }
}

private fun toLocalMidnight(utcMillis: Long): Long {
    val utc = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { timeInMillis = utcMillis }
    return Calendar.getInstance().apply {
        set(utc.get(Calendar.YEAR), utc.get(Calendar.MONTH), utc.get(Calendar.DAY_OF_MONTH), 0, 0, 0)
        set(Calendar.MILLISECOND, 0)
    }.timeInMillis
}

private fun startOfDay(millis: Long): Long = Calendar.getInstance().apply {
    timeInMillis = millis
    set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
    set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
}.timeInMillis

private fun endOfDay(millis: Long): Long = Calendar.getInstance().apply {
    timeInMillis = millis
    set(Calendar.HOUR_OF_DAY, 23); set(Calendar.MINUTE, 59)
    set(Calendar.SECOND, 59); set(Calendar.MILLISECOND, 999)
}.timeInMillis

@Composable
private fun CategoryHeader(title: String, open: Boolean, onToggle: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable { onToggle() }.padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Icon(
            if (open) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
            contentDescription = if (open) "Collapse $title" else "Expand $title"
        )
    }
}

/**
 * Horizontal bars. Bars stay thin and every one carries its value in plain text,
 * so the chart is still readable in sunlight, in print, and to colorblind eyes.
 */
@Composable
private fun ChartCard(
    title: String,
    rows: List<ChartRow>,
    format: (Double) -> String,
    empty: String,
    color: Color? = null,
    colors: List<Color>? = null
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            val visible = rows.filter { it.value.isFinite() }
            val max = visible.maxOfOrNull { it.value } ?: 0.0
            if (visible.isEmpty() || max <= 0.0) {
                EmptyNote(empty)
            } else {
                visible.forEachIndexed { index, row ->
                    val fraction = (row.value / max).toFloat().let {
                        if (!it.isFinite() || it <= 0f) 0f else it.coerceIn(0.03f, 1f)
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text(row.label, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                format(row.value),
                                style = MaterialTheme.typography.bodyMedium,
                                fontWeight = FontWeight.Medium
                            )
                        }
                        Box(
                            Modifier.fillMaxWidth().height(10.dp)
                                .clip(RoundedCornerShape(4.dp))
                                .background(MaterialTheme.colorScheme.surfaceVariant)
                        ) {
                            if (fraction > 0f) {
                                Box(
                                    Modifier.fillMaxWidth(fraction).fillMaxHeight()
                                        .clip(RoundedCornerShape(4.dp))
                                        .background(colors?.getOrNull(index) ?: color ?: MoneyBlue)
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun EmptyNote(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal,
            modifier = Modifier.weight(1f)
        )
        Spacer(Modifier.width(8.dp))
        Text(value, fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium)
    }
}

package com.fenceestimator.app.ui.reports

import androidx.compose.foundation.background
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.data.ExpenseCategory
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.label
import com.fenceestimator.app.ui.components.labelRes
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
    val context = LocalContext.current
    // Crew sees the operation (collected, sales, hours, crew pay); profit,
    // margin and cost breakdowns are the money intelligence Pro is sold on.
    val ent = com.fenceestimator.app.ui.components.LocalEntitlements.current
    val viewModel: ReportsViewModel = viewModel(factory = GenericViewModelFactory { ReportsViewModel(app.repository, app.getString(R.string.rep_untitled)) })
    val preset by viewModel.preset.collectAsState()
    val from by viewModel.from.collectAsState()
    val to by viewModel.to.collectAsState()
    val hourFilter by viewModel.hourFilter.collectAsState()
    val data by viewModel.data.collectAsState()
    val totals = data.totals

    val currency = remember { NumberFormat.getCurrencyInstance(Locale.US) }
    val dayFormat = remember { java.text.SimpleDateFormat("d MMM yyyy", Locale.US) }
    // Which figure the reader has asked to see the working for.
    var showing by remember { mutableStateOf<StatDetail?>(null) }
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
                title = { Text(stringResource(R.string.reports_title)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
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
                                    label = { Text(p.label()) }
                                )
                            }
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = { pickingFrom = true }, modifier = Modifier.weight(1f)) {
                                Text(if (from == 0L) stringResource(R.string.rep_start) else dateFmt.format(from), maxLines = 1)
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
                                    label = { Text(h.label()) }
                                )
                            }
                        }
                        Text(
                            stringResource(R.string.rep_time_of_day_note),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            // ---- Headline numbers ----------------------------------------
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    BigStat(stringResource(R.string.reports_collected), currency.format(totals.collected), Modifier.weight(1f)) {
                        showing = StatDetails.collected(
                            context = context,
                            totals = totals,
                            payments = data.payments,
                            jobNameFor = { id -> data.jobNamesById[id] ?: context.getString(R.string.rep_untitled) },
                            money = { currency.format(it) },
                            date = { dayFormat.format(java.util.Date(it)) }
                        )
                    }
                    if (ent.advancedReports) {
                        BigStat(stringResource(R.string.rep_stat_profit), currency.format(totals.profit), Modifier.weight(1f)) {
                            showing = StatDetails.profit(context, totals) { currency.format(it) }
                        }
                    } else {
                        BigStat(stringResource(R.string.rep_stat_jobs_won), totals.jobsWon.toString(), Modifier.weight(1f)) {
                            showing = StatDetails.jobsWon(context, totals, data.wonJobNames)
                        }
                    }
                }
            }
            if (ent.advancedReports) item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    BigStat(stringResource(R.string.reports_margin), "${"%.0f".format(totals.marginPercent)}%", Modifier.weight(1f)) {
                        showing = StatDetails.margin(context, totals)
                    }
                    BigStat(stringResource(R.string.rep_stat_jobs_won), totals.jobsWon.toString(), Modifier.weight(1f)) {
                        showing = StatDetails.jobsWon(context, totals, data.wonJobNames)
                    }
                }
            }
            item {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                    BigStat(stringResource(R.string.rep_stat_close_rate), "${"%.0f".format(totals.closeRatePercent)}%", Modifier.weight(1f)) {
                        showing = StatDetails.closeRate(context, totals)
                    }
                    BigStat(stringResource(R.string.rep_stat_hours_clocked), "%.1f".format(totals.hoursClocked), Modifier.weight(1f)) {
                        showing = StatDetails.hoursClocked(context, totals) { currency.format(it) }
                    }
                }
            }

            // ---- Money ---------------------------------------------------
            item {
                CategoryHeader(stringResource(R.string.rep_cat_money), moneyOpen) { moneyOpen = !moneyOpen }
            }
            // Costs, expenses and the arithmetic table are the owner’s own
            // records, entered by their own company — gating them behind Pro
            // read as the app hiding their money. Pro keeps the intelligence:
            // profit and margin headline tiles, and the deeper web reports.
            if (moneyOpen) {
                item {
                    TrendCard(
                        title = stringResource(R.string.rep_chart_money_by_month),
                        rows = data.revenueByMonth,
                        format = { currency.format(it) },
                        empty = stringResource(R.string.rep_empty_nothing_paid),
                        onPick = {
                            showing = StatDetail(
                                title = context.getString(R.string.rep_chart_money_by_month),
                                value = currency.format(data.revenueByMonth.sumOf { it.value }),
                                howItWorks = context.getString(R.string.rep_how_month),
                                lines = data.revenueByMonth.reversed().map { row ->
                                    DetailLine(
                                        label = row.label,
                                        sublabel = context.getString(
                                            R.string.rep_payments_counted,
                                            data.payments.count { monthKeyOf(it.receivedAt) == row.key }
                                        ),
                                        amount = currency.format(row.value),
                                        isNegative = row.value < 0
                                    )
                                }
                            )
                        }
                    )
                }
                item {
                    // Collected is money IN; the other three are what it cost
                    // to earn it. As four bars on one scale they read as four
                    // slices of one quantity, which is not what any of them is.
                    SplitCard(
                        title = stringResource(R.string.rep_chart_where_money_goes),
                        inLabel = stringResource(R.string.reports_collected),
                        inValue = totals.collected,
                        costLabel = stringResource(R.string.rep_what_it_cost),
                        costParts = listOf(
                            stringResource(R.string.rep_row_material_cost) to totals.materialCost,
                            stringResource(R.string.rep_line_labor) to totals.laborCost,
                            stringResource(R.string.rep_line_other_expenses) to totals.otherExpenses
                        ),
                        format = { currency.format(it) },
                        empty = stringResource(R.string.rep_empty_no_money)
                    )
                }
                item {
                    DonutCard(
                        title = stringResource(R.string.rep_chart_expenses_by_category),
                        // Rows arrive keyed by enum name; show them in the
                        // user's language.
                        // The label gets translated for display; the enum name
                        // goes into key, because that is what the expense rows
                        // are stored against. Matching a drill-down on a
                        // translated string would work in English and quietly
                        // find nothing in any other language.
                        rows = data.expensesByCategory.map { row ->
                            runCatching { ExpenseCategory.valueOf(row.label) }.getOrNull()
                                ?.let {
                                    row.copy(
                                        label = context.getString(it.labelRes()),
                                        key = row.label
                                    )
                                }
                                ?: row.copy(key = row.label)
                        },
                        format = { currency.format(it) },
                        empty = stringResource(R.string.rep_empty_no_expenses),
                        onPick = { row ->
                            val total = data.expensesByCategory.sumOf { it.value }
                            val mine = data.expenseDetail.filter { it.category == row.key }
                            showing = StatDetail(
                                title = row.label,
                                value = currency.format(row.value),
                                howItWorks = context.getString(R.string.rep_how_expense_cat),
                                lines = mine.map { e ->
                                    DetailLine(
                                        label = e.description.ifBlank { row.label },
                                        sublabel = listOf(e.jobName, dayFormat.format(java.util.Date(e.date)))
                                            .filter { it.isNotBlank() }
                                            .joinToString(" · "),
                                        amount = currency.format(e.amount)
                                    )
                                },
                                caveat = context.getString(
                                    R.string.rep_share_of_total_caveat,
                                    if (total > 0) "%.0f%%".format(row.value / total * 100) else "0%",
                                    currency.format(total)
                                )
                            )
                        }
                    )
                }
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(stringResource(R.string.rep_the_numbers), style = MaterialTheme.typography.titleMedium)
                            ReportRow(stringResource(R.string.reports_collected), currency.format(totals.collected))
                            ReportRow(stringResource(R.string.rep_row_material_cost), currency.format(totals.materialCost))
                            ReportRow(stringResource(R.string.rep_row_labor_cost, "%.1f".format(totals.hoursClocked)), currency.format(totals.laborCost))
                            ReportRow(stringResource(R.string.rep_line_other_expenses), currency.format(totals.otherExpenses))
                            Divider(Modifier.padding(vertical = 6.dp))
                            ReportRow(stringResource(R.string.rep_stat_profit), currency.format(totals.profit), bold = true)
                            ReportRow(stringResource(R.string.rep_row_average_job), currency.format(totals.averageJob))
                            if (totals.tipsToInstallers > 0.0) {
                                ReportRow(stringResource(R.string.rep_row_tips), currency.format(totals.tipsToInstallers))
                            }
                        }
                    }
                }
            }

            // ---- Sales ---------------------------------------------------
            item {
                CategoryHeader(stringResource(R.string.rep_cat_sales), salesOpen) { salesOpen = !salesOpen }
            }
            if (salesOpen) {
                item {
                    FunnelCard(
                        title = stringResource(R.string.rep_chart_jobs_by_stage),
                        rows = data.jobsByStage,
                        format = { "%.0f".format(it) },
                        empty = stringResource(R.string.rep_empty_no_jobs),
                        onPick = { row ->
                            showing = StatDetail(
                                title = row.label,
                                value = "%.0f".format(row.value),
                                howItWorks = context.getString(R.string.rep_how_stage),
                                lines = data.stageDetail
                                    .filter { it.stage == row.label }
                                    .map { j ->
                                        DetailLine(
                                            label = j.jobName.ifBlank {
                                                context.getString(R.string.rep_untitled)
                                            },
                                            sublabel = j.address
                                        )
                                    }
                            )
                        }
                    )
                }
                item {
                    FunnelCard(
                        title = stringResource(R.string.rep_chart_quote_to_paid),
                        rows = data.funnel,
                        format = { "%.0f".format(it) },
                        empty = stringResource(R.string.rep_empty_no_jobs),
                        onPick = { row ->
                            val i = data.funnel.indexOfFirst { it.label == row.label }
                            val above = data.funnel.getOrNull(i - 1)
                            showing = StatDetail(
                                title = row.label,
                                value = "%.0f".format(row.value),
                                howItWorks = context.getString(R.string.rep_how_funnel),
                                lines = listOfNotNull(
                                    above?.let {
                                        DetailLine(
                                            label = it.label,
                                            amount = "%.0f".format(it.value)
                                        )
                                    },
                                    above?.let {
                                        DetailLine(
                                            label = context.getString(
                                                R.string.rep_of_step_above_line,
                                                if (it.value > 0) "%.0f%%".format(row.value / it.value * 100) else "0%"
                                            ),
                                            amount = "%.0f".format(row.value)
                                        )
                                    }
                                )
                            )
                        }
                    )
                }
                item {
                    ChartCard(
                        title = stringResource(R.string.rep_chart_lead_sources),
                        onPick = { row ->
                            showing = StatDetail(
                                title = row.label,
                                value = "%.0f".format(row.value),
                                howItWorks = context.getString(R.string.rep_how_lead)
                            )
                        },
                        rows = data.leadSources,
                        color = SalesGreen,
                        format = { "%.0f".format(it) },
                        empty = stringResource(R.string.rep_empty_no_referral)
                    )
                }
            }

            // ---- Work & crew ---------------------------------------------
            item {
                CategoryHeader(stringResource(R.string.rep_cat_work_crew), crewOpen) { crewOpen = !crewOpen }
            }
            if (crewOpen) {
                item {
                    ChartCard(
                        title = stringResource(R.string.rep_chart_hours_by_crew),
                        onPick = { row ->
                            val who = data.crewDetail.firstOrNull { it.name == row.label }
                            showing = StatDetail(
                                title = row.label,
                                value = "%.1f h".format(row.value),
                                howItWorks = context.getString(R.string.rep_how_crew_hours),
                                lines = listOfNotNull(
                                    who?.let {
                                        DetailLine(
                                            label = context.getString(R.string.rep_jobs_worked_line, it.jobs),
                                            amount = currency.format(it.cost)
                                        )
                                    },
                                    who?.let {
                                        DetailLine(
                                            label = context.getString(R.string.rep_average_rate_line),
                                            amount = currency.format(it.perHour)
                                        )
                                    }
                                )
                            )
                        },
                        rows = data.hoursByCrew,
                        color = CrewAmber,
                        format = { context.getString(R.string.rep_fmt_hrs, "%.1f".format(it)) },
                        empty = stringResource(R.string.rep_empty_no_clock_in)
                    )
                }
                item {
                    ChartCard(
                        title = stringResource(R.string.rep_chart_feet_by_type),
                        // Rows arrive keyed by enum name; show them in the
                        // user's language.
                        rows = data.fenceTypes.map { row ->
                            runCatching { FenceType.valueOf(row.label) }.getOrNull()
                                ?.let { row.copy(label = context.getString(it.labelRes())) }
                                ?: row
                        },
                        color = CrewAmber,
                        format = { context.getString(R.string.rep_fmt_ft, "%,.0f".format(it)) },
                        empty = stringResource(R.string.rep_empty_no_footage),
                        onPick = { row ->
                            showing = StatDetail(
                                title = row.label,
                                value = "%.0f".format(row.value),
                                howItWorks = context.getString(R.string.rep_how_fence_type)
                            )
                        }
                    )
                }
            }

            // ---- Detailed tables -----------------------------------------
            item {
                CategoryHeader(stringResource(R.string.rep_cat_tables), tablesOpen) { tablesOpen = !tablesOpen }
            }
            if (tablesOpen) {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(stringResource(R.string.rep_crew_pay), style = MaterialTheme.typography.titleMedium)
                            if (data.crewDetail.isEmpty()) {
                                EmptyNote(stringResource(R.string.rep_empty_no_clocked_time))
                            } else {
                                data.crewDetail.forEach { c ->
                                    ReportRow(
                                        stringResource(
                                            if (c.jobs == 1) R.string.rep_crew_row_one_job else R.string.rep_crew_row_jobs,
                                            c.name, c.jobs, "%.1f".format(c.hours)
                                        ),
                                        currency.format(c.cost)
                                    )
                                    Text(
                                        stringResource(R.string.rep_works_out_per_hr, currency.format(c.perHour)),
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
                            Text(stringResource(R.string.rep_still_owed), style = MaterialTheme.typography.titleMedium)
                            if (data.outstanding.isEmpty()) {
                                EmptyNote(stringResource(R.string.rep_empty_all_paid))
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
                            Text(stringResource(R.string.rep_clock_in_out), style = MaterialTheme.typography.titleMedium)
                            if (data.timeDetail.isEmpty()) {
                                EmptyNote(stringResource(R.string.rep_empty_no_shifts))
                            } else {
                                data.timeDetail.take(40).forEach { t ->
                                    ReportRow(
                                        "${t.job} — ${timeFmt.format(t.start)}",
                                        stringResource(R.string.rep_shift_hrs_cost, "%.1f".format(t.hours), currency.format(t.cost))
                                    )
                                }
                                if (data.timeDetail.size > 40) {
                                    EmptyNote(stringResource(R.string.rep_showing_recent_shifts, data.timeDetail.size))
                                }
                            }
                        }
                    }
                }
            }

            item {
                Text(
                    stringResource(R.string.rep_profit_footnote),
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

    showing?.let { detail ->
        StatDetailSheet(detail = detail, onDismiss = { showing = null })
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
            }) { Text(stringResource(R.string.rep_ok)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) } }
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
            contentDescription = if (open) stringResource(R.string.rep_collapse, title) else stringResource(R.string.rep_expand, title)
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
    colors: List<Color>? = null,
    /** Given a row, what to show when somebody asks where it came from. */
    onPick: ((ChartRow) -> Unit)? = null
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            val visible = rows.filter { it.value.isFinite() }
            val max = visible.maxOfOrNull { it.value } ?: 0.0
            if (visible.isEmpty() || max <= 0.0) {
                EmptyNote(empty)
            } else {
                if (onPick != null) TapHint()
                visible.forEachIndexed { index, row ->
                    val fraction = (row.value / max).toFloat().let {
                        if (!it.isFinite() || it <= 0f) 0f else it.coerceIn(0.03f, 1f)
                    }
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .then(
                                if (onPick != null) Modifier.clickable { onPick(row) }
                                else Modifier
                            ),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
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

/* ---- More than one shape, on the phone too -------------------------------
   Every panel on this screen was the same labelled progress bar. A bar answers
   "how do these compare"; it is the wrong answer for a trend, for a
   composition, and for a sequence that loses work at each step. The web
   dashboard grew four shapes for those jobs and this is the same set, so the
   two tell the same story in the same language. */

/** Money over time. A trend is a line: separate bars break the continuity
 *  that is the whole point of putting it on a time axis. */
@Composable
private fun TrendCard(
    title: String,
    rows: List<ChartRow>,
    format: (Double) -> String,
    empty: String,
    color: Color = MoneyBlue,
    /** The whole card, not a point: a 4px dot is not a tap target. */
    onPick: (() -> Unit)? = null
) {
    Card(
        onClick = onPick ?: {},
        modifier = Modifier.fillMaxWidth(),
        enabled = onPick != null
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            val pts = rows.filter { it.value.isFinite() }
            if (pts.size < 2 || pts.all { it.value == 0.0 }) {
                EmptyNote(empty)
                return@Column
            }
            // The figure people came for is the latest one, so it is the one
            // spelled out. A number on every point is noise, not information.
            Text(
                format(pts.last().value),
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )
            val maxV = pts.maxOf { it.value }
            val minV = minOf(0.0, pts.minOf { it.value })
            val span = (maxV - minV).takeIf { it > 0.0 } ?: 1.0
            val grid = MaterialTheme.colorScheme.surfaceVariant

            Canvas(Modifier.fillMaxWidth().height(120.dp)) {
                val w = size.width
                val h = size.height
                val stepX = if (pts.size == 1) 0f else w / (pts.size - 1)
                fun yOf(v: Double) = (h - ((v - minV) / span) * h).toFloat()

                drawLine(grid, Offset(0f, h), Offset(w, h), strokeWidth = 1f)

                val line = Path()
                pts.forEachIndexed { i, p ->
                    val x = stepX * i
                    if (i == 0) line.moveTo(x, yOf(p.value)) else line.lineTo(x, yOf(p.value))
                }
                val area = Path().apply {
                    addPath(line)
                    lineTo(stepX * (pts.size - 1), h)
                    lineTo(0f, h)
                    close()
                }
                drawPath(
                    area,
                    Brush.verticalGradient(
                        listOf(color.copy(alpha = 0.22f), color.copy(alpha = 0f))
                    )
                )
                drawPath(line, color, style = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round))
                pts.forEachIndexed { i, p ->
                    drawCircle(color, radius = 3.dp.toPx(), center = Offset(stepX * i, yOf(p.value)))
                }
            }
            if (onPick != null) TapHint()
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(
                    pts.first().label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    pts.last().label,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

/** What came in, against what it cost to earn it.
 *
 *  These were four bars on one scale, which reads as four slices of one
 *  quantity. Income and outgoings are not that, and drawing them as though
 *  they were invited exactly the wrong comparison. */
@Composable
private fun SplitCard(
    title: String,
    inLabel: String,
    inValue: Double,
    costParts: List<Pair<String, Double>>,
    costLabel: String,
    format: (Double) -> String,
    empty: String
) {
    val costTotal = costParts.sumOf { it.second }
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            if (inValue <= 0.0 && costTotal <= 0.0) {
                EmptyNote(empty)
                return@Column
            }
            val top = maxOf(inValue, costTotal, 1.0)
            val palette = listOf(MoneyBlue, CostOrange, CrewAmber, SalesGreen)

            Row(
                Modifier.fillMaxWidth().height(150.dp),
                horizontalArrangement = Arrangement.spacedBy(28.dp),
                verticalAlignment = Alignment.Bottom
            ) {
                // Money in.
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.Bottom) {
                    Text(
                        format(inValue),
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(Modifier.height(4.dp))
                    Box(
                        Modifier.fillMaxWidth()
                            .fillMaxHeight((inValue / top).toFloat().coerceIn(0.02f, 1f))
                            .clip(RoundedCornerShape(4.dp))
                            .background(SalesGreen)
                    )
                }
                // What it cost, stacked.
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.Bottom) {
                    Text(
                        format(costTotal),
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Spacer(Modifier.height(4.dp))
                    Column(
                        Modifier.fillMaxWidth()
                            .fillMaxHeight((costTotal / top).toFloat().coerceIn(0.02f, 1f)),
                        // A hairline of surface between segments, so two
                        // similar amounts still read as two.
                        verticalArrangement = Arrangement.spacedBy(2.dp)
                    ) {
                        costParts.filter { it.second > 0.0 }.forEachIndexed { i, part ->
                            Box(
                                Modifier.fillMaxWidth()
                                    .weight(part.second.toFloat())
                                    .clip(RoundedCornerShape(3.dp))
                                    .background(palette[i % palette.size])
                            )
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(28.dp)) {
                Text(
                    inLabel, Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    costLabel, Modifier.weight(1f),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                LegendRow(SalesGreen, inLabel, format(inValue))
                costParts.filter { it.second > 0.0 }.forEachIndexed { i, part ->
                    LegendRow(palette[i % palette.size], part.first, format(part.second))
                }
            }
        }
    }
}

/** Parts of one whole, with the whole named in the middle. */
@Composable
private fun DonutCard(
    title: String,
    rows: List<ChartRow>,
    format: (Double) -> String,
    empty: String,
    onPick: ((ChartRow) -> Unit)? = null
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            val live = rows.filter { it.value.isFinite() && it.value > 0.0 }
            if (live.isEmpty()) {
                EmptyNote(empty)
                return@Column
            }
            val total = live.sumOf { it.value }
            val palette = listOf(MoneyBlue, CostOrange, SalesGreen, CrewAmber)

            Box(Modifier.fillMaxWidth().height(170.dp), contentAlignment = Alignment.Center) {
                Canvas(Modifier.fillMaxHeight()) {
                    val ring = 26.dp.toPx()
                    val d = minOf(size.width, size.height) - ring
                    val topLeft = Offset((size.width - d) / 2f, (size.height - d) / 2f)
                    var start = -90f
                    live.forEachIndexed { i, r ->
                        val sweep = (r.value / total * 360.0).toFloat()
                        // Two degrees of surface between neighbours, so
                        // similar values remain countable.
                        val gap = if (live.size > 1) 1.2f else 0f
                        drawArc(
                            color = palette[i % palette.size],
                            startAngle = start + gap,
                            sweepAngle = (sweep - gap * 2).coerceAtLeast(0.5f),
                            useCenter = false,
                            topLeft = topLeft,
                            size = Size(d, d),
                            style = Stroke(width = ring, cap = StrokeCap.Butt)
                        )
                        start += sweep
                    }
                }
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        format(total),
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        stringResource(R.string.rep_total),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            if (onPick != null) TapHint()
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                live.forEachIndexed { i, r ->
                    LegendRow(
                        palette[i % palette.size], r.label, format(r.value),
                        onClick = onPick?.let { pick -> { pick(r) } }
                    )
                }
            }
        }
    }
}

/** A sequence that loses work at each step. The drop IS the information, so it
 *  is stated between the steps rather than left to be judged by eye from two
 *  bar lengths. */
@Composable
private fun FunnelCard(
    title: String,
    rows: List<ChartRow>,
    format: (Double) -> String,
    empty: String,
    onPick: ((ChartRow) -> Unit)? = null
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            val live = rows.filter { it.value.isFinite() && it.value > 0.0 }
            if (live.size < 2) {
                EmptyNote(empty)
                return@Column
            }
            if (onPick != null) TapHint()
            val top = live.first().value
            live.forEachIndexed { i, r ->
                Column(
                    Modifier
                        .fillMaxWidth()
                        .then(if (onPick != null) Modifier.clickable { onPick(r) } else Modifier),
                    verticalArrangement = Arrangement.spacedBy(3.dp)
                ) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(r.label, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            format(r.value),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium
                        )
                    }
                    Box(
                        Modifier.fillMaxWidth().height(12.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .background(MaterialTheme.colorScheme.surfaceVariant)
                    ) {
                        Box(
                            Modifier
                                .fillMaxWidth((r.value / top).toFloat().coerceIn(0.02f, 1f))
                                .fillMaxHeight()
                                .clip(RoundedCornerShape(4.dp))
                                // One hue getting stronger down the funnel:
                                // these are stages of one thing, and four
                                // separate hues would claim they were four
                                // different things. Floored so the widest bar,
                                // which carries the total, is not washed out.
                                .background(
                                    MoneyBlue.copy(
                                        alpha = listOf(0.45f, 0.59f, 0.72f, 0.86f, 1f)
                                            .getOrElse(i) { 1f }
                                    )
                                )
                        )
                    }
                    if (i > 0) {
                        val prev = live[i - 1].value
                        Text(
                            stringResource(
                                R.string.rep_pct_of_step_above,
                                if (prev > 0) "%.0f".format(r.value / prev * 100) else "0"
                            ),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun LegendRow(
    color: Color,
    label: String,
    value: String,
    onClick: (() -> Unit)? = null
) {
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable { onClick() } else Modifier),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(10.dp).clip(RoundedCornerShape(3.dp)).background(color))
        Spacer(Modifier.width(8.dp))
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium
        )
    }
}

/** Says the numbers can be asked. Without it nobody discovers they can --
 *  a tappable figure that looks exactly like an untappable one is not a
 *  feature, it is a secret. */
/** The same year-month key the revenue chart buckets by, so a drill-down
 *  cannot pick up the other August. */
private fun monthKeyOf(millis: Long): String {
    val cal = java.util.Calendar.getInstance()
    cal.timeInMillis = millis
    return "${cal.get(java.util.Calendar.YEAR)}-" +
        String.format("%02d", cal.get(java.util.Calendar.MONTH) + 1)
}

@Composable
private fun TapHint() {
    Text(
        stringResource(R.string.rep_tap_for_detail),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}

@Composable
private fun EmptyNote(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun BigStat(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null
) {
    Card(
        modifier = modifier,
        onClick = onClick ?: {},
        enabled = onClick != null,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSecondaryContainer)
            Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSecondaryContainer)
            if (onClick != null) {
                Text(
                    stringResource(R.string.rep_tap_for_detail),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSecondaryContainer
                )
            }
        }
    }
}

/**
 * What a figure is made of, and how it was worked out.
 *
 * A number on its own can only be believed or disbelieved. Someone who thinks
 * a total looks wrong needs to be able to find out why without asking anybody,
 * and a report that can show its working is one people stop double-checking in
 * a spreadsheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun StatDetailSheet(detail: StatDetail, onDismiss: () -> Unit) {
    // A full-height sheet rather than a small dialog.
    //
    // Asked for as "a page like the tables underneath", and rightly: a
    // dialog that scrolls three rows at a time is not somewhere you read a
    // statement. This is the same rows-and-columns shape as the tables lower
    // down the reports screen, so it reads as part of the same report.
    androidx.compose.material3.BasicAlertDialog(
        onDismissRequest = onDismiss,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false)
    ) {
      androidx.compose.material3.Surface(
        modifier = Modifier.fillMaxWidth().fillMaxHeight(0.92f),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface
      ) {
        Column(Modifier.padding(16.dp)) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(detail.title, style = MaterialTheme.typography.titleMedium)
                    Text(
                        detail.value,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.Bold
                    )
                }
                TextButton(onClick = onDismiss) { Text(stringResource(R.string.rep_close)) }
            }
            Spacer(Modifier.height(8.dp))
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item {
                    Text(detail.howItWorks, style = MaterialTheme.typography.bodyMedium)
                }
                detail.caveat?.let { caveat ->
                    item {
                        Card(
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.tertiaryContainer
                            )
                        ) {
                            Text(
                                caveat,
                                Modifier.padding(10.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onTertiaryContainer
                            )
                        }
                    }
                }
                if (detail.lines.isNotEmpty()) {
                    item { Divider() }
                    item {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Text(
                                stringResource(R.string.rep_col_what_when),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Text(
                                stringResource(R.string.rep_col_amount),
                                style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    items(detail.lines) { line ->
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(line.label, style = MaterialTheme.typography.bodyMedium)
                                if (line.sublabel.isNotBlank()) {
                                    Text(
                                        line.sublabel,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                            if (line.amount.isNotBlank()) {
                                Text(
                                    (if (line.isNegative) "-" else "") + line.amount,
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = FontWeight.Medium,
                                    color = if (line.isNegative) MaterialTheme.colorScheme.error
                                    else MaterialTheme.colorScheme.onSurface
                                )
                            }
                        }
                    }
                }
            }
        }
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

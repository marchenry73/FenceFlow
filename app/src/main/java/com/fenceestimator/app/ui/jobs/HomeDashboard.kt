package com.fenceestimator.app.ui.jobs

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Event
import androidx.compose.material.icons.filled.PriorityHigh
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.fenceestimator.app.R
import com.fenceestimator.app.data.FieldChange
import com.fenceestimator.app.data.HomeCard
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentRecord
import com.fenceestimator.app.ui.components.label
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.isWon
import com.fenceestimator.app.estimate.JobSchedule
import com.fenceestimator.app.estimate.LocateTicket
import com.fenceestimator.app.ui.theme.Graphite20
import com.fenceestimator.app.ui.theme.Graphite40
import com.fenceestimator.app.ui.theme.SafetyOrange80
import com.fenceestimator.app.ui.theme.SteelTeal80
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * The top of the home screen: who you are, the one number that matters, what
 * needs you, what is coming, and the figures you chose to watch.
 *
 * It replaces a grid of identical tiles. A grid answers "what are the
 * numbers"; a contractor opening the app at 6am is asking "what do I have to
 * deal with today", and that question has an order: the money position,
 * then anything on fire, then the week, then the rest. Everything here is
 * computed from data the screen already had -- nothing new is fetched.
 */
@Composable
fun HomeDashboard(
    ownerName: String,
    jobs: List<Job>,
    payments: List<PaymentRecord>,
    pendingHours: Int,
    pendingPlanChanges: List<FieldChange>,
    outstanding: Double,
    cards: List<HomeCard>,
    showMoney: Boolean,
    workdayHours: Double,
    onOpenJob: (Long) -> Unit,
    onOpenSchedule: () -> Unit,
    onOpenPipeline: () -> Unit,
    onOpenReports: () -> Unit,
    onOpenTimeApproval: () -> Unit
) {
    val currency = remember { NumberFormat.getCurrencyInstance(Locale.US) }
    val now = System.currentTimeMillis()
    val monthStart = remember(now / 3_600_000L) { startOfMonth(0) }
    val lastMonthStart = remember(now / 3_600_000L) { startOfMonth(-1) }

    val collectedThisMonth = remember(payments, monthStart) {
        payments.filter { it.receivedAt >= monthStart }.sumOf { it.amount }
    }
    val collectedLastMonth = remember(payments, monthStart, lastMonthStart) {
        payments.filter { it.receivedAt >= lastMonthStart && it.receivedAt < monthStart }.sumOf { it.amount }
    }

    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        GreetingRow(ownerName)

        if (showMoney) {
            MoneyHero(
                outstanding = outstanding,
                collectedThisMonth = collectedThisMonth,
                collectedLastMonth = collectedLastMonth,
                weekly = remember(payments) { weeklyCollected(payments, weeks = 8) },
                currency = currency,
                onClick = onOpenReports
            )
        } else {
            ScheduleHero(jobs = jobs, onClick = onOpenSchedule)
        }

        // Built with plain getString rather than stringResource, because it
        // runs inside remember() -- a non-composable scope.
        val context = androidx.compose.ui.platform.LocalContext.current
        val attention = remember(jobs, pendingHours, pendingPlanChanges, showMoney, workdayHours) {
            attentionItems(context, jobs, pendingHours, pendingPlanChanges, showMoney, workdayHours)
        }
        AttentionCard(attention, onOpenJob, onOpenTimeApproval)

        ThisWeek(jobs, onOpenJob, onOpenSchedule)

        StatTiles(
            jobs = jobs, cards = cards, showMoney = showMoney, workdayHours = workdayHours,
            pendingHours = pendingHours, outstanding = outstanding,
            collectedThisMonth = collectedThisMonth, collectedLastMonth = collectedLastMonth,
            monthStart = monthStart, lastMonthStart = lastMonthStart, currency = currency,
            onOpenSchedule = onOpenSchedule, onOpenPipeline = onOpenPipeline,
            onOpenReports = onOpenReports, onOpenTimeApproval = onOpenTimeApproval
        )
    }
}

// ---- Greeting -------------------------------------------------------------

@Composable
private fun GreetingRow(ownerName: String) {
    val hour = remember { Calendar.getInstance().get(Calendar.HOUR_OF_DAY) }
    val first = ownerName.trim().substringBefore(' ')
    val greeting = when {
        hour < 12 -> if (first.isBlank()) stringResource(R.string.home_good_morning)
                     else stringResource(R.string.home_good_morning_named, first)
        hour < 17 -> if (first.isBlank()) stringResource(R.string.home_good_afternoon)
                     else stringResource(R.string.home_good_afternoon_named, first)
        else      -> if (first.isBlank()) stringResource(R.string.home_good_evening)
                     else stringResource(R.string.home_good_evening_named, first)
    }
    // The device language for the day name, so a Spanish phone reads
    // "sábado" without the app having to know every weekday in every tongue.
    val dateLine = remember { SimpleDateFormat("EEEE, MMM d", Locale.getDefault()).format(Date()) }
    Column {
        Text(greeting, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(
            dateLine.replaceFirstChar { it.uppercase() },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

// ---- Hero -----------------------------------------------------------------

/**
 * The money position, as one card: what is owed to you, what came in this
 * month against last, and the shape of the last eight weeks. Dark on purpose
 * whatever the theme -- it is the one place on the screen that carries colour,
 * and a single strong block reads as "this is the number" in a way a tinted
 * tile never does.
 */
@Composable
private fun MoneyHero(
    outstanding: Double,
    collectedThisMonth: Double,
    collectedLastMonth: Double,
    weekly: List<Double>,
    currency: NumberFormat,
    onClick: () -> Unit
) {
    val delta = collectedThisMonth - collectedLastMonth
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(Brush.linearGradient(listOf(Graphite40, Graphite20)))
            .clickable(onClick = onClick)
            .padding(20.dp)
    ) {
        Column {
            Text(
                stringResource(R.string.home_still_owed).uppercase(),
                color = Color.White.copy(alpha = 0.7f),
                style = MaterialTheme.typography.labelMedium,
                letterSpacing = 1.2.sp
            )
            Text(
                currency.format(outstanding),
                color = Color.White,
                fontSize = 38.sp,
                fontWeight = FontWeight.Bold,
                lineHeight = 44.sp
            )
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(
                        stringResource(R.string.home_collected_this_month),
                        color = Color.White.copy(alpha = 0.7f),
                        style = MaterialTheme.typography.labelMedium
                    )
                    Text(
                        currency.format(collectedThisMonth),
                        color = Color.White,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        (if (delta >= 0) "▲ " else "▼ ") +
                            stringResource(R.string.home_vs_last_month, currency.format(kotlin.math.abs(delta))),
                        color = if (delta >= 0) SteelTeal80 else SafetyOrange80,
                        style = MaterialTheme.typography.bodySmall
                    )
                }
                Sparkline(
                    values = weekly,
                    modifier = Modifier.size(width = 120.dp, height = 44.dp)
                )
            }
        }
    }
}

/** The same card for someone who cannot see money: the week, and what is next. */
@Composable
private fun ScheduleHero(jobs: List<Job>, onClick: () -> Unit) {
    val now = System.currentTimeMillis()
    val weekEnd = now + 7L * 24 * 60 * 60 * 1000
    val booked = jobs.count { it.scheduledDate != null && it.scheduledDate in now..weekEnd }
    val next = jobs.filter { (it.scheduledDate ?: 0L) >= startOfToday() }.minByOrNull { it.scheduledDate ?: Long.MAX_VALUE }
    Box(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(24.dp))
            .background(Brush.linearGradient(listOf(Graphite40, Graphite20)))
            .clickable(onClick = onClick)
            .padding(20.dp)
    ) {
        Column {
            Text(
                stringResource(R.string.home_booked_this_week).uppercase(),
                color = Color.White.copy(alpha = 0.7f),
                style = MaterialTheme.typography.labelMedium,
                letterSpacing = 1.2.sp
            )
            Text(booked.toString(), color = Color.White, fontSize = 38.sp, fontWeight = FontWeight.Bold, lineHeight = 44.sp)
            if (next != null) {
                Spacer(Modifier.height(6.dp))
                Text(
                    stringResource(R.string.home_next_up, next.customerName.ifBlank { next.address }),
                    color = Color.White.copy(alpha = 0.85f),
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis
                )
            }
        }
    }
}

/** Eight weekly bars' worth of collected money as a line, newest on the right. */
@Composable
private fun Sparkline(values: List<Double>, modifier: Modifier = Modifier) {
    if (values.size < 2) return
    val max = values.maxOrNull()?.takeIf { it > 0 } ?: return
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        val stepX = w / (values.size - 1)
        val line = Path()
        val fill = Path()
        values.forEachIndexed { i, v ->
            val x = i * stepX
            val y = h - (v / max * (h - 4f)).toFloat() - 2f
            if (i == 0) { line.moveTo(x, y); fill.moveTo(x, h); fill.lineTo(x, y) }
            else { line.lineTo(x, y); fill.lineTo(x, y) }
        }
        fill.lineTo(w, h); fill.close()
        drawPath(fill, Brush.verticalGradient(listOf(SafetyOrange80.copy(alpha = 0.35f), Color.Transparent)))
        drawPath(line, SafetyOrange80, style = Stroke(width = 2.5f))
        // The latest point, emphasised: the eye goes to "now".
        val lastX = w
        val lastY = h - (values.last() / max * (h - 4f)).toFloat() - 2f
        drawCircle(SafetyOrange80, radius = 3.5f, center = androidx.compose.ui.geometry.Offset(lastX, lastY))
    }
}

// ---- Needs attention ------------------------------------------------------

private data class Attention(
    val icon: ImageVector,
    val title: String,
    val jobId: Long?,          // null means "go to the approvals queue"
    val urgent: Boolean
)

/**
 * Everything that is waiting on a person, in the order it costs money.
 *
 * Built from the lists the screen already holds; no extra queries. Each line
 * opens the thing itself rather than a report about it.
 */
private fun attentionItems(
    context: android.content.Context,
    jobs: List<Job>,
    pendingHours: Int,
    pendingPlanChanges: List<FieldChange>,
    showMoney: Boolean,
    workdayHours: Double
): List<Attention> {
    val out = mutableListOf<Attention>()
    val byId = jobs.associateBy { it.id }
    fun s(id: Int, vararg args: Any) = context.getString(id, *args)
    fun name(j: Job) = j.customerName.ifBlank { j.address.ifBlank { s(R.string.home_untitled_job) } }

    jobs.filter { JobSchedule.hasOverrun(it, workdayHours) }.forEach {
        out += Attention(Icons.Filled.PriorityHigh, s(R.string.home_running_late, name(it)), it.id, urgent = true)
    }
    if (pendingHours > 0) {
        out += Attention(Icons.Filled.Event, s(R.string.home_shifts_to_approve, pendingHours), null, urgent = false)
    }
    pendingPlanChanges
        .filter { it.isRequest && it.approvedAt == null && it.rejectedAt == null }
        .mapNotNull { byId[it.jobId] }.distinctBy { it.id }.forEach {
            out += Attention(Icons.Filled.PriorityHigh, s(R.string.home_plan_change, name(it)), it.id, urgent = true)
        }
    jobs.filter { LocateTicket.stateOf(it) == LocateTicket.State.EXPIRED }.forEach {
        out += Attention(Icons.Filled.PriorityHigh, s(R.string.home_locate_expired, name(it)), it.id, urgent = true)
    }
    if (showMoney) {
        jobs.filter { it.status == JobStatus.COMPLETED && it.paymentStatus != PaymentStatus.PAID_IN_FULL }.forEach {
            out += Attention(Icons.Filled.Event, s(R.string.home_finished_unpaid, name(it)), it.id, urgent = false)
        }
    }
    val weekAgo = System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000
    jobs.filter { it.status == JobStatus.DRAFT && it.updatedAt < weekAgo }.forEach {
        out += Attention(Icons.Filled.Event, s(R.string.home_stale_draft, name(it)), it.id, urgent = false)
    }
    return out
}

@Composable
private fun AttentionCard(items: List<Attention>, onOpenJob: (Long) -> Unit, onOpenTimeApproval: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(vertical = 10.dp)) {
            SectionTitle(stringResource(R.string.home_needs_attention))
            if (items.isEmpty()) {
                Text(
                    stringResource(R.string.home_all_clear),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                )
            } else {
                val shown = items.take(6)
                shown.forEach { a ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clickable { if (a.jobId != null) onOpenJob(a.jobId) else onOpenTimeApproval() }
                            .padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            Modifier
                                .size(30.dp)
                                .clip(RoundedCornerShape(10.dp))
                                .background(
                                    if (a.urgent) MaterialTheme.colorScheme.errorContainer
                                    else MaterialTheme.colorScheme.secondaryContainer
                                ),
                            contentAlignment = Alignment.Center
                        ) {
                            Icon(
                                a.icon, contentDescription = null,
                                tint = if (a.urgent) MaterialTheme.colorScheme.onErrorContainer
                                       else MaterialTheme.colorScheme.onSecondaryContainer,
                                modifier = Modifier.size(16.dp)
                            )
                        }
                        Spacer(Modifier.size(12.dp))
                        Text(
                            a.title, style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis
                        )
                        Icon(Icons.Filled.ChevronRight, contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (items.size > shown.size) {
                    Text(
                        stringResource(R.string.home_and_more, items.size - shown.size),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp)
                    )
                }
            }
        }
    }
}

// ---- This week ------------------------------------------------------------

@Composable
private fun ThisWeek(jobs: List<Job>, onOpenJob: (Long) -> Unit, onOpenSchedule: () -> Unit) {
    val today = startOfToday()
    val upcoming = remember(jobs) {
        jobs.filter { (it.scheduledDate ?: 0L) >= today }
            .sortedBy { it.scheduledDate }
            .take(3)
    }
    if (upcoming.isEmpty()) return
    val dayFmt = remember { SimpleDateFormat("EEE d", Locale.getDefault()) }
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(Modifier.padding(vertical = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                SectionTitle(stringResource(R.string.home_this_week), modifier = Modifier.weight(1f))
                TextButton(onClick = onOpenSchedule) { Text(stringResource(R.string.home_see_schedule)) }
            }
            upcoming.forEach { job ->
                Row(
                    Modifier.fillMaxWidth().clickable { onOpenJob(job.id) }
                        .padding(horizontal = 16.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Surface(
                        shape = RoundedCornerShape(10.dp),
                        color = MaterialTheme.colorScheme.primaryContainer
                    ) {
                        Text(
                            dayFmt.format(Date(job.scheduledDate ?: today)).replaceFirstChar { it.uppercase() },
                            style = MaterialTheme.typography.labelLarge,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)
                        )
                    }
                    Spacer(Modifier.size(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            job.customerName.ifBlank { stringResource(R.string.home_untitled_job) },
                            style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium,
                            maxLines = 1, overflow = TextOverflow.Ellipsis
                        )
                        if (job.address.isNotBlank()) {
                            Text(job.address, style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    Icon(Icons.Filled.ChevronRight, contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

// ---- Stat tiles -----------------------------------------------------------

@Composable
private fun StatTiles(
    jobs: List<Job>,
    cards: List<HomeCard>,
    showMoney: Boolean,
    workdayHours: Double,
    pendingHours: Int,
    outstanding: Double,
    collectedThisMonth: Double,
    collectedLastMonth: Double,
    monthStart: Long,
    lastMonthStart: Long,
    currency: NumberFormat,
    onOpenSchedule: () -> Unit,
    onOpenPipeline: () -> Unit,
    onOpenReports: () -> Unit,
    onOpenTimeApproval: () -> Unit
) {
    val now = System.currentTimeMillis()
    val weekEnd = now + 7L * 24 * 60 * 60 * 1000
    val wonThisMonth = jobs.count { it.status.isWon && (it.scheduledDate ?: it.createdAt) >= monthStart }
    val wonLastMonth = jobs.count {
        it.status.isWon && (it.scheduledDate ?: it.createdAt).let { d -> d >= lastMonthStart && d < monthStart }
    }

    fun valueFor(card: HomeCard): String = when (card) {
        HomeCard.SCHEDULED_THIS_WEEK -> jobs.count { it.scheduledDate != null && it.scheduledDate in now..weekEnd }.toString()
        HomeCard.WON_THIS_MONTH -> wonThisMonth.toString()
        HomeCard.COLLECTED_THIS_MONTH -> currency.format(collectedThisMonth)
        HomeCard.OUTSTANDING -> currency.format(outstanding)
        HomeCard.UNPAID_JOBS -> jobs.count { it.status.isWon && it.paymentStatus != PaymentStatus.PAID_IN_FULL }.toString()
        HomeCard.HOURS_TO_APPROVE -> pendingHours.toString()
        HomeCard.DRAFT_ESTIMATES -> jobs.count { it.status == JobStatus.DRAFT }.toString()
        HomeCard.OVERRUNNING -> jobs.count { JobSchedule.hasOverrun(it, workdayHours) }.toString()
    }

    val context = androidx.compose.ui.platform.LocalContext.current
    fun captionFor(card: HomeCard): String? = when (card) {
        HomeCard.WON_THIS_MONTH -> context.getString(R.string.home_last_month, wonLastMonth.toString())
        HomeCard.COLLECTED_THIS_MONTH -> context.getString(R.string.home_last_month, currency.format(collectedLastMonth))
        else -> null
    }

    fun destinationFor(card: HomeCard): () -> Unit = when (card) {
        HomeCard.SCHEDULED_THIS_WEEK, HomeCard.OVERRUNNING -> onOpenSchedule
        HomeCard.COLLECTED_THIS_MONTH, HomeCard.OUTSTANDING -> onOpenReports
        HomeCard.HOURS_TO_APPROVE -> onOpenTimeApproval
        else -> onOpenPipeline
    }

    // Money cards are dropped rather than blanked for anyone without permission
    // to see money -- an empty card labelled "Collected" still tells them there
    // is money to know about.
    val visible = cards.filter { showMoney || !it.needsMoney }
    if (visible.isEmpty()) return

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        visible.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                pair.forEach { card ->
                    StatTile(
                        label = card.label(),
                        value = valueFor(card),
                        caption = captionFor(card),
                        modifier = Modifier.weight(1f),
                        onClick = destinationFor(card)
                    )
                }
                if (pair.size == 1) Box(Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun StatTile(
    label: String,
    value: String,
    caption: String?,
    modifier: Modifier = Modifier,
    onClick: () -> Unit
) {
    Surface(
        shape = RoundedCornerShape(18.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        modifier = modifier.clickable(onClick = onClick)
    ) {
        Column(Modifier.padding(14.dp)) {
            Text(
                label, style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis
            )
            Spacer(Modifier.height(4.dp))
            Text(value, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (caption != null) {
                Text(caption, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

// ---- Shared bits ----------------------------------------------------------

@Composable
private fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = MaterialTheme.typography.titleMedium,
        fontWeight = FontWeight.Bold,
        modifier = modifier.padding(horizontal = 16.dp, vertical = 6.dp)
    )
}

private fun startOfToday(): Long = Calendar.getInstance().apply {
    set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
}.timeInMillis

private fun startOfMonth(offsetMonths: Int): Long = Calendar.getInstance().apply {
    add(Calendar.MONTH, offsetMonths)
    set(Calendar.DAY_OF_MONTH, 1); set(Calendar.HOUR_OF_DAY, 0)
    set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
}.timeInMillis

/** Net collected per week for the last [weeks] weeks, oldest first. */
private fun weeklyCollected(payments: List<PaymentRecord>, weeks: Int): List<Double> {
    val weekMs = 7L * 24 * 60 * 60 * 1000
    val end = System.currentTimeMillis()
    val start = end - weeks * weekMs
    val buckets = DoubleArray(weeks)
    payments.forEach { p ->
        if (p.receivedAt in start..end) {
            val idx = ((p.receivedAt - start) / weekMs).toInt().coerceIn(0, weeks - 1)
            buckets[idx] += p.amount
        }
    }
    return buckets.map { it.coerceAtLeast(0.0) }
}

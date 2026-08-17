package com.fenceestimator.app.ui.reports

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.Expense
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.PaymentRecord
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.TimeEntry
import com.fenceestimator.app.data.isWon
import com.fenceestimator.app.geometry.FenceCodec
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import java.util.Calendar

/** Quick ranges. CUSTOM means the user picked explicit dates. */
enum class ReportPreset(val label: String, val days: Int) {
    WEEK("7 days", 7),
    MONTH("30 days", 30),
    QUARTER("90 days", 90),
    YEAR("12 months", 365),
    ALL("All time", 0),
    CUSTOM("Custom", -1)
}

/** Restricts time entries by when the shift started. */
enum class HourFilter(val label: String) {
    ALL("All hours"),
    EARLY("Before 8am"),
    WORK("8am - 5pm"),
    LATE("After 5pm");

    fun matches(startedAt: Long): Boolean {
        if (this == ALL) return true
        val hour = Calendar.getInstance().apply { timeInMillis = startedAt }.get(Calendar.HOUR_OF_DAY)
        return when (this) {
            EARLY -> hour < 8
            WORK -> hour in 8..16
            LATE -> hour >= 17
            ALL -> true
        }
    }
}

/** One row of a bar chart: a name and a magnitude. */
data class ChartRow(val label: String, val value: Double)

data class ReportTotals(
    val collected: Double = 0.0,
    val materialCost: Double = 0.0,
    val laborCost: Double = 0.0,
    val otherExpenses: Double = 0.0,
    val jobsWon: Int = 0,
    val quotesSent: Int = 0,
    val hoursClocked: Double = 0.0,
    val tipsToInstallers: Double = 0.0
) {
    val profit: Double get() = collected - materialCost - laborCost - otherExpenses
    val marginPercent: Double get() = if (collected > 0) profit / collected * 100 else 0.0
    val closeRatePercent: Double get() = if (quotesSent > 0) jobsWon.toDouble() / quotesSent * 100 else 0.0
    val averageJob: Double get() = if (jobsWon > 0) collected / jobsWon else 0.0
}

data class ReportData(
    val totals: ReportTotals = ReportTotals(),
    val revenueByMonth: List<ChartRow> = emptyList(),
    val costBreakdown: List<ChartRow> = emptyList(),
    val expensesByCategory: List<ChartRow> = emptyList(),
    val jobsByStage: List<ChartRow> = emptyList(),
    val funnel: List<ChartRow> = emptyList(),
    val leadSources: List<ChartRow> = emptyList(),
    val hoursByCrew: List<ChartRow> = emptyList(),
    val fenceTypes: List<ChartRow> = emptyList(),
    val crewDetail: List<CrewRow> = emptyList(),
    val outstanding: List<OwedRow> = emptyList(),
    val timeDetail: List<TimeRow> = emptyList(),
    /** The payments behind "Collected", so the figure can show its working. */
    val payments: List<PaymentRecord> = emptyList(),
    /** Names of the jobs counted as won, so that figure can too. */
    val wonJobNames: List<String> = emptyList(),
    /** Job name lookup for the payment rows. */
    val jobNamesById: Map<Long, String> = emptyMap()
)

data class CrewRow(val name: String, val jobs: Int, val hours: Double, val cost: Double) {
    val perHour: Double get() = if (hours > 0) cost / hours else 0.0
}

data class OwedRow(val customer: String, val status: String, val materials: Double, val paid: Double) {
    val outstanding: Double get() = (materials - paid).coerceAtLeast(0.0)
}

data class TimeRow(val date: Long, val job: String, val start: Long, val end: Long, val hours: Double, val cost: Double)

class ReportsViewModel(private val repository: Repository) : ViewModel() {

    private val _preset = MutableStateFlow(ReportPreset.QUARTER)
    val preset: StateFlow<ReportPreset> = _preset

    private val _from = MutableStateFlow(startOfDaysAgo(90))
    val from: StateFlow<Long> = _from

    private val _to = MutableStateFlow(endOfToday())
    val to: StateFlow<Long> = _to

    private val _hourFilter = MutableStateFlow(HourFilter.ALL)
    val hourFilter: StateFlow<HourFilter> = _hourFilter

    private val _data = MutableStateFlow(ReportData())
    val data: StateFlow<ReportData> = _data

    init {
        recompute()
        watchForChanges()
    }

    /**
     * Recomputes whenever the underlying data moves.
     *
     * This screen was a snapshot: computed once on open and then only when a
     * filter changed. So a payment that synced in, or a job another phone
     * added, never reached it -- the figures sat still until the screen was
     * reopened or dragged down. Pulling to refresh should be reassurance that a
     * number is current, not the only way to make it current.
     *
     * Debounced because a sync pass writes many rows in quick succession and
     * each one would otherwise trigger a full recompute.
     */
    @OptIn(kotlinx.coroutines.FlowPreview::class)
    private fun watchForChanges() {
        viewModelScope.launch {
            kotlinx.coroutines.flow.combine(
                repository.observeJobs(),
                repository.observeAllPayments()
            ) { jobs, payments ->
                // A cheap fingerprint. The values themselves are re-read by
                // recompute against the current filters; this only has to
                // change when something that could move a figure changes.
                jobs.size to payments.sumOf { it.amount }
            }
                .distinctUntilChanged()
                .debounce(400)
                .drop(1) // the first emission is the load that init already did
                .collect { recompute() }
        }
    }

    fun setPreset(p: ReportPreset) {
        _preset.value = p
        if (p != ReportPreset.CUSTOM) {
            _from.value = if (p.days == 0) 0L else startOfDaysAgo(p.days)
            _to.value = endOfToday()
        }
        recompute()
    }

    fun setRange(fromMillis: Long, toMillis: Long) {
        _from.value = fromMillis
        _to.value = toMillis
        _preset.value = ReportPreset.CUSTOM
        recompute()
    }

    fun setHourFilter(f: HourFilter) {
        _hourFilter.value = f
        recompute()
    }

    fun recompute() {
        viewModelScope.launch {
            val fromMillis = _from.value
            val toMillis = _to.value
            val hours = _hourFilter.value

            // Money is counted from the ledger, by when it actually arrived.
            //
            // "Collected this month" used to sum each job's lifetime amountPaid
            // and bucket the whole figure by a single job timestamp -- and for
            // an unscheduled job that timestamp was updatedAt, which is a sync
            // artifact. So editing an old job dragged all of its historical
            // payments into the current month, and because updatedAt differs
            // per device, two phones in the same company showed two different
            // numbers. Payments in the period are now exactly the payments
            // whose receivedAt falls in it.
            val paymentsInPeriod = repository.getPaymentsBetween(fromMillis, toMillis)

            val jobs = repository.getAllJobs().filter { jobDate(it) in fromMillis..toMillis }
            val jobIds = jobs.map { it.id }.toSet()
            val employees = repository.getAllEmployees()
            val expenses = repository.getAllExpenses().filter { it.jobId in jobIds }
            val times = repository.getAllTimeEntries()
                .filter { it.jobId in jobIds && !it.isRunning && hours.matches(it.startedAt) }

            // Materials come from the priced line items, so this reflects what
            // was actually quoted rather than a guess from footage.
            val materialsByJob = jobs.associate { it.id to repository.getLineItems(it.id)
                .sumOf { li -> li.lineTotal } }

            _data.value = ReportData(
                totals = buildTotals(jobs, expenses, times, materialsByJob, paymentsInPeriod),
                revenueByMonth = revenueByMonth(paymentsInPeriod),
                costBreakdown = costBreakdown(jobs, expenses, times, materialsByJob),
                expensesByCategory = expenses.groupBy { it.category.name.replace("_", " ") }
                    .map { (k, v) -> ChartRow(k, v.sumOf { it.amount }) }
                    .sortedByDescending { it.value },
                jobsByStage = jobsByStage(jobs),
                funnel = funnel(jobs),
                leadSources = jobs.filter { it.status.isWon }
                    .groupBy { it.referralSource.ifBlank { "Not recorded" } }
                    .map { (k, v) -> ChartRow(k, v.size.toDouble()) }
                    .sortedByDescending { it.value }.take(8),
                hoursByCrew = hoursByCrew(jobs, times, employees),
                fenceTypes = fenceTypes(jobs),
                crewDetail = crewDetail(jobs, times, employees),
                outstanding = jobs.map {
                    OwedRow(
                        it.customerName.ifBlank { "Untitled" }, it.status.name,
                        materialsByJob[it.id] ?: 0.0, it.amountPaid
                    )
                }.filter { it.outstanding > 0.01 }.sortedByDescending { it.outstanding },
                payments = paymentsInPeriod,
                wonJobNames = jobs.filter { it.status.isWon }
                    .map { it.customerName.ifBlank { "Untitled" } }
                    .sorted(),
                jobNamesById = repository.getAllJobs()
                    .associate { it.id to it.customerName.ifBlank { "Untitled" } },
                timeDetail = times.sortedByDescending { it.startedAt }.map { t ->
                    val job = jobs.firstOrNull { it.id == t.jobId }
                    TimeRow(
                        t.startedAt, job?.customerName?.ifBlank { "Untitled" } ?: "—",
                        t.startedAt, t.endedAt ?: t.startedAt, t.hours, t.laborCost
                    )
                }
            )
        }
    }

    private fun buildTotals(
        jobs: List<Job>,
        expenses: List<Expense>,
        times: List<TimeEntry>,
        materials: Map<Long, Double>,
        payments: List<PaymentRecord>
    ) = ReportTotals(
        // Net of refunds, because a refunded payment is money you do not have.
        collected = payments.sumOf { it.amount },
        materialCost = jobs.sumOf { materials[it.id] ?: 0.0 },
        laborCost = times.sumOf { it.laborCost },
        otherExpenses = expenses.sumOf { it.amount },
        jobsWon = jobs.count { it.status.isWon },
        quotesSent = jobs.count { it.status != JobStatus.DRAFT },
        hoursClocked = times.sumOf { it.hours },
        tipsToInstallers = jobs.sumOf { it.tipAmount }
    )

    private fun revenueByMonth(payments: List<PaymentRecord>): List<ChartRow> {
        val cal = Calendar.getInstance()
        val months = linkedMapOf<String, Double>()
        payments.sortedBy { it.receivedAt }.forEach { payment ->
            cal.timeInMillis = payment.receivedAt
            val key = "${cal.get(Calendar.YEAR)}-${String.format("%02d", cal.get(Calendar.MONTH) + 1)}"
            months[key] = (months[key] ?: 0.0) + payment.amount
        }
        val names = arrayOf("Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec")
        return months.entries.toList().takeLast(12).map { entry ->
            val monthIndex = entry.key.substringAfter("-").toInt() - 1
            ChartRow(names[monthIndex.coerceIn(0, 11)], entry.value)
        }
    }

    private fun costBreakdown(
        jobs: List<Job>, expenses: List<Expense>, times: List<TimeEntry>, materials: Map<Long, Double>
    ) = listOf(
        ChartRow("Collected", jobs.sumOf { it.amountPaid }),
        ChartRow("Materials", jobs.sumOf { materials[it.id] ?: 0.0 }),
        ChartRow("Labor", times.sumOf { it.laborCost }),
        ChartRow("Other", expenses.sumOf { it.amount })
    ).filter { it.value > 0 }

    private fun jobsByStage(jobs: List<Job>): List<ChartRow> {
        val stages = linkedMapOf(
            "New Lead" to 0, "Quote Sent" to 0, "Approved" to 0,
            "Deposit Paid" to 0, "Scheduled" to 0, "Installed" to 0, "Paid in Full" to 0
        )
        jobs.forEach { j ->
            val stage = when {
                j.paymentStatus == PaymentStatus.PAID_IN_FULL -> "Paid in Full"
                j.status == JobStatus.COMPLETED -> "Installed"
                j.scheduledDate != null && j.status == JobStatus.ACCEPTED -> "Scheduled"
                j.amountPaid > 0 || j.paymentStatus == PaymentStatus.DEPOSIT_PAID -> "Deposit Paid"
                j.status == JobStatus.ACCEPTED -> "Approved"
                j.status == JobStatus.SENT -> "Quote Sent"
                else -> "New Lead"
            }
            stages[stage] = (stages[stage] ?: 0) + 1
        }
        return stages.filter { it.value > 0 }.map { ChartRow(it.key, it.value.toDouble()) }
    }

    private fun funnel(jobs: List<Job>) = listOf(
        ChartRow("All jobs", jobs.size.toDouble()),
        ChartRow("Quoted", jobs.count { it.status != JobStatus.DRAFT }.toDouble()),
        ChartRow("Won", jobs.count { it.status.isWon }.toDouble()),
        ChartRow("Paid in full", jobs.count { it.paymentStatus == PaymentStatus.PAID_IN_FULL }.toDouble())
    ).filter { it.value > 0 }

    private suspend fun fenceTypes(jobs: List<Job>): List<ChartRow> {
        val byType = mutableMapOf<String, Double>()
        jobs.forEach { job ->
            val pxPerFt = job.calibrationPixelsPerFoot ?: return@forEach
            repository.getFenceRuns(job.id).forEach { run ->
                val points = FenceCodec.decodePoints(run.pointsEncoded)
                if (points.size < 2) return@forEach
                val feet = com.fenceestimator.app.geometry.FenceGeometryEngine
                    .analyze(points, pxPerFt, run.closedLoop).totalLinearFeet.toDouble()
                val key = run.fenceType.name.replace("_", " ")
                byType[key] = (byType[key] ?: 0.0) + feet
            }
        }
        return byType.entries.sortedByDescending { it.value }.map { ChartRow(it.key, it.value) }
    }

    private fun hoursByCrew(jobs: List<Job>, times: List<TimeEntry>, employees: List<Employee>) =
        crewDetail(jobs, times, employees).map { ChartRow(it.name, it.hours) }

    private fun crewDetail(jobs: List<Job>, times: List<TimeEntry>, employees: List<Employee>): List<CrewRow> {
        val byName = mutableMapOf<String, MutableList<TimeEntry>>()
        times.forEach { entry ->
            // The entry says who clocked in; fall back to whoever the job is
            // assigned to for older entries that predate per-entry employees.
            val job = jobs.firstOrNull { it.id == entry.jobId }
            val id = entry.employeeId ?: job?.assignedEmployeeId
            val name = employees.firstOrNull { it.id == id }?.name?.ifBlank { "Unnamed" } ?: "Unassigned"
            byName.getOrPut(name) { mutableListOf() }.add(entry)
        }
        return byName.map { (name, entries) ->
            CrewRow(
                name = name,
                jobs = entries.map { it.jobId }.distinct().size,
                hours = entries.sumOf { it.hours },
                cost = entries.sumOf { it.laborCost }
            )
        }.sortedByDescending { it.hours }
    }

    /** Scheduled date is when the work happened; fall back to last edit. */
    private fun jobDate(job: Job): Long = job.scheduledDate ?: job.updatedAt

    private companion object {
        fun startOfDaysAgo(days: Int): Long = Calendar.getInstance().apply {
            add(Calendar.DAY_OF_YEAR, -days)
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0)
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis

        fun endOfToday(): Long = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 23); set(Calendar.MINUTE, 59)
            set(Calendar.SECOND, 59); set(Calendar.MILLISECOND, 999)
        }.timeInMillis
    }
}

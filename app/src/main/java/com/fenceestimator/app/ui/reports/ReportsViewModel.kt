package com.fenceestimator.app.ui.reports

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.Expense
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.isWon
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.Calendar

enum class ReportPeriod(val label: String) { DAY("Today"), WEEK("This Week"), MONTH("This Month"), YEAR("This Year"), ALL("All Time") }

data class ReportTotals(
    val jobsCompleted: Int = 0,
    val jobsWon: Int = 0,
    val quotesSent: Int = 0,
    val revenueCollected: Double = 0.0,
    val contractValue: Double = 0.0,
    val materialCost: Double = 0.0,
    val laborCost: Double = 0.0,
    val otherExpenses: Double = 0.0,
    /** Actual clocked hours, as opposed to the flat labor fee that was quoted. */
    val actualLaborHours: Double = 0.0,
    val actualLaborCost: Double = 0.0,
    val totalLinearFeet: Double = 0.0,
    /** Tips pass straight through to installers, so they're reported but never counted as company revenue. */
    val tipsToInstallers: Double = 0.0
) {
    /**
     * Uses clocked hours when the crew tracked them, and falls back to the
     * quoted labor figure when they didn't -- otherwise profit would look
     * inflated on every job where nobody hit Clock In.
     */
    val effectiveLaborCost: Double get() = if (actualLaborCost > 0.0) actualLaborCost else laborCost

    val estimatedProfit: Double get() = contractValue - materialCost - effectiveLaborCost - otherExpenses
    val profitMarginPercent: Double get() = if (contractValue > 0.0) estimatedProfit / contractValue * 100.0 else 0.0
    val averageJobValue: Double get() = if (jobsWon > 0) contractValue / jobsWon else 0.0
    /** Quotes sent that turned into accepted work. */
    val closingRatePercent: Double get() = if (quotesSent > 0) jobsWon.toDouble() / quotesSent * 100.0 else 0.0
    val outstanding: Double get() = (contractValue - revenueCollected).coerceAtLeast(0.0)
}

data class InstallerEarnings(val name: String, val jobCount: Int, val contractValue: Double)

class ReportsViewModel(private val repository: Repository) : ViewModel() {
    private val _period = MutableStateFlow(ReportPeriod.MONTH)
    val period: StateFlow<ReportPeriod> = _period

    private val _totals = MutableStateFlow(ReportTotals())
    val totals: StateFlow<ReportTotals> = _totals

    private val _byInstaller = MutableStateFlow<List<InstallerEarnings>>(emptyList())
    val byInstaller: StateFlow<List<InstallerEarnings>> = _byInstaller

    val employees: StateFlow<List<Employee>> = repository.observeEmployees()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    init {
        recompute()
    }

    fun setPeriod(p: ReportPeriod) {
        _period.value = p
        recompute()
    }

    fun recompute() {
        viewModelScope.launch {
            val jobs = repository.getAllJobs()
            val expenses = repository.getAllExpenses()
            val staff = repository.getAllEmployees()
            val cutoff = periodStart(_period.value)

            val inPeriod = jobs.filter { jobDate(it) >= cutoff }
            val expensesInPeriod = expenses.filter { it.date >= cutoff }
            val jobIdsInPeriod = inPeriod.map { it.id }.toSet()
            val timeInPeriod = repository.getAllTimeEntries()
                .filter { it.jobId in jobIdsInPeriod && !it.isRunning }

            _totals.value = buildTotals(inPeriod, expensesInPeriod, timeInPeriod)
            _byInstaller.value = buildInstallerBreakdown(inPeriod, staff)
        }
    }

    private suspend fun buildTotals(
        jobs: List<Job>,
        expenses: List<Expense>,
        timeEntries: List<com.fenceestimator.app.data.TimeEntry>
    ): ReportTotals {
        var materials = 0.0
        var contract = 0.0
        var labor = 0.0

        jobs.filter { it.status.isWon }.forEach { job ->
            val items = repository.getLineItems(job.id)
            val jobMaterials = items.sumOf { it.quantity * it.unitPrice }
            materials += jobMaterials
            labor += job.laborFlatFee
            // Contract value: what the customer actually owes, after markup/discount.
            val preMarkup = jobMaterials + job.laborFlatFee
            val withMarkup = preMarkup * (1 + job.markupPercent / 100.0)
            val afterDiscount = withMarkup * (1 - job.discountPercent / 100.0)
            contract += maxOf(afterDiscount, job.minimumJobCharge)
        }

        return ReportTotals(
            jobsCompleted = jobs.count { it.status.isWon && it.paymentStatus.name == "PAID_IN_FULL" },
            jobsWon = jobs.count { it.status.isWon },
            quotesSent = jobs.count { it.status != JobStatus.DRAFT },
            revenueCollected = jobs.sumOf { it.amountPaid },
            contractValue = contract,
            materialCost = materials,
            laborCost = labor,
            otherExpenses = expenses.sumOf { it.amount },
            actualLaborHours = timeEntries.sumOf { it.hours },
            actualLaborCost = timeEntries.sumOf { it.laborCost },
            tipsToInstallers = jobs.sumOf { it.tipAmount }
        )
    }

    private suspend fun buildInstallerBreakdown(jobs: List<Job>, staff: List<Employee>): List<InstallerEarnings> {
        val byId = staff.associateBy { it.id }
        return jobs
            .filter { it.assignedEmployeeId != null && it.status.isWon }
            .groupBy { it.assignedEmployeeId }
            .map { (employeeId, employeeJobs) ->
                var value = 0.0
                employeeJobs.forEach { job ->
                    val items = repository.getLineItems(job.id)
                    val materials = items.sumOf { it.quantity * it.unitPrice }
                    val withMarkup = (materials + job.laborFlatFee) * (1 + job.markupPercent / 100.0)
                    value += maxOf(withMarkup * (1 - job.discountPercent / 100.0), job.minimumJobCharge)
                }
                InstallerEarnings(
                    name = byId[employeeId]?.name?.ifBlank { "Unnamed" } ?: "Unassigned",
                    jobCount = employeeJobs.size,
                    contractValue = value
                )
            }
            .sortedByDescending { it.contractValue }
    }

    private fun periodStart(period: ReportPeriod): Long {
        if (period == ReportPeriod.ALL) return 0L
        val cal = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }
        when (period) {
            ReportPeriod.DAY -> {}
            ReportPeriod.WEEK -> cal.add(Calendar.DAY_OF_YEAR, -7)
            ReportPeriod.MONTH -> cal.set(Calendar.DAY_OF_MONTH, 1)
            ReportPeriod.YEAR -> cal.set(Calendar.DAY_OF_YEAR, 1)
            ReportPeriod.ALL -> {}
        }
        return cal.timeInMillis
    }

    /** Scheduled date is the truest "when did this job happen"; fall back to last edit. */
    private fun jobDate(job: Job): Long = job.scheduledDate ?: job.updatedAt
}

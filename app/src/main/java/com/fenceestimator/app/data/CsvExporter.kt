package com.fenceestimator.app.data

import android.content.Context
import android.net.Uri
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object CsvExporter {
    fun exportExpenses(context: Context, expenses: List<Expense>, jobs: List<Job>, destination: Uri): Result<Unit> = runCatching {
        val jobsById = jobs.associateBy { it.id }
        val dateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        context.contentResolver.openOutputStream(destination)?.use { out ->
            out.write("Job,Customer,Address,Date,Category,Description,Amount\n".toByteArray())
            expenses.sortedByDescending { it.date }.forEach { e ->
                val job = jobsById[e.jobId]
                val row = listOf(
                    e.jobId.toString(),
                    csvEscape(job?.customerName.orEmpty()),
                    csvEscape(job?.address.orEmpty()),
                    dateFormat.format(Date(e.date)),
                    e.category.name,
                    csvEscape(e.description),
                    String.format(Locale.US, "%.2f", e.amount)
                ).joinToString(",")
                out.write((row + "\n").toByteArray())
            }
        }
        Unit
    }

    private fun csvEscape(value: String): String =
        if (value.contains(",") || value.contains("\"") || value.contains("\n")) {
            "\"" + value.replace("\"", "\"\"") + "\""
        } else value
}

package com.fenceestimator.app.data

import android.content.Context
import android.net.Uri
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/**
 * Everything a company has, in a zip of spreadsheets.
 *
 * A contractor's job history is their business. If they stop paying, fall out
 * with us, or we go under, they should still have it -- and they should be able
 * to get it without asking permission, because a data export you have to
 * request is one that stops being answered the moment the relationship sours.
 *
 * CSV rather than a database file on purpose: a .db backup only opens in this
 * app, which is worth little if the reason for exporting is that they are
 * leaving it. A zip of spreadsheets opens in Excel, Numbers, and Sheets.
 *
 * This is separate from the local backup/restore file, which exists to move a
 * company between phones and is meant to be re-imported.
 */
object DataExporter {

    private val dateOnly = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    private val dateTime = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US)

    /** Everything that goes in the zip, in the order a person would look for it. */
    data class Bundle(
        val jobs: List<Job>,
        val payments: List<PaymentRecord>,
        val expenses: List<Expense>,
        val timeEntries: List<TimeEntry>,
        val changeOrders: List<ChangeOrder>,
        val lineItems: List<EstimateLineItem>,
        val employees: List<Employee>
    )

    fun export(context: Context, bundle: Bundle, destination: Uri): Result<Unit> = runCatching {
        val jobsById = bundle.jobs.associateBy { it.id }
        val employeesById = bundle.employees.associateBy { it.id }

        // A job is named by its customer everywhere else in the app, so the
        // export names it that way too -- a column of row ids is not something
        // anyone can read.
        fun jobLabel(jobId: Long) = jobsById[jobId]?.customerName.orEmpty().ifBlank { "Job $jobId" }

        context.contentResolver.openOutputStream(destination)?.use { raw ->
            ZipOutputStream(raw).use { zip ->

                zip.put("jobs.csv") {
                    row("Customer", "Address", "Phone", "Email", "Status", "Created", "Scheduled",
                        "Deposit", "Paid", "Refunded", "Payment status", "Signed on", "Contract signed for",
                        "Permit", "HOA", "Notes")
                    bundle.jobs.sortedByDescending { it.createdAt }.forEach { j ->
                        row(j.customerName, j.address, j.phone, j.email, j.status.name,
                            date(j.createdAt), dateOrBlank(j.scheduledDate),
                            money(j.depositAmount), money(j.amountPaid), money(j.refundedAmount),
                            j.paymentStatus.name, stampOrBlank(j.signedAt), money(j.signedContractTotal),
                            j.permitNumber, j.hoaName, j.notes)
                    }
                }

                zip.put("payments.csv") {
                    row("Customer", "Date", "Amount", "Method", "Reference", "Recorded by", "Note")
                    bundle.payments.sortedByDescending { it.receivedAt }.forEach { p ->
                        row(jobLabel(p.jobId), stamp(p.receivedAt), money(p.amount),
                            p.method.name, p.reference, p.recordedBy, p.note)
                    }
                }

                zip.put("expenses.csv") {
                    row("Customer", "Date", "Category", "Description", "Amount")
                    bundle.expenses.sortedByDescending { it.date }.forEach { e ->
                        row(jobLabel(e.jobId), date(e.date), e.category.name, e.description, money(e.amount))
                    }
                }

                zip.put("hours.csv") {
                    row("Customer", "Person", "Started", "Ended", "Hours", "Rate", "Pay", "Approved", "Notes")
                    bundle.timeEntries.sortedByDescending { it.startedAt }.forEach { t ->
                        val hours = t.endedAt?.let { (it - t.startedAt) / 3_600_000.0 }
                        row(jobLabel(t.jobId),
                            employeesById[t.employeeId]?.name.orEmpty(),
                            stamp(t.startedAt), stampOrBlank(t.endedAt),
                            hours?.let { String.format(Locale.US, "%.2f", it) }.orEmpty(),
                            money(t.hourlyRate),
                            hours?.let { money(it * t.hourlyRate) }.orEmpty(),
                            // Blank rather than "false": an unapproved shift is
                            // awaiting a decision, not one that was refused.
                            if (t.approvedAt != null) "Yes" else if (t.rejectedAt != null) "Rejected" else "",
                            t.notes)
                    }
                }

                zip.put("change-orders.csv") {
                    row("Customer", "Created", "Description", "Extra feet", "Extra cost", "Material cost", "Signed on")
                    bundle.changeOrders.sortedByDescending { it.createdAt }.forEach { c ->
                        row(jobLabel(c.jobId), date(c.createdAt), c.description,
                            String.format(Locale.US, "%.1f", c.additionalFeet),
                            money(c.additionalCost), money(c.materialCost), stampOrBlank(c.signedAt))
                    }
                }

                zip.put("materials.csv") {
                    row("Customer", "Item", "Quantity", "Unit", "Unit price", "Supplier price", "Line total")
                    bundle.lineItems.forEach { i ->
                        row(jobLabel(i.jobId), i.description,
                            String.format(Locale.US, "%.2f", i.quantity), i.unit,
                            money(i.unitPrice),
                            i.supplierUnitPrice?.let { money(it) }.orEmpty(),
                            money(i.lineTotal))
                    }
                }

                zip.put("crew.csv") {
                    row("Name", "Role", "Phone", "Email", "Hourly rate")
                    bundle.employees.forEach { e ->
                        row(e.name, e.role, e.phone, e.email, money(e.hourlyRate))
                    }
                }
            }
        } ?: error("Could not open the file to write to.")
        Unit
    }

    // ---- writing ----

    /** Opens a file in the zip and lets [build] write rows into it. */
    private fun ZipOutputStream.put(name: String, build: CsvWriter.() -> Unit) {
        putNextEntry(ZipEntry(name))
        // Excel reads a CSV as the system codepage unless the file says
        // otherwise, which turns accented names into mojibake. The byte-order
        // mark tells it UTF-8.
        write(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()))
        CsvWriter(this).build()
        closeEntry()
    }

    private class CsvWriter(private val out: ZipOutputStream) {
        fun row(vararg values: String) {
            out.write(values.joinToString(",") { escape(it) }.toByteArray(Charsets.UTF_8))
            out.write("\r\n".toByteArray())
        }
    }

    private fun date(millis: Long) = dateOnly.format(Date(millis))
    private fun stamp(millis: Long) = dateTime.format(Date(millis))
    private fun dateOrBlank(millis: Long?) = millis?.let { date(it) }.orEmpty()
    private fun stampOrBlank(millis: Long?) = millis?.let { stamp(it) }.orEmpty()
    private fun money(value: Double) = String.format(Locale.US, "%.2f", value)

    /**
     * Quotes a value, and defuses it if a spreadsheet would treat it as a formula.
     *
     * A cell starting with = + - @ or a control character is executable in Excel,
     * Sheets and LibreOffice. Everything here is typed by somebody -- customer
     * names, job notes, expense descriptions -- so a value like
     * `=HYPERLINK("evil.com","Click")` typed into a note becomes a live link in
     * the contractor's spreadsheet when they open their own export. Prefixing a
     * single quote makes the cell literal text; the quote is not shown by the
     * spreadsheet and does not change what the value reads as.
     */
    internal fun escape(value: String): String {
        val defused =
            if (value.isNotEmpty() && value.first() in charArrayOf('=', '+', '-', '@', '\t', '\r')) "'$value"
            else value
        return if (defused.any { it == ',' || it == '"' || it == '\n' || it == '\r' }) {
            "\"" + defused.replace("\"", "\"\"") + "\""
        } else defused
    }
}

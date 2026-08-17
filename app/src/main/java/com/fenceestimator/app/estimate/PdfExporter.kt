package com.fenceestimator.app.estimate

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import androidx.core.content.FileProvider
import com.fenceestimator.app.data.AppLanguage
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import java.io.File
import java.io.FileOutputStream
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private class PdfLabels(spanish: Boolean) {
    val docTitleEstimate = if (spanish) "PRESUPUESTO" else "ESTIMATE"
    val docTitleInvoice = if (spanish) "FACTURA" else "INVOICE"
    val preparedFor = if (spanish) "PREPARADO PARA" else "PREPARED FOR"
    val description = if (spanish) "DESCRIPCION" else "DESCRIPTION"
    val qty = if (spanish) "CANT" else "QTY"
    val rate = if (spanish) "PRECIO" else "RATE"
    val amount = if (spanish) "MONTO" else "AMOUNT"
    val sectionSubtotal = if (spanish) "Subtotal de seccion" else "Section subtotal"
    val otherItems = if (spanish) "Otros Articulos" else "Other Items"
    val materialsSubtotal = if (spanish) "Subtotal de Materiales" else "Materials Subtotal"
    val tax = if (spanish) "Impuesto" else "Tax"
    val onTaxable = if (spanish) "sobre articulos gravables" else "on taxable items"
    val labor = if (spanish) "Mano de Obra / Instalacion" else "Labor / Installation"
    val teardown = if (spanish) "Demolicion de Cerca Existente" else "Teardown of Existing Fence"
    val markup = if (spanish) "Margen" else "Markup"
    val discount = if (spanish) "Descuento" else "Discount"
    val total = if (spanish) "TOTAL" else "TOTAL"
    val deposit = if (spanish) "Deposito" else "Deposit"
    val amountPaid = if (spanish) "Monto Pagado" else "Amount Paid"
    val balanceDue = if (spanish) "Saldo Pendiente" else "Balance Due"
    val totalLinearFeet = if (spanish) "Pies lineales totales de cerca" else "Total linear feet of fence"
    val signedOn = if (spanish) "Firmado el" else "Signed on"
    val note = if (spanish)
        "Los precios se basan en los costos actuales de materiales y estan sujetos a cambio. Este presupuesto es valido por 30 dias."
    else
        "Prices based on current material costs and are subject to change. This estimate is valid for 30 days."
}

object PdfExporter {
    private const val PAGE_WIDTH = 612
    private const val PAGE_HEIGHT = 792
    private const val MARGIN = 48f

    private val currency: NumberFormat = NumberFormat.getCurrencyInstance(Locale.US)
    private val dateFormat = SimpleDateFormat("MM/dd/yyyy", Locale.US)

    fun export(
        context: Context,
        job: Job,
        estimateNumber: String,
        business: BusinessProfile,
        runs: List<FenceRun>,
        lineItems: List<EstimateLineItem>,
        totals: EstimateEngine.Totals,
        linearFeet: Float,
        isInvoice: Boolean = false,
        /**
         * Who this copy is for. Decides what appears -- material pricing is
         * internal, quantities without prices go to the supplier, and the
         * customer gets scope, price and terms.
         */
        document_: JobDocument = if (isInvoice) JobDocument.CUSTOMER_INVOICE else JobDocument.WORKING_ESTIMATE
    ): File {
        val docKind = document_
        val labels = PdfLabels(business.language == AppLanguage.SPANISH)
        val document = PdfDocument()
        var pageNumber = 1
        var pageInfo = PdfDocument.PageInfo.Builder(PAGE_WIDTH, PAGE_HEIGHT, pageNumber).create()
        var page = document.startPage(pageInfo)
        var canvas = page.canvas
        var y = MARGIN

        val titlePaint = Paint().apply { textSize = 22f; typeface = Typeface.DEFAULT_BOLD; color = 0xFF1E2A3D.toInt() }
        val headerPaint = Paint().apply { textSize = 11f; color = 0xFF444444.toInt() }
        val labelPaint = Paint().apply { textSize = 10f; color = 0xFF888888.toInt() }
        val bodyPaint = Paint().apply { textSize = 11f; color = 0xFF000000.toInt() }
        val boldPaint = Paint().apply { textSize = 11f; typeface = Typeface.DEFAULT_BOLD; color = 0xFF000000.toInt() }
        val sectionPaint = Paint().apply { textSize = 13f; typeface = Typeface.DEFAULT_BOLD; color = 0xFF1E2A3D.toInt() }
        val linePaint = Paint().apply { color = 0xFFCCCCCC.toInt(); strokeWidth = 1f }

        val rightX = PAGE_WIDTH - MARGIN
        val colDesc = MARGIN
        val colQty = rightX - 210f
        val colRate = rightX - 140f
        val colAmount = rightX - 60f

        fun newPageIfNeeded(spaceNeeded: Float) {
            if (y + spaceNeeded > PAGE_HEIGHT - MARGIN) {
                document.finishPage(page)
                pageNumber++
                pageInfo = PdfDocument.PageInfo.Builder(PAGE_WIDTH, PAGE_HEIGHT, pageNumber).create()
                page = document.startPage(pageInfo)
                canvas = page.canvas
                y = MARGIN
            }
        }

        fun drawTableHeader() {
            canvas.drawText(labels.description, colDesc, y, labelPaint)
            canvas.drawText(labels.qty, colQty, y, labelPaint)
            canvas.drawText(labels.rate, colRate, y, labelPaint)
            canvas.drawText(labels.amount, colAmount, y, labelPaint)
            y += 10f
            canvas.drawLine(MARGIN, y, rightX, y, linePaint)
            y += 16f
        }

        fun drawItems(items: List<EstimateLineItem>) {
            items.forEach { item ->
                newPageIfNeeded(18f)
                val amount = item.quantity * item.unitPrice
                val qtyStr = if (item.quantity % 1.0 == 0.0) item.quantity.toInt().toString() else String.format(Locale.US, "%.2f", item.quantity)
                canvas.drawText(truncate(item.description, 46), colDesc, y, bodyPaint)
                canvas.drawText(qtyStr, colQty, y, bodyPaint)
                canvas.drawText(currency.format(item.unitPrice), colRate, y, bodyPaint)
                val amountStr = currency.format(amount) + if (item.taxable) "T" else ""
                canvas.drawText(amountStr, colAmount, y, bodyPaint)
                y += 18f
            }
        }

        fun totalRow(label: String, value: String, bold: Boolean = false) {
            val paint = if (bold) boldPaint else bodyPaint
            val valueWidth = paint.measureText(value)
            canvas.drawText(value, rightX - valueWidth, y, paint)
            val labelWidth = paint.measureText(label)
            canvas.drawText(label, rightX - valueWidth - 16f - labelWidth, y, paint)
            y += 18f
        }

        // Header
        canvas.drawText(business.businessName.ifBlank { "FenceFlow" }, MARGIN, y + 20f, titlePaint)
        y += 30f
        if (business.phone.isNotBlank()) { canvas.drawText(business.phone, MARGIN, y, headerPaint); y += 14f }
        if (business.email.isNotBlank()) { canvas.drawText(business.email, MARGIN, y, headerPaint); y += 14f }
        if (business.licenseNumber.isNotBlank()) { canvas.drawText("License #${business.licenseNumber}", MARGIN, y, headerPaint); y += 14f }

        val docTitle = if (isInvoice) labels.docTitleInvoice else labels.docTitleEstimate
        val topRightY = MARGIN + 20f
        canvas.drawText(docTitle, rightX - boldPaint.measureText(docTitle), topRightY, titlePaint)
        canvas.drawText("# $estimateNumber", rightX - headerPaint.measureText("# $estimateNumber"), topRightY + 22f, headerPaint)
        canvas.drawText(dateFormat.format(Date()), rightX - headerPaint.measureText(dateFormat.format(Date())), topRightY + 38f, headerPaint)

        y += 20f
        canvas.drawLine(MARGIN, y, rightX, y, linePaint)
        y += 20f

        canvas.drawText(labels.preparedFor, MARGIN, y, labelPaint)
        y += 14f
        canvas.drawText(job.customerName.ifBlank { "Customer" }, MARGIN, y, boldPaint)
        y += 14f
        if (job.address.isNotBlank()) { canvas.drawText(job.address, MARGIN, y, bodyPaint); y += 14f }
        if (job.phone.isNotBlank()) { canvas.drawText(job.phone, MARGIN, y, bodyPaint); y += 14f }
        y += 10f

        canvas.drawLine(MARGIN, y, rightX, y, linePaint)
        y += 20f

        val byRun = lineItems.groupBy { it.fenceRunId }

        runs.forEach { run ->
            val items = byRun[run.id].orEmpty()
            if (items.isEmpty()) return@forEach
            newPageIfNeeded(60f)
            canvas.drawText("${run.label.ifBlank { "Fence Run" }} — ${run.fenceType.name.replace("_", " ")}", MARGIN, y, sectionPaint)
            y += 18f
            drawTableHeader()
            drawItems(items)
            val subtotal = items.sumOf { it.lineTotal }
            y += 4f
            val subtotalText = "${labels.sectionSubtotal}: ${currency.format(subtotal)}"
            canvas.drawText(subtotalText, rightX - boldPaint.measureText(subtotalText), y, boldPaint)
            y += 22f
        }

        val unassigned = byRun[null].orEmpty()
        if (unassigned.isNotEmpty()) {
            newPageIfNeeded(60f)
            canvas.drawText(labels.otherItems, MARGIN, y, sectionPaint)
            y += 18f
            drawTableHeader()
            drawItems(unassigned)
            y += 12f
        }

        y += 6f
        newPageIfNeeded(140f)
        canvas.drawLine(MARGIN, y, rightX, y, linePaint)
        y += 18f

        // A customer agreed a price for a finished fence, not a shopping list
        // with your buying prices on it. Showing the breakdown invites an
        // argument about your margin rather than about the work.
        if (docKind.showsMaterialPricing) {
        totalRow(labels.materialsSubtotal, currency.format(totals.materialsSubtotal))
        totalRow("${labels.tax} (${job.taxRatePercent}% ${labels.onTaxable})", currency.format(totals.tax))
        if (totals.laborCost > 0.0) totalRow(labels.labor, currency.format(totals.laborCost))
        // These are all in the grand total, so they have to be on the page. A
        // customer reading a total larger than the lines above it is a customer
        // about to phone and argue, and they would be right to.
        if (totals.gateCharge > 0.0) {
            totalRow("Gates (${"%.0f".format(totals.gateFeet)} ft)", currency.format(totals.gateCharge))
        }
        if (totals.teardownCost > 0.0) {
            totalRow(labels.teardown, currency.format(totals.teardownCost - totals.trashHaulFee))
        }
        if (totals.trashHaulFee > 0.0) totalRow("Haul away", currency.format(totals.trashHaulFee))
        if (totals.changeOrderCost > 0.0) {
            totalRow("Approved extra work", currency.format(totals.changeOrderCost))
        }
        if (totals.markupAmount > 0.0) totalRow("${labels.markup} (${job.markupPercent}%)", currency.format(totals.markupAmount))
        if (totals.discountAmount > 0.0) {
            val label = if (job.pricingTierName.isNotBlank()) "${labels.discount} (${job.pricingTierName}, ${job.discountPercent}%)" else "${labels.discount} (${job.discountPercent}%)"
            totalRow(label, "-" + currency.format(totals.discountAmount))
        }
        }

        // The supplier is the one who sends prices back, so their copy carries
        // no money at all -- only what to quote.
        if (!docKind.showsQuantitiesOnly) {
            y += 4f
            canvas.drawLine(colRate, y, rightX, y, linePaint)
            y += 18f
            totalRow(labels.total, currency.format(totals.grandTotal), bold = true)
        }

        if (docKind.showsPaymentStatus) {
            y += 4f
            if (job.depositAmount > 0.0) totalRow(labels.deposit, currency.format(job.depositAmount))
            // Net of refunds, and from the same place every other screen reads,
            // so the bill cannot disagree with the app.
            totalRow(labels.amountPaid, currency.format(JobMoney.netPaid(job)))
            totalRow(
                labels.balanceDue,
                currency.format(JobMoney.stillOwed(job, totals.grandTotal)),
                bold = true
            )
        }

        y += 20f
        newPageIfNeeded(60f)
        canvas.drawText("${labels.totalLinearFeet}: ${String.format(Locale.US, "%.1f", linearFeet)} ft", MARGIN, y, headerPaint)
        y += 24f

        // The terms the customer is signing, in the company own words. Printed
        // ON the contract rather than referenced, because terms nobody can
        // produce afterwards are terms that were never agreed.
        if (docKind.showsContractTerms && business.contractTerms.isNotBlank()) {
            newPageIfNeeded(80f)
            y += 8f
            canvas.drawText("TERMS", MARGIN, y, Paint(headerPaint).apply { typeface = Typeface.DEFAULT_BOLD })
            y += 16f

            val termsPaint = Paint().apply { textSize = 8.5f; color = 0xFF333333.toInt() }
            val filled = business.contractTerms
                .replace("{COMPANY}", business.businessName.ifBlank { "The contractor" })
                .replace("{ADDRESS}", job.address.ifBlank { "the address above" })
                .replace("{TOTAL}", currency.format(totals.grandTotal))
                .replace("{DEPOSIT}", currency.format(job.depositAmount))
                .replace("{WARRANTY_PERIOD}", "one year")

            val maxWidth = rightX - MARGIN
            filled.trim().lines().forEach { rawLine ->
                if (rawLine.isBlank()) { y += 6f; return@forEach }
                // Wrapped by measuring, because a terms paragraph that runs off
                // the edge of the page is a term the customer never saw.
                var remaining = rawLine.trim()
                while (remaining.isNotEmpty()) {
                    val count = termsPaint.breakText(remaining, true, maxWidth, null)
                    var cut = count
                    if (cut < remaining.length) {
                        val lastSpace = remaining.lastIndexOf(' ', cut)
                        if (lastSpace > 0) cut = lastSpace
                    }
                    newPageIfNeeded(14f)
                    canvas.drawText(remaining.substring(0, cut).trim(), MARGIN, y, termsPaint)
                    y += 11f
                    remaining = remaining.substring(cut).trim()
                }
            }
            y += 10f
        }

        val signaturePath = job.signatureImagePath
        if (signaturePath != null) {
            val sigBitmap = runCatching { BitmapFactory.decodeFile(signaturePath) }.getOrNull()
            if (sigBitmap != null) {
                newPageIfNeeded(90f)
                val sigWidth = 200f
                val sigHeight = sigWidth * sigBitmap.height / sigBitmap.width.coerceAtLeast(1)
                canvas.drawBitmap(sigBitmap, null, android.graphics.RectF(MARGIN, y, MARGIN + sigWidth, y + sigHeight), null)
                y += sigHeight + 4f
                canvas.drawLine(MARGIN, y, MARGIN + sigWidth, y, linePaint)
                y += 12f
                val signedText = job.signedAt?.let { "${labels.signedOn} ${dateFormat.format(Date(it))}" } ?: labels.signedOn
                canvas.drawText(signedText, MARGIN, y, labelPaint)
                y += 20f
            }
        }

        newPageIfNeeded(30f)
        canvas.drawText(labels.note, MARGIN, y, labelPaint)

        document.finishPage(page)

        val pdfDir = File(context.cacheDir, "pdfs").apply { mkdirs() }
        // Named for what it is, so a contract and a supplier request do not
        // arrive in someone inbox as two files called Estimate.
        val fileLabel = docKind.name.lowercase().split("_")
            .joinToString("") { part -> part.replaceFirstChar { it.uppercase() } }
        val outFile = File(pdfDir, "${fileLabel}_${estimateNumber}_${job.customerName.ifBlank { "customer" }.replace(" ", "_")}.pdf")
        FileOutputStream(outFile).use { document.writeTo(it) }
        document.close()
        return outFile
    }

    fun shareUri(context: Context, file: File) =
        FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)

    private fun truncate(s: String, max: Int): String = if (s.length <= max) s else s.take(max - 1) + "…"
}

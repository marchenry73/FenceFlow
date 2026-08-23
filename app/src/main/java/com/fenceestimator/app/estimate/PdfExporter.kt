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
import com.fenceestimator.app.ui.components.label
import java.io.File
import java.io.FileOutputStream
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Every word printed on a document, in the language its reader speaks.
 *
 * Was a single `spanish: Boolean`, so the estimate a customer received could
 * only ever be English or Spanish however the setting was set. French chose a
 * French interface and produced an English contract, which is worse than not
 * offering it -- the moment it matters is the moment somebody is handing the
 * document to a customer.
 *
 * Written out per language rather than pulled from string resources because
 * these are produced on a background thread with no Context, and because the
 * document has to be in the COMPANY'S chosen language regardless of what the
 * phone rendering it is set to.
 */
private class PdfLabels(language: AppLanguage) {

    private val es = language == AppLanguage.SPANISH
    private val fr = language == AppLanguage.FRENCH

    /** Picks by language, defaulting to English. */
    private fun pick(english: String, spanish: String, french: String) =
        when { es -> spanish; fr -> french; else -> english }

    val docTitleEstimate = pick("ESTIMATE", "PRESUPUESTO", "DEVIS")
    val docTitleInvoice = pick("INVOICE", "FACTURA", "FACTURE")
    val docTitleContract = pick("CONTRACT", "CONTRATO", "CONTRAT")
    val docTitleMaterials = pick("MATERIAL REQUEST", "LISTA DE MATERIALES", "DEMANDE DE MATÉRIAUX")
    val preparedFor = pick("PREPARED FOR", "PREPARADO PARA", "PRÉPARÉ POUR")
    val description = pick("DESCRIPTION", "DESCRIPCIÓN", "DESCRIPTION")
    val qty = pick("QTY", "CANT", "QTÉ")
    val rate = pick("RATE", "PRECIO", "PRIX")
    val amount = pick("AMOUNT", "MONTO", "MONTANT")
    val unit = pick("UNIT", "UNIDAD", "UNITÉ")
    val sectionSubtotal = pick("Section subtotal", "Subtotal de sección", "Sous-total de section")
    val otherItems = pick("Other Items", "Otros Artículos", "Autres Articles")
    val materialsSubtotal = pick("Materials Subtotal", "Subtotal de Materiales", "Sous-total Matériaux")
    val tax = pick("Tax", "Impuesto", "Taxe")
    val onTaxable = pick("on taxable items", "sobre artículos gravables", "sur articles taxables")
    val labor = pick("Labor / Installation", "Mano de Obra / Instalación", "Main-d'œuvre / Installation")
    val teardown = pick("Teardown of Existing Fence", "Demolición de Cerca Existente", "Démolition de la Clôture Existante")
    val markup = pick("Markup", "Margen", "Marge")
    val discount = pick("Discount", "Descuento", "Remise")
    val total = pick("TOTAL", "TOTAL", "TOTAL")
    val deposit = pick("Deposit", "Depósito", "Acompte")
    val amountPaid = pick("Amount Paid", "Monto Pagado", "Montant Payé")
    val balanceDue = pick("Balance Due", "Saldo Pendiente", "Solde Dû")
    val totalLinearFeet = pick(
        "Total linear feet of fence",
        "Pies lineales totales de cerca",
        "Pieds linéaires totaux de clôture"
    )
    val signedOn = pick("Signed on", "Firmado el", "Signé le")
    val scopeOfWork = pick("WORK TO BE DONE", "TRABAJO A REALIZAR", "TRAVAUX À RÉALISER")
    val thePlan = pick("THE PLAN", "EL PLANO", "LE PLAN")
    val jobReference = pick("JOB REFERENCE", "REFERENCIA DEL TRABAJO", "RÉFÉRENCE DU CHANTIER")
    val minimumCharge = pick("Minimum job charge", "Cargo mínimo del trabajo", "Forfait minimum de chantier")
    val warrantyPeriod = pick("one year", "un año", "un an")
    val approvedExtraWork = pick(
        "Approved extra work",
        "Trabajo adicional aprobado",
        "Travaux supplémentaires approuvés"
    )
    val quoteRequest = pick(
        "Please quote the materials listed above. The quantities are ours -- the prices are yours.",
        "Por favor coticen los materiales listados arriba. Las cantidades son nuestras; los precios son suyos.",
        "Merci de chiffrer les matériaux ci-dessus. Les quantités sont les nôtres, les prix sont les vôtres."
    )
    val note = pick(
        "Prices based on current material costs and are subject to change. This estimate is valid for 30 days.",
        "Los precios se basan en los costos actuales de materiales y están sujetos a cambio. Este presupuesto es válido por 30 días.",
        "Les prix sont basés sur les coûts actuels des matériaux et peuvent changer. Ce devis est valable 30 jours."
    )
}

object PdfExporter {
    private const val PAGE_WIDTH = 612
    private const val PAGE_HEIGHT = 792
    private const val MARGIN = 48f

    private val currency: NumberFormat = NumberFormat.getCurrencyInstance(Locale.US)
    /**
     * Dates in the document's own convention. A Spanish or French contract
     * dated 08/03/2026 is ambiguous to its reader; day-first is what they
     * write. The language decides, not the phone's locale, because the
     * document belongs to the company.
     */
    private fun dateFormatFor(language: com.fenceestimator.app.data.AppLanguage): SimpleDateFormat =
        if (language == com.fenceestimator.app.data.AppLanguage.ENGLISH)
            SimpleDateFormat("MM/dd/yyyy", Locale.US)
        else SimpleDateFormat("dd/MM/yyyy", Locale.US)

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
        val labels = PdfLabels(business.language)
        val dateFormat = dateFormatFor(business.language)
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
            // The supplier is the one who sends prices back, so their copy has
            // no money columns at all -- not even empty ones, which only invite
            // the question of what belongs there.
            if (docKind.showsQuantitiesOnly) {
                canvas.drawText(labels.qty, colRate, y, labelPaint)
                canvas.drawText(labels.unit, colAmount, y, labelPaint)
            } else {
                canvas.drawText(labels.qty, colQty, y, labelPaint)
                canvas.drawText(labels.rate, colRate, y, labelPaint)
                canvas.drawText(labels.amount, colAmount, y, labelPaint)
            }
            y += 10f
            canvas.drawLine(MARGIN, y, rightX, y, linePaint)
            y += 16f
        }

        fun drawItems(items: List<EstimateLineItem>) {
            items.forEach { item ->
                newPageIfNeeded(18f)
                val qtyStr = if (item.quantity % 1.0 == 0.0) item.quantity.toInt().toString()
                    else String.format(Locale.US, "%.2f", item.quantity)
                if (docKind.showsQuantitiesOnly) {
                    // More room for the description without the price columns,
                    // which matters -- a supplier quoting from a truncated part
                    // name quotes the wrong part.
                    canvas.drawText(truncate(item.description, 62), colDesc, y, bodyPaint)
                    canvas.drawText(qtyStr, colRate, y, bodyPaint)
                    canvas.drawText(item.unit, colAmount, y, bodyPaint)
                } else {
                    canvas.drawText(truncate(item.description, 46), colDesc, y, bodyPaint)
                    canvas.drawText(qtyStr, colQty, y, bodyPaint)
                    canvas.drawText(currency.format(item.unitPrice), colRate, y, bodyPaint)
                    val amountStr = currency.format(item.lineTotal) + if (item.taxable) "T" else ""
                    canvas.drawText(amountStr, colAmount, y, bodyPaint)
                }
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

        // ---- Header ----
        //
        // The business name is set in 22pt but only had 10pt of clearance
        // before the phone number, so its descenders sat on top of it. The
        // name also has to share the line with the document title on the
        // right, and a long trading name plus a long title collided.
        // Every document used to be headed ESTIMATE or INVOICE, so a contract
        // and a supplier request arrived looking like two more copies of the
        // quote. The heading is the first thing telling somebody which of the
        // four they are holding.
        val docTitle = when (docKind) {
            JobDocument.WORKING_ESTIMATE -> labels.docTitleEstimate
            JobDocument.CUSTOMER_CONTRACT -> labels.docTitleContract
            JobDocument.SUPPLIER_REQUEST -> labels.docTitleMaterials
            JobDocument.CUSTOMER_INVOICE -> labels.docTitleInvoice
        }
        val titleWidth = titlePaint.measureText(docTitle)

        // Measured with the paint that DRAWS it. This used to measure with
        // boldPaint at 11pt and draw with titlePaint at 22pt, so the title was
        // about twice as wide as the space reserved and ran off the page edge.
        val titleX = rightX - titleWidth
        val topRightY = MARGIN + 20f
        canvas.drawText(docTitle, titleX, topRightY, titlePaint)
        canvas.drawText("# $estimateNumber", rightX - headerPaint.measureText("# $estimateNumber"), topRightY + 20f, headerPaint)
        val dateText = dateFormat.format(Date())
        canvas.drawText(dateText, rightX - headerPaint.measureText(dateText), topRightY + 36f, headerPaint)

        // The name gets whatever is left, and shrinks rather than running into
        // the title. A company called "Legacy Solutions Fencing & Landscaping"
        // should still fit on its own document.
        val name = business.businessName.ifBlank { "FenceFlow" }
        val nameRoom = titleX - MARGIN - 24f
        val namePaint = Paint(titlePaint)
        while (namePaint.measureText(name) > nameRoom && namePaint.textSize > 12f) {
            namePaint.textSize -= 1f
        }
        canvas.drawText(name, MARGIN, y + 20f, namePaint)

        // The next baseline sits below the name's descenders AND above the
        // phone number's full height -- measured from the fonts themselves.
        // The old clearance was a guessed fraction of the name size, which
        // was enough only once a long name had shrunk itself: a short name
        // stayed at full 22pt and its descenders sat in the phone number on
        // every document. descent() is how far this font actually drops;
        // -ascent() is how far the next line actually rises.
        y += 20f + namePaint.descent() - headerPaint.ascent() + 2f
        if (business.phone.isNotBlank()) { canvas.drawText(business.phone, MARGIN, y, headerPaint); y += 14f }
        if (business.email.isNotBlank()) { canvas.drawText(business.email, MARGIN, y, headerPaint); y += 14f }
        if (business.licenseNumber.isNotBlank()) { canvas.drawText("License #${business.licenseNumber}", MARGIN, y, headerPaint); y += 14f }

        // Never start the body above the date block on the right.
        y = maxOf(y, topRightY + 48f)
        y += 14f
        canvas.drawLine(MARGIN, y, rightX, y, linePaint)
        y += 20f

        if (docKind.showsQuantitiesOnly) {
            // The supplier is being asked for prices on parts. The customer's
            // name, street and phone were riding along on every request --
            // a third party has no business with any of it. A job reference
            // is enough to talk about the order.
            canvas.drawText(labels.jobReference, MARGIN, y, labelPaint)
            y += 14f
            canvas.drawText("#$estimateNumber", MARGIN, y, boldPaint)
            y += 14f
        } else {
            canvas.drawText(labels.preparedFor, MARGIN, y, labelPaint)
            y += 14f
            canvas.drawText(job.customerName.ifBlank { "Customer" }, MARGIN, y, boldPaint)
            y += 14f
            if (job.address.isNotBlank()) { canvas.drawText(job.address, MARGIN, y, bodyPaint); y += 14f }
            if (job.phone.isNotBlank()) { canvas.drawText(job.phone, MARGIN, y, bodyPaint); y += 14f }
        }
        y += 10f

        canvas.drawLine(MARGIN, y, rightX, y, linePaint)
        y += 20f

        val byRun = lineItems.groupBy { it.fenceRunId }

        // Who sees a materials table at all.
        //
        // The customer does not. They agreed a price for a finished fence, and
        // a shopping list with buying prices on it invites an argument about
        // margin instead of about the work. Their documents describe the work
        // and show the drawing instead -- which is what they actually check.
        if (docKind.showsMaterialPricing || docKind.showsQuantitiesOnly) {
            runs.forEach { run ->
                val items = byRun[run.id].orEmpty()
                if (items.isEmpty()) return@forEach
                newPageIfNeeded(60f)
                canvas.drawText(
                    "${run.label.ifBlank { "Fence Run" }} — ${run.fenceType.label}",
                    MARGIN, y, sectionPaint
                )
                y += 18f
                drawTableHeader()
                drawItems(items)
                // A subtotal is a price, so the supplier copy has none.
                if (docKind.showsMaterialPricing) {
                    val subtotal = items.sumOf { it.lineTotal }
                    y += 4f
                    val subtotalText = "${labels.sectionSubtotal}: ${currency.format(subtotal)}"
                    canvas.drawText(subtotalText, rightX - boldPaint.measureText(subtotalText), y, boldPaint)
                }
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
        } else {
            // What the customer is buying, in plain language: one line per run,
            // saying what is being built and how much of it.
            newPageIfNeeded(60f)
            canvas.drawText(labels.scopeOfWork, MARGIN, y, sectionPaint)
            y += 20f
            runs.forEach { run ->
                newPageIfNeeded(30f)
                val feet = EstimateEngine.linearFeet(job, listOf(run))
                val heading = run.label.ifBlank { run.fenceType.label }
                canvas.drawText(heading, MARGIN, y, boldPaint)
                y += 14f
                val spec = buildList {
                    add(run.fenceType.label)
                    if (run.colorOrFinish.isNotBlank()) add(run.colorOrFinish)
                    if (run.panelHeightFt > 0f) add("${"%.0f".format(run.panelHeightFt)} ft high")
                    if (feet > 0f) add("${"%.0f".format(feet)} linear ft")
                }.joinToString(" · ")
                canvas.drawText(spec, MARGIN + 12f, y, bodyPaint)
                y += 20f
            }
            if (totals.teardownCost > 0.0) {
                newPageIfNeeded(20f)
                canvas.drawText(labels.teardown, MARGIN, y, bodyPaint)
                y += 18f
            }
            if (totals.changeOrderCost > 0.0) {
                newPageIfNeeded(20f)
                canvas.drawText(labels.approvedExtraWork, MARGIN, y, bodyPaint)
                y += 18f
            }
            y += 6f
        }

        y += 6f
        newPageIfNeeded(140f)
        canvas.drawLine(MARGIN, y, rightX, y, linePaint)
        y += 18f

        // A customer agreed a price for a finished fence, not a shopping list
        // with your buying prices on it. Showing the breakdown invites an
        // argument about your margin rather than about the work.
        // The block is tall; without a check it could start at the bottom
        // edge and run off the page, taking the TOTAL with it.
        newPageIfNeeded(170f)
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
        // When the minimum job charge lifts the total above the sum of the
        // rows, say so. A customer adding up the lines and getting less than
        // the TOTAL is a customer who thinks the bill is wrong.
        val rowsSum = totals.materialsSubtotal + totals.tax + totals.laborCost +
            totals.gateCharge + totals.teardownCost + totals.changeOrderCost +
            totals.markupAmount - totals.discountAmount
        if (totals.grandTotal > rowsSum + 0.005) {
            totalRow(labels.minimumCharge, currency.format(totals.grandTotal - rowsSum))
        }
        }

        // The supplier is the one who sends prices back, so their copy carries
        // no money at all -- only what to quote.
        if (!docKind.showsQuantitiesOnly) {
            newPageIfNeeded(60f)
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

        // The drawing, on the documents the customer reads.
        //
        // It is the part they actually check -- where the line runs, which side
        // the gate is on -- and a contract describing a fence without showing
        // it is a contract about a fence nobody has agreed the shape of.
        // THE PLAN with the plan actually on it. The photo alone showed the
        // yard and none of the fence -- the one thing the customer checks is
        // where the line runs and which side the gate hangs, and that lives in
        // the drawn runs, not the photograph. With no photo at all (grid-drawn
        // jobs), the geometry is drawn on its own, so those contracts stop
        // shipping with no plan whatsoever.
        if (docKind.isExternal && !docKind.showsQuantitiesOnly) {
            val maxW = rightX - MARGIN
            val plan = job.surveyImagePath?.let { p -> runCatching { BitmapFactory.decodeFile(p) }.getOrNull() }
            val drawableRuns = runs.filter {
                com.fenceestimator.app.geometry.FenceCodec.decodePoints(it.pointsEncoded).size >= 2 ||
                    com.fenceestimator.app.geometry.FenceCodec.decodeGates(it.gatesEncoded).isNotEmpty()
            }
            if (plan != null && plan.width > 0 && plan.height > 0) {
                val maxH = 260f
                val scale = minOf(maxW / plan.width, maxH / plan.height)
                val w = plan.width * scale
                val h = plan.height * scale
                newPageIfNeeded(h + 40f)
                canvas.drawText(labels.thePlan, MARGIN, y, sectionPaint)
                y += 14f
                canvas.drawBitmap(plan, null, android.graphics.RectF(MARGIN, y, MARGIN + w, y + h), null)
                // Points are stored in the image's own pixel space, so the
                // same scale that placed the photo places the fence on it.
                drawRunGeometry(canvas, drawableRuns, { MARGIN + it * scale }, { y + it * scale })
                y += h + 18f
            } else if (drawableRuns.isNotEmpty()) {
                var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE
                var maxX = -Float.MAX_VALUE; var maxYv = -Float.MAX_VALUE
                drawableRuns.forEach { run ->
                    com.fenceestimator.app.geometry.FenceCodec.decodePoints(run.pointsEncoded).forEach {
                        minX = minOf(minX, it.x); minY = minOf(minY, it.y)
                        maxX = maxOf(maxX, it.x); maxYv = maxOf(maxYv, it.y)
                    }
                    com.fenceestimator.app.geometry.FenceCodec.decodeGates(run.gatesEncoded).forEach {
                        minX = minOf(minX, it.x); minY = minOf(minY, it.y)
                        maxX = maxOf(maxX, it.x); maxYv = maxOf(maxYv, it.y)
                    }
                }
                if (maxX > minX || maxYv > minY) {
                    val pad = 0.06f * maxOf(maxX - minX, maxYv - minY, 1f)
                    minX -= pad; minY -= pad; maxX += pad; maxYv += pad
                    val h = 220f
                    val scale = minOf(maxW / (maxX - minX), h / (maxYv - minY))
                    val w = (maxX - minX) * scale
                    newPageIfNeeded(h + 40f)
                    canvas.drawText(labels.thePlan, MARGIN, y, sectionPaint)
                    y += 14f
                    val bg = Paint().apply { color = 0xFFF7F8FA.toInt() }
                    val border = Paint().apply { color = 0xFFD7DEE8.toInt(); style = Paint.Style.STROKE; strokeWidth = 1.5f }
                    canvas.drawRect(MARGIN, y, MARGIN + w, y + (maxYv - minY) * scale, bg)
                    canvas.drawRect(MARGIN, y, MARGIN + w, y + (maxYv - minY) * scale, border)
                    val yTop = y
                    drawRunGeometry(canvas, drawableRuns,
                        { MARGIN + (it - minX) * scale }, { yTop + (it - minY) * scale })
                    y += (maxYv - minY) * scale + 18f
                }
            }
        }

        // The terms the customer is signing, in the company own words. Printed
        // ON the contract rather than referenced, because terms nobody can
        // produce afterwards are terms that were never agreed.
        if (docKind.showsContractTerms && business.contractTerms.isNotBlank()) {
            newPageIfNeeded(80f)
            y += 8f
            canvas.drawText("TERMS", MARGIN, y, Paint(headerPaint).apply { typeface = Typeface.DEFAULT_BOLD })
            y += 16f

            val termsPaint = Paint().apply { textSize = 8.5f; color = 0xFF333333.toInt() }
            // Untouched default terms print in the company's language; terms
            // an owner has edited print exactly as written. The terms used to
            // come out in English whatever language the rest of the document
            // was in, which made a Spanish contract half a Spanish contract.
            val source = if (com.fenceestimator.app.data.isDefaultContractTerms(business.contractTerms))
                com.fenceestimator.app.data.defaultContractTermsFor(business.language)
            else business.contractTerms
            val filled = source
                .replace("{COMPANY}", business.businessName.ifBlank { "The contractor" })
                .replace("{ADDRESS}", job.address.ifBlank { "the address above" })
                .replace("{TOTAL}", currency.format(totals.grandTotal))
                .replace("{DEPOSIT}", currency.format(job.depositAmount))
                .replace("{WARRANTY_PERIOD}", labels.warrantyPeriod)

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

        // The customer's signature stays off the supplier's copy. The
        // supplier is being asked for prices, not shown who agreed to what --
        // a signature on a parts list is a private agreement forwarded to a
        // third party for no reason.
        val signaturePath = job.signatureImagePath.takeUnless { docKind.showsQuantitiesOnly }
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
        // The closing line belongs to the reader: the supplier is asked for a
        // quote, the estimate says prices can move and expires -- and the
        // contract and invoice say NEITHER, because "valid for 30 days" on a
        // signed agreement or a bill reads as the price still being open.
        when {
            docKind.showsQuantitiesOnly ->
                canvas.drawText(labels.quoteRequest, MARGIN, y, labelPaint)
            docKind == JobDocument.WORKING_ESTIMATE ->
                canvas.drawText(labels.note, MARGIN, y, labelPaint)
            else -> Unit
        }

        document.finishPage(page)

        val pdfDir = File(context.cacheDir, "pdfs").apply { mkdirs() }
        // Named for what it is, so a contract and a supplier request do not
        // arrive in someone inbox as two files called Estimate.
        val fileLabel = docKind.name.lowercase().split("_")
            .joinToString("") { part -> part.replaceFirstChar { it.uppercase() } }
        // Only filename-safe characters. A customer entered as "Smith / Jones"
        // turned the path into a sub-directory and crashed the export.
        val safeName = job.customerName.ifBlank { "customer" }
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
        val outFile = File(pdfDir, "${fileLabel}_${estimateNumber}_${safeName}.pdf")
        FileOutputStream(outFile).use { document.writeTo(it) }
        document.close()
        return outFile
    }

    fun shareUri(context: Context, file: File) =
        FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)

    private fun truncate(s: String, max: Int): String = if (s.length <= max) s else s.take(max - 1) + "…"

    /** The fence line and its gates, mapped into page space. */
    private fun drawRunGeometry(
        canvas: android.graphics.Canvas,
        runs: List<FenceRun>,
        mapX: (Float) -> Float,
        mapY: (Float) -> Float
    ) {
        val line = Paint().apply {
            color = 0xFF1E2A3D.toInt(); strokeWidth = 3f
            style = Paint.Style.STROKE; isAntiAlias = true
        }
        val gate = Paint().apply {
            color = 0xFFFF5A1F.toInt(); strokeWidth = 3f
            style = Paint.Style.STROKE; isAntiAlias = true
        }
        runs.forEach { run ->
            val pts = com.fenceestimator.app.geometry.FenceCodec.decodePoints(run.pointsEncoded)
            if (pts.size >= 2) {
                val path = android.graphics.Path()
                path.moveTo(mapX(pts[0].x), mapY(pts[0].y))
                for (i in 1 until pts.size) path.lineTo(mapX(pts[i].x), mapY(pts[i].y))
                if (run.closedLoop) path.close()
                canvas.drawPath(path, line)
            }
            com.fenceestimator.app.geometry.FenceCodec.decodeGates(run.gatesEncoded).forEach { g ->
                canvas.drawCircle(mapX(g.x), mapY(g.y), 5f, gate)
            }
        }
    }
}

package com.fenceestimator.app.estimate

import com.fenceestimator.app.data.MaterialItem
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import java.io.InputStream

data class ParsedLineItem(
    val rawDescription: String,
    val quantity: Double,
    val rate: Double,
    val amount: Double,
    val taxable: Boolean
)

data class ImportMatch(
    val parsed: ParsedLineItem,
    val existingMatch: MaterialItem?,
    val priceChanged: Boolean
)

/**
 * Best-effort text extraction and line-item parsing for FloriFence-style
 * invoice/estimate PDFs (DESCRIPTION ... QTY RATE AMOUNT[T] rows, with
 * descriptions sometimes wrapped onto a second line).
 */
object InvoiceParser {

    private val SKIP_PATTERNS = listOf(
        Regex("^INVOICE$"), Regex("^Estimate$"), Regex("^BILL TO$"), Regex("^SHIP TO$"),
        Regex("^ADDRESS$"), Regex("^DESCRIPTION\\s+QTY\\s+RATE\\s+AMOUNT$"),
        Regex("^SUBTOTAL"), Regex("^TAX\\b"), Regex("^TOTAL"), Regex("^BALANCE DUE"),
        Regex("^READY FOR"), Regex("^TERMS"), Regex("^DUE DATE"), Regex("^DATE"),
        Regex("^ALL SALES ARE FINAL", RegexOption.IGNORE_CASE),
        Regex("^Page \\d+ of \\d+"), Regex("^Accepted"), Regex("^Please remit"),
        Regex("^\\+?\\d[\\d\\s-]{6,}$"), // phone numbers
        Regex("^[\\w.]+@[\\w.]+$"), // emails
        Regex("^#\\s*\\d+$")
    )

    private val LINE_ITEM_REGEX =
        Regex("""^(.+?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})(T)?$""")

    fun extractText(input: InputStream): String {
        PDDocument.load(input).use { doc ->
            return PDFTextStripper().getText(doc)
        }
    }

    fun parseLineItems(text: String): List<ParsedLineItem> {
        val results = mutableListOf<ParsedLineItem>()
        val descBuffer = StringBuilder()

        text.lines().map { it.trim() }.filter { it.isNotEmpty() }.forEach { line ->
            if (SKIP_PATTERNS.any { it.containsMatchIn(line) }) return@forEach

            val match = LINE_ITEM_REGEX.matchEntire(line)
            if (match != null) {
                val descPart = match.groupValues[1].trim()
                val qty = match.groupValues[2].replace(",", "").toDoubleOrNull()
                val rate = match.groupValues[3].replace(",", "").toDoubleOrNull()
                val amount = match.groupValues[4].replace(",", "").toDoubleOrNull()
                val taxable = match.groupValues[5] == "T"
                if (qty != null && rate != null && amount != null) {
                    val fullDesc = (descBuffer.toString() + " " + descPart).trim()
                    descBuffer.clear()
                    results.add(ParsedLineItem(fullDesc, qty, rate, amount, taxable))
                }
            } else {
                // Likely a wrapped continuation of the next description line, e.g. "(EA) LINE POST"
                if (descBuffer.isNotEmpty()) descBuffer.append(" ")
                descBuffer.append(line)
            }
        }
        return results
    }

    /** Matches parsed rows against the existing catalog by normalized word overlap. */
    fun matchAgainstCatalog(parsed: List<ParsedLineItem>, catalog: List<MaterialItem>): List<ImportMatch> {
        return parsed.map { item ->
            val itemWords = normalize(item.rawDescription)
            var best: MaterialItem? = null
            var bestScore = 0.0
            catalog.forEach { candidate ->
                val candWords = normalize(candidate.name + " " + candidate.colorOrFinish)
                val score = jaccard(itemWords, candWords)
                if (score > bestScore) {
                    bestScore = score
                    best = candidate
                }
            }
            val match = if (bestScore >= 0.3) best else null
            ImportMatch(
                parsed = item,
                existingMatch = match,
                priceChanged = match != null && match.unitPrice != item.rate
            )
        }
    }

    private fun normalize(s: String): Set<String> {
        val upper = s.uppercase()
        val words = upper
            .replace(Regex("[^A-Z0-9 ]"), " ")
            .split(" ")
            .filter { it.length > 1 }
            .toSet()
        // Every number in the name, kept as a token of its own.
        //
        // The size is the only thing separating two otherwise identical
        // products, and the one-character filter above threw it away:
        // "Panel 6'H x 6'W" and "Panel 8'H x 8'W" both reduced to
        // PANEL, VINYL, PRIVACY, GRAY -- word for word the same. Importing a
        // supplier invoice then wrote the 8 ft panel's price onto the 6 ft
        // row, and every estimate after that quoted the wrong figure.
        //
        // Numbers rather than the whole dimension string, so a supplier
        // writing "6FT X 6FT" still meets a catalog entry reading "6'H x 6'W".
        val numbers = Regex("\\d+(?:\\.\\d+)?").findAll(upper).map { it.value }.toSet()
        return words + numbers
    }

    private fun jaccard(a: Set<String>, b: Set<String>): Double {
        if (a.isEmpty() || b.isEmpty()) return 0.0
        val intersection = a.intersect(b).size.toDouble()
        val union = a.union(b).size.toDouble()
        return if (union == 0.0) 0.0 else intersection / union
    }
}

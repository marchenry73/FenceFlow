package com.fenceestimator.app.ui.estimate

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.estimate.EstimateEngine
import com.fenceestimator.app.estimate.PdfExporter
import com.fenceestimator.app.estimate.TakeoffLine
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import java.text.NumberFormat
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EstimateScreen(jobId: Long, onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: EstimateViewModel = viewModel(
        key = "estimate_$jobId",
        factory = GenericViewModelFactory { EstimateViewModel(app.repository, jobId) }
    )
    val job by viewModel.job.collectAsState()
    val runs by viewModel.runs.collectAsState()
    val lineItems by viewModel.lineItems.collectAsState()
    val profile by app.settingsStore.profile.collectAsState(initial = BusinessProfile())
    val totals by viewModel.totals.collectAsState()
    val takeoff by viewModel.takeoff.collectAsState()
    val currency = remember { NumberFormat.getCurrencyInstance(Locale.US) }
    val currentJob = job ?: return

    var editingItem by remember { mutableStateOf<EstimateLineItem?>(null) }
    val itemsByRun = remember(lineItems) { lineItems.groupBy { it.fenceRunId } }
    val warnings = remember(currentJob, runs, lineItems, totals) {
        EstimateEngine.estimateWarnings(currentJob, runs, lineItems, totals)
    }

    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(Unit) {
        viewModel.message.collect { snackbarHostState.showSnackbar(it) }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Estimate") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            // Keys have to be unique across the WHOLE list, not just within one
            // items() block. Runs and line items both used their raw row id, so
            // a run with id 3 and a line item with id 3 produced the same key --
            // and Compose throws the moment the second one scrolls into view.
            // That is the crash on scrolling down the estimate.
            items(runs, key = { "run-${it.id}" }) { run ->
                RunSection(
                    run = run,
                    linearFeet = viewModel.linearFeetFor(run),
                    items = itemsByRun[run.id].orEmpty(),
                    takeoff = takeoff[run.id].orEmpty(),
                    currency = currency,
                    onRegenerate = { viewModel.regenerateSuggested(run) },
                    onManualFeet = { feet, corners -> viewModel.setManualFeet(run, feet, corners) },
                    onRestoreRemoved = { viewModel.restoreRemovedItems(run) },
                    onItemClick = { editingItem = it }
                )
            }

            item {
                WasteCard(
                    wastePercent = currentJob.wastePercent,
                    onChange = { viewModel.setWastePercent(it) }
                )
            }

            val unassigned = itemsByRun[null].orEmpty()
            item {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text("Other Items", style = MaterialTheme.typography.titleMedium)
                    OutlinedButton(onClick = { viewModel.addManualLineItem() }) { Text("+ Add Item") }
                }
            }
            items(unassigned, key = { "item-${it.id}" }) { item ->
                LineItemRow(item, currency, onClick = { editingItem = item })
            }

            item { TotalsCard(totals, currentJob, currency) }
            if (warnings.isNotEmpty()) {
                item { WarningsCard(warnings) }
            }
            item { ExportSection(viewModel, profile, currentJob) }
        }
    }

    editingItem?.let { item ->
        EditLineItemDialog(
            item = item,
            onSave = { viewModel.updateLineItem(it); editingItem = null },
            onDelete = { viewModel.deleteLineItem(item); editingItem = null },
            onDismiss = { editingItem = null }
        )
    }
}

@Composable
private fun RunSection(
    run: FenceRun,
    linearFeet: Float,
    items: List<EstimateLineItem>,
    takeoff: List<TakeoffLine>,
    currency: NumberFormat,
    onRegenerate: () -> Unit,
    onManualFeet: (Float?, Int) -> Unit,
    onRestoreRemoved: () -> Unit,
    onItemClick: (EstimateLineItem) -> Unit
) {
    val subtotal = items.sumOf { it.quantity * it.unitPrice }
    var feetText by remember(run.id, run.manualLinearFeet) {
        mutableStateOf(run.manualLinearFeet?.let { if (it % 1f == 0f) it.toInt().toString() else it.toString() } ?: "")
    }
    var cornerText by remember(run.id, run.manualCornerCount) {
        mutableStateOf(if (run.manualCornerCount > 0) run.manualCornerCount.toString() else "")
    }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(run.label.ifBlank { "Untitled run" }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        "${run.fenceType.name.replace("_", " ")} · ${String.format("%.1f", linearFeet)} ft" +
                            if (run.usesManualFeet) "  (typed in)" else "",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Text(currency.format(subtotal), fontWeight = FontWeight.SemiBold)
            }

            Spacer(Modifier.height(10.dp))
            // Typing the length is the fastest path and needs no drawing, no
            // photo, and no calibration -- most quotes start from a wheel
            // measurement, not a survey.
            Text("Know the length already?", style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = feetText,
                    onValueChange = {
                        feetText = it
                        onManualFeet(it.toFloatOrNull(), cornerText.toIntOrNull() ?: 0)
                    },
                    label = { Text("Total feet") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.weight(1f)
                )
                OutlinedTextField(
                    value = cornerText,
                    onValueChange = {
                        cornerText = it
                        onManualFeet(feetText.toFloatOrNull(), it.toIntOrNull() ?: 0)
                    },
                    label = { Text("Corners") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.weight(1f)
                )
            }
            Text(
                if (run.usesManualFeet) "Using your typed length. Clear it to measure off the drawing instead."
                else "Leave blank to measure off the drawing on the Survey screen.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Spacer(Modifier.height(10.dp))
            Button(onClick = onRegenerate, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Filled.Refresh, contentDescription = null)
                Text("  Suggest Quantities")
            }

            if (takeoff.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                TakeoffBlock(takeoff)
            } else {
                val summary = quantitySummary(items)
                if (summary.isNotBlank()) {
                    Spacer(Modifier.height(8.dp))
                    Text(summary, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            if (run.suppressedRoles.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        "${run.suppressedRoles.size} item type${if (run.suppressedRoles.size == 1) "" else "s"} removed and kept off",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f)
                    )
                    OutlinedButton(onClick = onRestoreRemoved) { Text("Restore") }
                }
            }

            Spacer(Modifier.height(8.dp))
            items.forEach { item ->
                LineItemRow(item, currency, onClick = { onItemClick(item) })
                Spacer(Modifier.height(6.dp))
            }
        }
    }
}

/** The counts a contractor reads off before calling the supply house. */
@Composable
private fun TakeoffBlock(takeoff: List<TakeoffLine>) {
    Column(
        Modifier.fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp)
    ) {
        Text("What this job needs", style = MaterialTheme.typography.labelLarge)
        takeoff.forEach { line ->
            val qty = if (line.quantity % 1.0 == 0.0) line.quantity.toInt().toString()
            else String.format("%.1f", line.quantity)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(line.label, style = MaterialTheme.typography.bodyMedium)
                Text(
                    "$qty ${line.unit}".trim(),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium
                )
            }
        }
    }
}

/** Cut-and-waste allowance, applied only to materials bought by length or count. */
@Composable
private fun WasteCard(wastePercent: Double, onChange: (Double) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text("Waste allowance", style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            Text(
                "Orders extra material for cuts and breakage. At 10%, a takeoff of 17 panels " +
                    "orders 19 — because some get ruined being cut. Only applies to things you " +
                    "cut or break: panels, pickets, rails, fabric, concrete. Never to posts, " +
                    "caps or hardware, which you buy by exact count.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (wastePercent > 0.0) {
                Text(
                    "Press Suggest Quantities after changing this — it only affects newly " +
                        "generated quantities, not lines already on the estimate.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary
                )
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(0.0, 5.0, 10.0, 15.0).forEach { pct ->
                    androidx.compose.material3.FilterChip(
                        selected = wastePercent == pct,
                        onClick = { onChange(pct) },
                        label = { Text(if (pct == 0.0) "None" else "${pct.toInt()}%") }
                    )
                }
            }
        }
    }
}

private val QUANTITY_SUMMARY_ROLES = listOf(
    Triple(MaterialRole.PANEL, "panel", "panels"),
    Triple(MaterialRole.LINE_POST, "line post", "line posts"),
    Triple(MaterialRole.CORNER_POST, "corner post", "corner posts"),
    Triple(MaterialRole.END_POST, "end post", "end posts"),
    Triple(MaterialRole.GATE_POST, "gate post", "gate posts"),
    Triple(MaterialRole.POST_CAP, "cap", "caps"),
    Triple(MaterialRole.CONCRETE_BAG, "bag of concrete", "bags of concrete"),
    Triple(MaterialRole.WOOD_PICKET, "picket", "pickets"),
    Triple(MaterialRole.WOOD_RAIL, "rail", "rails"),
    Triple(MaterialRole.CHAIN_FABRIC, "ft of fabric", "ft of fabric")
)

/** A quick "6 line posts · 2 corner posts · ..." readout so the counts are visible without reading every line item. */
private fun quantitySummary(items: List<EstimateLineItem>): String {
    val byRole = items.groupBy { it.role }
    return QUANTITY_SUMMARY_ROLES.mapNotNull { (role, singular, plural) ->
        val qty = byRole[role]?.sumOf { it.quantity } ?: 0.0
        if (qty <= 0.0) return@mapNotNull null
        val qtyStr = if (qty % 1.0 == 0.0) qty.toInt().toString() else String.format("%.1f", qty)
        "$qtyStr ${if (qty == 1.0) singular else plural}"
    }.joinToString("  ·  ")
}

@Composable
private fun LineItemRow(item: EstimateLineItem, currency: NumberFormat, onClick: () -> Unit) {
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(item.description, fontWeight = FontWeight.Medium)
                val qtyStr = if (item.quantity % 1.0 == 0.0) item.quantity.toInt().toString() else String.format("%.2f", item.quantity)
                Text("$qtyStr ${item.unit} x ${currency.format(item.unitPrice)}", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(currency.format(item.quantity * item.unitPrice), fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun TotalsCard(totals: EstimateEngine.Totals, job: Job?, currency: NumberFormat) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            TotalRow("Materials Subtotal", currency.format(totals.materialsSubtotal))
            TotalRow("Tax (${job?.taxRatePercent ?: 0}%)", currency.format(totals.tax))
            if (totals.laborCost > 0.0) TotalRow("Labor", currency.format(totals.laborCost))
            if (totals.gateCharge > 0.0) {
                TotalRow(
                    "Gates (${"%.0f".format(totals.gateFeet)} ft @ ${currency.format(job?.gateRatePerFt ?: 0.0)}/ft)",
                    currency.format(totals.gateCharge)
                )
            }
            if (totals.teardownCost > 0.0) {
                TotalRow("Teardown of existing fence", currency.format(totals.teardownCost - totals.trashHaulFee))
            }
            if (totals.trashHaulFee > 0.0) TotalRow("Haul away / dump fee", currency.format(totals.trashHaulFee))
            if (totals.markupAmount > 0.0) TotalRow("Markup (${job?.markupPercent ?: 0}%)", currency.format(totals.markupAmount))
            if (totals.discountAmount > 0.0) {
                TotalRow(
                    "Discount${if (job?.pricingTierName?.isNotBlank() == true) " (${job?.pricingTierName})" else ""} (${job?.discountPercent ?: 0}%)",
                    "-" + currency.format(totals.discountAmount)
                )
            }
            if (totals.changeOrderCost > 0.0 || totals.changeOrderFeet > 0.0) {
                TotalRow(
                    "Approved extra work" +
                        if (totals.changeOrderFeet > 0.0) " (+${"%.0f".format(totals.changeOrderFeet)} ft)" else "",
                    currency.format(totals.changeOrderCost)
                )
            }
            Divider(modifier = Modifier.padding(vertical = 8.dp))
            TotalRow("TOTAL", currency.format(totals.grandTotal), bold = true)
            if (job != null && totals.grandTotal <= job!!.minimumJobCharge && job!!.minimumJobCharge > 0.0) {
                Text(
                    "Minimum job charge of ${currency.format(job!!.minimumJobCharge)} applied",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun WarningsCard(warnings: List<String>) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.WarningAmber, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
                Text("  Before you send this", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onErrorContainer)
            }
            warnings.forEach { warning ->
                Text("•  $warning", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onErrorContainer)
            }
        }
    }
}

@Composable
private fun TotalRow(label: String, value: String, bold: Boolean = false) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal)
        Text(value, fontWeight = if (bold) FontWeight.Bold else FontWeight.Normal)
    }
}

@Composable
private fun ExportSection(viewModel: EstimateViewModel, profile: BusinessProfile, job: Job) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var showSignaturePad by remember { mutableStateOf(false) }

    fun sharePdf(isInvoice: Boolean) {
        viewModel.exportPdf(context, profile, isInvoice) { file ->
            val uri = PdfExporter.shareUri(context, file)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "application/pdf"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            context.startActivity(Intent.createChooser(intent, if (isInvoice) "Share Invoice" else "Share Estimate"))
        }
    }

    Column {
        if (job.signatureImagePath != null) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 8.dp)) {
                coil.compose.AsyncImage(
                    model = job.signatureImagePath, contentDescription = null,
                    modifier = Modifier.height(40.dp).weight(1f)
                )
                OutlinedButton(onClick = { showSignaturePad = true }) { Text("Re-sign") }
            }
        } else {
            OutlinedButton(onClick = { showSignaturePad = true }, modifier = Modifier.fillMaxWidth()) {
                Text("Sign to Accept")
            }
            Spacer(Modifier.height(8.dp))
        }
        Button(onClick = { sharePdf(isInvoice = false) }, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Filled.Share, contentDescription = null)
            Text("  Export & Share PDF Estimate")
        }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = { sharePdf(isInvoice = true) }, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Filled.Share, contentDescription = null)
            Text("  Generate & Share Invoice")
        }
    }

    if (showSignaturePad) {
        com.fenceestimator.app.ui.components.SignaturePadDialog(
            onSave = { path -> viewModel.captureSignature(path); showSignaturePad = false },
            onDismiss = { showSignaturePad = false }
        )
    }
}

@Composable
private fun EditLineItemDialog(
    item: EstimateLineItem,
    onSave: (EstimateLineItem) -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit
) {
    var description by remember { mutableStateOf(item.description) }
    var qtyText by remember { mutableStateOf(item.quantity.toString()) }
    var priceText by remember { mutableStateOf(item.unitPrice.toString()) }
    var unit by remember { mutableStateOf(item.unit) }

    androidx.compose.material3.AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Edit Line Item") },
        text = {
            Column {
                OutlinedTextField(value = description, onValueChange = { description = it }, label = { Text("Description") }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = qtyText, onValueChange = { qtyText = it }, label = { Text("Qty") }, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = unit, onValueChange = { unit = it }, label = { Text("Unit") }, modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = priceText, onValueChange = { priceText = it }, label = { Text("Unit price ($)") }, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            Button(onClick = {
                val qty = qtyText.toDoubleOrNull() ?: return@Button
                val price = priceText.toDoubleOrNull() ?: return@Button
                onSave(item.copy(description = description, quantity = qty, unitPrice = price, unit = unit, isAutoGenerated = false))
            }) { Text("Save") }
        },
        dismissButton = {
            Row {
                OutlinedButton(onClick = onDelete) { Text("Delete") }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(onClick = onDismiss) { Text("Cancel") }
            }
        }
    )
}

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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.estimate.EstimateEngine
import com.fenceestimator.app.estimate.EstimateWarning
import com.fenceestimator.app.estimate.JobMoney
import com.fenceestimator.app.estimate.PdfExporter
import com.fenceestimator.app.estimate.TakeoffLine
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import java.text.NumberFormat
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EstimateScreen(jobId: Long, onBack: () -> Unit, onOpenSupplierPrices: (Long) -> Unit = {}) {
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
    val context = androidx.compose.ui.platform.LocalContext.current
    LaunchedEffect(Unit) {
        viewModel.message.collect {
            snackbarHostState.showSnackbar(context.getString(it.textRes, *it.args.toTypedArray()))
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.est_title)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
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
                    wasDrawn = viewModel.canRecalibrateFrom(run),
                    onFixScaleFromFeet = { feet -> viewModel.recalibrateFromRun(run, feet) },
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
                    Text(stringResource(R.string.est_other_items), style = MaterialTheme.typography.titleMedium)
                    OutlinedButton(onClick = { viewModel.addManualLineItem() }) { Text(stringResource(R.string.est_add_item)) }
                }
            }
            items(unassigned, key = { "item-${it.id}" }) { item ->
                LineItemRow(item, currency, onClick = { editingItem = item })
            }

            item { TotalsCard(totals, currentJob, currency) }
            if (warnings.isNotEmpty()) {
                item { WarningsCard(warnings) }
            }
            item { ExportSection(viewModel, profile, currentJob, onOpenSupplierPrices) }
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
    /** True when this run has a drawn line the scale can be worked out from. */
    wasDrawn: Boolean,
    /** Sets the drawing scale so this run measures the length typed above. */
    onFixScaleFromFeet: (Float) -> Unit,
    onRestoreRemoved: () -> Unit,
    onItemClick: (EstimateLineItem) -> Unit
) {
    val subtotal = items.sumOf { it.lineTotal }
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
                    Text(run.label.ifBlank { stringResource(R.string.est2_untitled_run) }, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(
                        stringResource(R.string.est2_run_summary, run.fenceType.name.replace("_", " "), String.format("%.1f", linearFeet)) +
                            if (run.usesManualFeet) "  " + stringResource(R.string.est2_typed_in) else "",
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
            Text(stringResource(R.string.est_know_length), style = MaterialTheme.typography.labelLarge)
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = feetText,
                    onValueChange = {
                        feetText = it
                        onManualFeet(it.replace(',', '.').toFloatOrNull(), cornerText.toIntOrNull() ?: 0)
                    },
                    label = { Text(stringResource(R.string.est_total_feet)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
                    modifier = Modifier.weight(1f)
                )
                OutlinedTextField(
                    value = cornerText,
                    onValueChange = {
                        cornerText = it
                        onManualFeet(feetText.replace(',', '.').toFloatOrNull(), it.toIntOrNull() ?: 0)
                    },
                    label = { Text(stringResource(R.string.est_corners)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.weight(1f)
                )
            }
            Text(
                if (run.usesManualFeet) stringResource(R.string.est2_using_typed_length)
                else stringResource(R.string.est2_leave_blank_measure),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            // Typing a length fixes the quote for this run and leaves the
            // drawing at whatever scale it was -- so the plan the crew works
            // from, the gates marked on it and every other run stay wrong.
            // This goes the other way: it works the scale out from the line as
            // drawn, which corrects the whole plan at once.
            val typedFeet = feetText.replace(',', '.').toFloatOrNull()
            if (wasDrawn && typedFeet != null && typedFeet > 0f) {
                Spacer(Modifier.height(8.dp))
                OutlinedButton(
                    onClick = { onFixScaleFromFeet(typedFeet) },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(stringResource(R.string.est_match_drawing, "%.0f".format(typedFeet)))
                }
                Text(
                    stringResource(R.string.est2_measured_on_site),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Spacer(Modifier.height(10.dp))
            Button(onClick = onRegenerate, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Filled.Refresh, contentDescription = null)
                Text("  " + stringResource(R.string.est_suggest_quantities))
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
                        if (run.suppressedRoles.size == 1) stringResource(R.string.est2_item_types_removed_one)
                        else stringResource(R.string.est2_item_types_removed_many, run.suppressedRoles.size),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f)
                    )
                    OutlinedButton(onClick = onRestoreRemoved) { Text(stringResource(R.string.est_restore)) }
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
        Text(stringResource(R.string.est_what_job_needs), style = MaterialTheme.typography.labelLarge)

        // Grouped under headings, in the order someone works through them.
        //
        // As one flat column, "total posts" sat several rows below the line,
        // end and corner posts it is the sum of, and whoever was loading the
        // truck had to hold that relationship in their head. Things counted
        // together are printed together.
        com.fenceestimator.app.estimate.TakeoffGroup.values().forEach { group ->
            val lines = takeoff.filter { it.group == group }
            if (lines.isEmpty()) return@forEach

            Spacer(Modifier.height(6.dp))
            Text(
                group.heading,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.primary
            )
            lines.forEach { line ->
                val qty = if (line.quantity % 1.0 == 0.0) line.quantity.toInt().toString()
                else String.format("%.1f", line.quantity)
                // The total is the one line worth setting apart, since it is
                // what gets counted against the delivery.
                val isTotal = line.label.startsWith("Total")
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(
                        line.label,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = if (isTotal) FontWeight.Bold else FontWeight.Normal
                    )
                    Text(
                        "$qty ${line.unit}".trim(),
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = if (isTotal) FontWeight.Bold else FontWeight.Medium
                    )
                }
            }
        }
    }
}

/** Cut-and-waste allowance, applied only to materials bought by length or count. */
@Composable
private fun WasteCard(wastePercent: Double, onChange: (Double) -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            Text(stringResource(R.string.est_waste_allowance), style = MaterialTheme.typography.titleMedium)
            Spacer(Modifier.height(4.dp))
            Text(
                stringResource(R.string.est2_waste_explain),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (wastePercent > 0.0) {
                Text(
                    stringResource(R.string.est2_waste_press_suggest),
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
                        label = { Text(if (pct == 0.0) stringResource(R.string.est2_none) else stringResource(R.string.est2_percent, pct.toInt())) }
                    )
                }
            }
        }
    }
}

private val QUANTITY_SUMMARY_ROLES = listOf(
    Triple(MaterialRole.PANEL, R.string.est2_qty_panel, R.string.est2_qty_panels),
    Triple(MaterialRole.LINE_POST, R.string.est2_qty_line_post, R.string.est2_qty_line_posts),
    Triple(MaterialRole.CORNER_POST, R.string.est2_qty_corner_post, R.string.est2_qty_corner_posts),
    Triple(MaterialRole.END_POST, R.string.est2_qty_end_post, R.string.est2_qty_end_posts),
    Triple(MaterialRole.GATE_POST, R.string.est2_qty_gate_post, R.string.est2_qty_gate_posts),
    Triple(MaterialRole.POST_CAP, R.string.est2_qty_cap, R.string.est2_qty_caps),
    Triple(MaterialRole.CONCRETE_BAG, R.string.est2_qty_bag_of_concrete, R.string.est2_qty_bags_of_concrete),
    Triple(MaterialRole.WOOD_PICKET, R.string.est2_qty_picket, R.string.est2_qty_pickets),
    Triple(MaterialRole.WOOD_RAIL, R.string.est2_qty_rail, R.string.est2_qty_rails),
    Triple(MaterialRole.CHAIN_FABRIC, R.string.est2_qty_ft_of_fabric, R.string.est2_qty_ft_of_fabric)
)

/** A quick "6 line posts · 2 corner posts · ..." readout so the counts are visible without reading every line item. */
@Composable
private fun quantitySummary(items: List<EstimateLineItem>): String {
    val byRole = items.groupBy { it.role }
    return QUANTITY_SUMMARY_ROLES.mapNotNull { (role, singular, plural) ->
        val qty = byRole[role]?.sumOf { it.quantity } ?: 0.0
        if (qty <= 0.0) return@mapNotNull null
        val qtyStr = if (qty % 1.0 == 0.0) qty.toInt().toString() else String.format("%.1f", qty)
        "$qtyStr ${stringResource(if (qty == 1.0) singular else plural)}"
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
                Text(stringResource(R.string.est2_line_item_detail, qtyStr, item.unit, currency.format(item.unitPrice)), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(currency.format(item.quantity * item.unitPrice), fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun TotalsCard(totals: EstimateEngine.Totals, job: Job?, currency: NumberFormat) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp)) {
            TotalRow(stringResource(R.string.estimate_materials_subtotal), currency.format(totals.materialsSubtotal))
            TotalRow(stringResource(R.string.est2_tax_pct, "${job?.taxRatePercent ?: 0}"), currency.format(totals.tax))
            if (totals.laborCost > 0.0) TotalRow(stringResource(R.string.estimate_labor), currency.format(totals.laborCost))
            if (totals.gateCharge > 0.0) {
                TotalRow(
                    stringResource(R.string.est2_gates_line, "%.0f".format(totals.gateFeet), currency.format(job?.gateRatePerFt ?: 0.0)),
                    currency.format(totals.gateCharge)
                )
            }
            if (totals.teardownCost > 0.0) {
                TotalRow(stringResource(R.string.est2_teardown_existing), currency.format(totals.teardownCost - totals.trashHaulFee))
            }
            if (totals.trashHaulFee > 0.0) TotalRow(stringResource(R.string.est2_haul_away_fee), currency.format(totals.trashHaulFee))
            if (totals.markupAmount > 0.0) TotalRow(stringResource(R.string.est2_markup_pct, "${job?.markupPercent ?: 0}"), currency.format(totals.markupAmount))
            if (totals.discountAmount > 0.0) {
                TotalRow(
                    if (job?.pricingTierName?.isNotBlank() == true)
                        stringResource(R.string.est2_discount_tier_pct, job?.pricingTierName ?: "", "${job?.discountPercent ?: 0}")
                    else stringResource(R.string.est2_discount_pct, "${job?.discountPercent ?: 0}"),
                    "-" + currency.format(totals.discountAmount)
                )
            }
            if (totals.changeOrderCost > 0.0 || totals.changeOrderFeet > 0.0) {
                TotalRow(
                    stringResource(R.string.est2_approved_extra_work) +
                        if (totals.changeOrderFeet > 0.0) " " + stringResource(R.string.est2_plus_feet, "%.0f".format(totals.changeOrderFeet)) else "",
                    currency.format(totals.changeOrderCost)
                )
            }
            Divider(modifier = Modifier.padding(vertical = 8.dp))
            TotalRow(stringResource(R.string.estimate_total), currency.format(totals.grandTotal), bold = true)

            // What the job keeps, shown every time rather than only when it is
            // bad. The warning below fires under 35%; the owner asked to see
            // the figure itself, not just be told when it is low. Tax is a
            // passthrough and is out on both sides; labor and teardown are the
            // contractor's own charges, so they stay in.
            val keptSession by com.fenceestimator.app.ui.components.currentApp().session.state.collectAsState()
            val priceExTax = totals.grandTotal - totals.tax
            if (keptSession.canSeeMoney && priceExTax > 0.005) {
                val kept = priceExTax - totals.materialsSubtotal
                val keptPct = kept / priceExTax * 100.0
                Text(
                    stringResource(R.string.est2_stays_with_you, currency.format(kept), "%.0f".format(keptPct)),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (keptPct < 35.0) MaterialTheme.colorScheme.error
                            else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp)
                )
            }
            if (job != null && totals.grandTotal <= job!!.minimumJobCharge && job!!.minimumJobCharge > 0.0) {
                Text(
                    stringResource(R.string.est2_minimum_charge_applied, currency.format(job!!.minimumJobCharge)),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun WarningsCard(warnings: List<EstimateWarning>) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Filled.WarningAmber, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer)
                Text("  " + stringResource(R.string.est_before_you_send), fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onErrorContainer)
            }
            warnings.forEach { warning ->
                val text = if (warning.reasonParts != null) {
                    val joiner = stringResource(R.string.eng2_reason_joiner)
                    val resolved = warning.reasonParts.map { (res, a) -> stringResource(res, *a.toTypedArray()) }
                    stringResource(warning.textRes, resolved.joinToString(" " + joiner + " "))
                } else stringResource(warning.textRes, *warning.args.toTypedArray())
                Text("•  $text", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onErrorContainer)
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
private fun ExportSection(
    viewModel: EstimateViewModel,
    profile: BusinessProfile,
    job: Job,
    onOpenSupplierPrices: (Long) -> Unit
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val totals by viewModel.totals.collectAsState()
    var showSignaturePad by remember { mutableStateOf(false) }

    fun shareDocument(document: com.fenceestimator.app.estimate.JobDocument) {
        viewModel.exportDocument(context, profile, document) { file ->
            val uri = PdfExporter.shareUri(context, file)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "application/pdf"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            // The system share sheet, so it can go by text, WhatsApp or email
            // -- whatever that particular customer or supplier actually uses.
            context.startActivity(Intent.createChooser(intent, context.getString(R.string.est2_send_document, context.getString(document.titleRes))))
        }
    }

    // A job that was signed and then changed cannot go anywhere until it is
    // signed again. A warning above the button was not enough: the estimate and
    // the invoice both still went out, carrying a signature for a price the
    // customer never agreed to. Nothing downstream is reachable while this is
    // true -- the signed document and the bill have to describe the same job.
    val needsResign = JobMoney.signatureIsStale(job, totals.grandTotal, totals.billableLinearFeet)

    Column {
        if (needsResign) {
            Card(
                Modifier.fillMaxWidth().padding(bottom = 8.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(
                        stringResource(R.string.est2_changed_after_signed_title),
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onErrorContainer
                    )
                    val reason = JobMoney
                        .staleSignatureReasonParts(job, totals.grandTotal, totals.billableLinearFeet)
                        .map { (res, args) -> stringResource(res, *args.toTypedArray()) }
                        .joinToString(" " + stringResource(R.string.eng2_reason_joiner) + " ")
                    Text(
                        stringResource(
                            R.string.est2_changed_after_signed_body,
                            reason,
                            job.customerName.ifBlank { stringResource(R.string.est2_the_customer) }
                        ),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onErrorContainer
                    )
                }
            }
        }

        if (job.signatureImagePath != null) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 8.dp)) {
                coil.compose.AsyncImage(
                    model = job.signatureImagePath, contentDescription = null,
                    modifier = Modifier.height(40.dp).weight(1f)
                )
                Button(onClick = { showSignaturePad = true }) {
                    Text(stringResource(if (needsResign) R.string.est2_get_new_signature else R.string.est2_re_sign))
                }
            }
        } else {
            OutlinedButton(onClick = { showSignaturePad = true }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.est_sign_to_accept))
            }
            Spacer(Modifier.height(8.dp))
        }
        // Says plainly that the figures are a guess, because they are.
        //
        // A contractor who signs a customer to a number and then finds the
        // material costs more has no way back. The catalog is close enough to
        // quote from and not close enough to bank on, so the difference is
        // stated rather than left for someone to remember.
        if (job.materialPricesConfirmedAt == null) {
            Card(
                Modifier.fillMaxWidth().padding(bottom = 8.dp),
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.tertiaryContainer
                )
            ) {
                Column(Modifier.padding(12.dp)) {
                    Text(
                        stringResource(R.string.est2_provisional_pricing),
                        style = MaterialTheme.typography.titleSmall,
                        color = MaterialTheme.colorScheme.onTertiaryContainer
                    )
                    Text(
                        stringResource(R.string.est2_provisional_pricing_body),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onTertiaryContainer
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = { onOpenSupplierPrices(job.id) },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text(stringResource(R.string.est_enter_supplier_prices)) }
                }
            }
        }

        // Four documents, named for who reads them.
        //
        // There used to be two buttons that produced nearly the same page: the
        // customer got a full material breakdown with buying prices on it, and
        // the "invoice" was that same page again under another heading. Neither
        // reader was served -- the customer agreed a price for a finished
        // fence, and the supplier is the one who sends prices back.
        Button(
            onClick = { shareDocument(com.fenceestimator.app.estimate.JobDocument.CUSTOMER_CONTRACT) },
            enabled = !needsResign,
            modifier = Modifier.fillMaxWidth()
        ) {
            Icon(Icons.Filled.Share, contentDescription = null)
            Text("  " + stringResource(R.string.est_send_contract))
        }
        // A greyed button with no reason on it reads as the app being broken.
        // The banner above says why, but it scrolls away on a long estimate and
        // the button is what the eye lands on.
        Text(
            if (needsResign) stringResource(R.string.est2_locked_price_changed)
            else stringResource(R.string.est2_contract_hint),
            style = MaterialTheme.typography.bodySmall,
            color = if (needsResign) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(8.dp))

        OutlinedButton(
            onClick = { shareDocument(com.fenceestimator.app.estimate.JobDocument.SUPPLIER_REQUEST) },
            modifier = Modifier.fillMaxWidth()
        ) {
            Icon(Icons.Filled.Share, contentDescription = null)
            Text("  " + stringResource(R.string.est_send_material_list))
        }
        Text(
            stringResource(R.string.est2_material_list_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(8.dp))

        OutlinedButton(
            onClick = { shareDocument(com.fenceestimator.app.estimate.JobDocument.CUSTOMER_INVOICE) },
            // A bill for a job nobody agreed to is how disputes start. The
            // invoice waits for the signature; the contract button stays live
            // above because it is the path TO the signature.
            enabled = !needsResign && job.signedAt != null,
            modifier = Modifier.fillMaxWidth()
        ) {
            Icon(Icons.Filled.Share, contentDescription = null)
            Text("  " + stringResource(R.string.est_send_invoice))
        }
        Text(
            when {
                needsResign -> stringResource(R.string.est2_locked_price_changed)
                job.signedAt == null -> stringResource(R.string.est2_locked_until_signed)
                else -> stringResource(R.string.est2_invoice_hint)
            },
            style = MaterialTheme.typography.bodySmall,
            color = if (needsResign || job.signedAt == null) MaterialTheme.colorScheme.error
            else MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(8.dp))

        OutlinedButton(
            onClick = { shareDocument(com.fenceestimator.app.estimate.JobDocument.WORKING_ESTIMATE) },
            modifier = Modifier.fillMaxWidth()
        ) {
            Icon(Icons.Filled.Share, contentDescription = null)
            Text("  " + stringResource(R.string.est_working_copy))
        }
        Text(
            stringResource(R.string.est2_working_copy_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
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
        title = { Text(stringResource(R.string.est_edit_line_item)) },
        text = {
            Column {
                OutlinedTextField(value = description, onValueChange = { description = it }, label = { Text(stringResource(R.string.est_description)) }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = qtyText, onValueChange = { qtyText = it }, label = { Text(stringResource(R.string.est_qty)) }, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = unit, onValueChange = { unit = it }, label = { Text(stringResource(R.string.est_unit)) }, modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = priceText, onValueChange = { priceText = it }, label = { Text(stringResource(R.string.est_unit_price)) }, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            Button(onClick = {
                val qty = qtyText.replace(',', '.').toDoubleOrNull() ?: return@Button
                val price = priceText.replace(',', '.').toDoubleOrNull() ?: return@Button
                onSave(item.copy(description = description, quantity = qty, unitPrice = price, unit = unit, isAutoGenerated = false))
            }) { Text(stringResource(R.string.action_save)) }
        },
        dismissButton = {
            Row {
                OutlinedButton(onClick = onDelete) { Text(stringResource(R.string.action_delete)) }
                Spacer(Modifier.width(8.dp))
                OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
            }
        }
    )
}

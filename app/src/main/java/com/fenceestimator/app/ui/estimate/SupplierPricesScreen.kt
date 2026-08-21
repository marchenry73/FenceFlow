package com.fenceestimator.app.ui.estimate

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import java.text.NumberFormat
import java.util.Locale

/**
 * Entering what the supplier actually quoted.
 *
 * This is the step that turns an estimate into a price. Until it happens the
 * job is costed from the catalog -- a good guess at what these things usually
 * cost, which is all you have when the customer is standing in the yard wanting
 * a number, and not what you will actually pay.
 *
 * Typing a real price here re-costs the job, and every figure downstream --
 * the deposit, the contract, the invoice -- moves with it. That is the point:
 * signing a customer to a figure and then discovering the material costs more
 * leaves a contractor with no way back.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SupplierPricesScreen(jobId: Long, onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: EstimateViewModel = viewModel(
        key = "estimate_$jobId",
        factory = GenericViewModelFactory { EstimateViewModel(app.repository, jobId) }
    )
    val job by viewModel.job.collectAsState()
    val lineItems by viewModel.lineItems.collectAsState()
    val currency = remember { NumberFormat.getCurrencyInstance(Locale.US) }

    // Typed values live here until saved, so a half-entered figure never
    // re-prices the job mid-keystroke.
    val entered = remember { mutableStateMapOf<Long, String>() }
    var reference by remember(job?.id) { mutableStateOf(job?.supplierQuoteReference.orEmpty()) }

    val currentJob = job ?: return

    val catalogTotal = lineItems.sumOf { it.quantity * it.unitPrice }
    val quotedTotal = lineItems.sumOf { item ->
        val typed = entered[item.id]?.replace(',', '.')?.toDoubleOrNull()
        item.quantity * (typed ?: item.effectiveUnitPrice)
    }
    val difference = quotedTotal - catalogTotal

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Supplier Prices") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            item {
                Text(
                    "Type in what the supplier quoted. Anything left blank keeps the " +
                        "catalog estimate, and the job stays marked provisional until " +
                        "every line has a real price.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            item {
                OutlinedTextField(
                    value = reference,
                    onValueChange = { reference = it },
                    label = { Text("Supplier / quote reference") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            }

            // The comparison that matters, kept in view while typing. A quote
            // that comes back well over the catalog is the moment to go back to
            // the customer, and it is easy to miss line by line.
            item {
                Card(
                    Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = if (difference > 0.005)
                            MaterialTheme.colorScheme.errorContainer
                        else MaterialTheme.colorScheme.secondaryContainer
                    )
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text("Estimated from catalog: ${currency.format(catalogTotal)}")
                        Text("With supplier prices: ${currency.format(quotedTotal)}")
                        if (kotlin.math.abs(difference) > 0.005) {
                            Text(
                                if (difference > 0)
                                    "That is ${currency.format(difference)} MORE than quoted. " +
                                        "Check the customer price still works before ordering."
                                else
                                    "That is ${currency.format(-difference)} less than estimated.",
                                style = MaterialTheme.typography.bodyMedium
                            )
                        }
                    }
                }
            }

            items(lineItems, key = { it.id }) { item ->
                SupplierPriceRow(
                    item = item,
                    typed = entered[item.id] ?: item.supplierUnitPrice?.let { "%.2f".format(java.util.Locale.US, it) } ?: "",
                    currency = currency,
                    onChange = { entered[item.id] = it }
                )
            }

            item {
                Button(
                    onClick = {
                        val prices = lineItems.mapNotNull { item ->
                            entered[item.id]?.trim()?.replace(',', '.')?.toDoubleOrNull()?.let { item.id to it }
                        }.toMap()
                        viewModel.applySupplierPrices(prices, reference.trim())
                        onBack()
                    },
                    modifier = Modifier.fillMaxWidth()
                ) { Text("Save supplier prices") }
            }
        }
    }
}

@Composable
private fun SupplierPriceRow(
    item: EstimateLineItem,
    typed: String,
    currency: NumberFormat,
    onChange: (String) -> Unit
) {
    Row(
        Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Column(Modifier.weight(1f)) {
            Text(item.description, style = MaterialTheme.typography.bodyMedium)
            Text(
                "${"%.1f".format(item.quantity)} ${item.unit} · " +
                    "catalog ${currency.format(item.unitPrice)}" +
                    if (item.isSupplierPriced) " · quoted" else "",
                style = MaterialTheme.typography.bodySmall,
                color = if (item.isSupplierPriced) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        OutlinedTextField(
            value = typed,
            onValueChange = { onChange(it.filter { c -> c.isDigit() || c == '.' }) },
            label = { Text("Their $") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.width(120.dp)
        )
    }
}

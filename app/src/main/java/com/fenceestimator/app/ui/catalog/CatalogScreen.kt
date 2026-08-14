package com.fenceestimator.app.ui.catalog

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.Manufacturer
import com.fenceestimator.app.data.MaterialCategory
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.estimate.ImportMatch
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import androidx.lifecycle.viewmodel.compose.viewModel
import java.text.NumberFormat
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CatalogScreen(onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: CatalogViewModel = viewModel(factory = GenericViewModelFactory { CatalogViewModel(app.repository) })
    val catalog by viewModel.catalog.collectAsState()
    val manufacturers by viewModel.manufacturers.collectAsState()
    val importMatches by viewModel.importMatches.collectAsState()
    val importError by viewModel.importError.collectAsState()
    val isImporting by viewModel.isImporting.collectAsState()
    val currency = remember { NumberFormat.getCurrencyInstance(Locale.US) }

    var editingItem by remember { mutableStateOf<MaterialItem?>(null) }
    var showNewDialog by remember { mutableStateOf(false) }
    val tabs = remember { FenceType.values().toList() }
    var selectedTab by remember { mutableStateOf(FenceType.VINYL) }

    val pdfPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) viewModel.importPdf(app, uri)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Materials Catalog") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } }
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { pdfPicker.launch("application/pdf") }) {
                Icon(Icons.Filled.Upload, contentDescription = "Import invoice PDF")
            }
        }
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            ScrollableTabRow(selectedTabIndex = tabs.indexOf(selectedTab)) {
                tabs.forEach { type ->
                    Tab(
                        selected = selectedTab == type,
                        onClick = { selectedTab = type },
                        text = { Text(type.name.replace("_", " ")) }
                    )
                }
            }
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                item {
                    Text(
                        "Prices used to price your estimates. Tap an item to edit, or import an invoice/estimate PDF to update prices in bulk.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                item {
                    Button(onClick = { showNewDialog = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("Add Custom Item")
                    }
                }
                if (isImporting) {
                    item {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            CircularProgressIndicator(modifier = Modifier.height(20.dp))
                            Text("  Reading PDF…", modifier = Modifier.padding(start = 8.dp))
                        }
                    }
                }
                val tabItems = catalog.filter { it.fenceType == selectedTab }
                if (tabItems.isEmpty()) {
                    item {
                        Text(
                            "No items for this fence type yet.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                items(tabItems.groupBy { it.category }.toList(), key = { it.first }) { (category, itemsInCategory) ->
                    Column {
                        Text(
                            category.name.replace("_", " "),
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.padding(top = 8.dp, bottom = 4.dp)
                        )
                        itemsInCategory.forEach { item ->
                            CatalogRow(item, currency, manufacturers) { editingItem = item }
                        }
                    }
                }
            }
        }
    }

    editingItem?.let { item ->
        EditItemDialog(
            item = item,
            manufacturers = manufacturers,
            onSave = { viewModel.saveItem(it); editingItem = null },
            onDelete = { viewModel.deleteItem(item); editingItem = null },
            onDuplicateForManufacturer = { copy -> viewModel.saveItem(copy); editingItem = null },
            onDismiss = { editingItem = null }
        )
    }

    if (showNewDialog) {
        EditItemDialog(
            item = MaterialItem(category = MaterialCategory.MISC, fenceType = selectedTab, name = "", unitPrice = 0.0),
            manufacturers = manufacturers,
            onSave = { viewModel.saveItem(it); showNewDialog = false },
            onDelete = { showNewDialog = false },
            onDuplicateForManufacturer = { copy -> viewModel.saveItem(copy); showNewDialog = false },
            onDismiss = { showNewDialog = false }
        )
    }

    if (importMatches.isNotEmpty() || importError != null) {
        ImportReviewDialog(
            matches = importMatches,
            error = importError,
            onApply = { selected -> viewModel.applyImportSelections(selected) },
            onDismiss = { viewModel.clearImport() }
        )
    }
}

@Composable
private fun CatalogRow(item: MaterialItem, currency: NumberFormat, manufacturers: List<Manufacturer>, onClick: () -> Unit) {
    val manufacturerName = manufacturers.firstOrNull { it.id == item.manufacturerId }?.name
    Card(onClick = onClick, modifier = Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(12.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                categoryIcon(item.category), contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(end = 12.dp)
            )
            Column(
                modifier = Modifier.weight(1f).padding(end = 8.dp)
            ) {
                Text(item.name, fontWeight = FontWeight.Medium)
                if (item.colorOrFinish.isNotBlank()) {
                    Text(item.colorOrFinish, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Box(
                    modifier = Modifier
                        .padding(top = 3.dp)
                        .background(
                            if (manufacturerName != null) MaterialTheme.colorScheme.tertiaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                            androidx.compose.foundation.shape.RoundedCornerShape(50)
                        )
                        .padding(horizontal = 8.dp, vertical = 2.dp)
                ) {
                    Text(
                        manufacturerName ?: "Default price",
                        style = MaterialTheme.typography.labelLarge,
                        color = if (manufacturerName != null) MaterialTheme.colorScheme.onTertiaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(currency.format(item.unitPrice) + " / " + item.unit, fontWeight = FontWeight.SemiBold)
                Icon(Icons.Filled.Edit, contentDescription = "Edit", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}

@Composable
private fun EditItemDialog(
    item: MaterialItem,
    manufacturers: List<Manufacturer>,
    onSave: (MaterialItem) -> Unit,
    onDelete: () -> Unit,
    onDuplicateForManufacturer: (MaterialItem) -> Unit,
    onDismiss: () -> Unit
) {
    var name by remember { mutableStateOf(item.name) }
    var priceText by remember { mutableStateOf(item.unitPrice.toString()) }
    var taxable by remember { mutableStateOf(item.taxable) }
    var unit by remember { mutableStateOf(item.unit) }
    var colorOrFinish by remember { mutableStateOf(item.colorOrFinish) }
    var coversFtText by remember { mutableStateOf(item.coversFt?.toString() ?: "") }
    var category by remember { mutableStateOf(item.category) }
    var fenceType by remember { mutableStateOf(item.fenceType) }
    var role by remember { mutableStateOf(item.role) }
    var manufacturerId by remember { mutableStateOf(item.manufacturerId) }
    var duplicateTarget by remember { mutableStateOf<Manufacturer?>(null) }

    fun currentEdits(): MaterialItem {
        val price = priceText.toDoubleOrNull() ?: item.unitPrice
        return item.copy(
            name = name, unitPrice = price, taxable = taxable, unit = unit,
            colorOrFinish = colorOrFinish, coversFt = coversFtText.toFloatOrNull(),
            category = category, fenceType = fenceType, role = role, manufacturerId = manufacturerId
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (item.id == 0L) "New Item" else "Edit Item") },
        text = {
            Column {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = unit, onValueChange = { unit = it }, label = { Text("Unit") }, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = priceText, onValueChange = { priceText = it }, label = { Text("Price ($)") }, modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(value = colorOrFinish, onValueChange = { colorOrFinish = it }, label = { Text("Color / finish (optional)") }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = coversFtText, onValueChange = { coversFtText = it },
                    label = { Text("Width/height it covers, ft (panels & fabric only)") },
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                EnumDropdown("Category", MaterialCategory.values().toList(), category, { it.name.replace("_", " ") }) { category = it }
                Spacer(Modifier.height(8.dp))
                EnumDropdown("Fence type", FenceType.values().toList(), fenceType, { it.name.replace("_", " ") }) { fenceType = it }
                Spacer(Modifier.height(8.dp))
                EnumDropdown("Role in estimate engine", MaterialRole.values().toList(), role, { it.name.replace("_", " ") }) { role = it }
                Spacer(Modifier.height(8.dp))
                EnumDropdown(
                    "Priced from",
                    listOf<Manufacturer?>(null) + manufacturers,
                    manufacturers.firstOrNull { it.id == manufacturerId },
                    { it?.name ?: "Default price (any manufacturer)" }
                ) { manufacturerId = it?.id }
                Text(
                    "A default price applies when no manufacturer-specific price exists. Tie a price to a specific manufacturer so it's used automatically when that's your preferred supplier.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Switch(checked = taxable, onCheckedChange = { taxable = it })
                    Text(" Taxable")
                }

                if (manufacturers.isNotEmpty()) {
                    Spacer(Modifier.height(12.dp))
                    Text("Also price this for another manufacturer", style = MaterialTheme.typography.titleMedium)
                    val otherManufacturers = manufacturers.filter { it.id != manufacturerId }
                    if (otherManufacturers.isNotEmpty()) {
                        EnumDropdown(
                            "Duplicate for", otherManufacturers, duplicateTarget ?: otherManufacturers.first(),
                            { it.name }
                        ) { duplicateTarget = it }
                        OutlinedButton(
                            onClick = {
                                val target = duplicateTarget ?: otherManufacturers.first()
                                onDuplicateForManufacturer(currentEdits().copy(id = 0L, manufacturerId = target.id))
                            },
                            modifier = Modifier.fillMaxWidth()
                        ) { Text("Duplicate as New Price") }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                priceText.toDoubleOrNull() ?: return@Button
                onSave(currentEdits())
            }) { Text("Save") }
        },
        dismissButton = {
            Row {
                if (item.id != 0L) {
                    OutlinedButton(onClick = onDelete) { Text("Delete") }
                    Spacer(Modifier.width(8.dp))
                }
                OutlinedButton(onClick = onDismiss) { Text("Cancel") }
            }
        }
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> EnumDropdown(label: String, options: List<T>, selected: T, display: (T) -> String, onSelect: (T) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
        OutlinedTextField(
            value = display(selected), onValueChange = {}, readOnly = true,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier.fillMaxWidth().menuAnchor()
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { option ->
                DropdownMenuItem(text = { Text(display(option)) }, onClick = { onSelect(option); expanded = false })
            }
        }
    }
}

@Composable
private fun ImportReviewDialog(
    matches: List<ImportMatch>,
    error: String?,
    onApply: (List<ImportMatch>) -> Unit,
    onDismiss: () -> Unit
) {
    val selectedFlags = remember(matches) { matches.map { mutableStateOf(it.priceChanged || it.existingMatch == null) }.toMutableList() }
    val currency = remember { NumberFormat.getCurrencyInstance(Locale.US) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Import Results") },
        text = {
            Column {
                if (error != null) Text(error, color = MaterialTheme.colorScheme.error)
                if (matches.isEmpty() && error == null) Text("No items found.")
                LazyColumn(modifier = Modifier.height(360.dp)) {
                    items(matches.size) { index ->
                        val match = matches[index]
                        var checked by selectedFlags[index]
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Checkbox(checked = checked, onCheckedChange = { checked = it })
                            Column(Modifier.weight(1f)) {
                                Text(match.parsed.rawDescription.take(60), style = MaterialTheme.typography.bodyMedium)
                                val label = if (match.existingMatch != null) {
                                    if (match.priceChanged)
                                        "${currency.format(match.existingMatch.unitPrice)} -> ${currency.format(match.parsed.rate)}"
                                    else "No change (${currency.format(match.parsed.rate)})"
                                } else {
                                    "New item: ${currency.format(match.parsed.rate)}"
                                }
                                Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                val selected = matches.filterIndexed { i, _ -> selectedFlags[i].value }
                onApply(selected)
            }) { Text("Apply Selected") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Close") } }
    )
}

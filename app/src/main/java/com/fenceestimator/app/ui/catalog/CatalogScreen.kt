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
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Upload
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
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
import androidx.compose.ui.graphics.Color
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
import com.fenceestimator.app.ui.components.label
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
    var search by remember { mutableStateOf("") }
    var showOnlyUnpriced by remember { mutableStateOf(false) }

    // Searching looks across every fence type, not just the open tab. With
    // hundreds of items, someone typing "cedar" wants the cedar, and having to
    // guess which tab it was filed under is the whole problem with tabs.
    val searching = search.isNotBlank()
    val visibleItems = remember(catalog, selectedTab, search, showOnlyUnpriced) {
        val base = when {
            searching -> {
                val needle = search.trim().lowercase()
                catalog.filter {
                    it.name.lowercase().contains(needle) ||
                        it.colorOrFinish.lowercase().contains(needle) ||
                        it.category.label.lowercase().contains(needle) ||
                        it.fenceType.label.lowercase().contains(needle)
                }
            }
            // Unpriced items are a whole-catalog problem, so this filter
            // deliberately ignores the open tab -- they need finding wherever
            // they are, not one fence type at a time.
            showOnlyUnpriced -> catalog
            else -> catalog.filter { it.fenceType == selectedTab }
        }
        if (showOnlyUnpriced) base.filter { it.unitPrice <= 0.0 } else base
    }

    // An item priced at zero is not free, it is unfilled -- and it silently
    // drags every estimate using it below cost. Worth surfacing before it is
    // quoted rather than after.
    val unpricedCount = remember(catalog) { catalog.count { it.unitPrice <= 0.0 } }

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
            OutlinedTextField(
                value = search,
                onValueChange = { search = it },
                singleLine = true,
                label = { Text("Search all materials") },
                placeholder = { Text("cedar, 4x4 post, latch...") },
                leadingIcon = { Icon(Icons.Filled.Search, contentDescription = null) },
                trailingIcon = {
                    if (searching) {
                        IconButton(onClick = { search = "" }) {
                            Icon(Icons.Filled.Close, contentDescription = "Clear search")
                        }
                    }
                },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
            )

            // The tabs are meaningless while a search is filtering across all
            // of them, and leaving one highlighted suggests the results are
            // confined to it.
            if (!searching) {
                ScrollableTabRow(selectedTabIndex = tabs.indexOf(selectedTab)) {
                    tabs.forEach { type ->
                        val count = catalog.count { it.fenceType == type }
                        Tab(
                            selected = selectedTab == type,
                            onClick = { selectedTab = type },
                            text = { Text(if (count > 0) "${type.label} ($count)" else type.label) }
                        )
                    }
                }
            }
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (!searching) {
                    item {
                        Text(
                            "Prices used to price your estimates. Tap an item to edit, or import an invoice/estimate PDF to update prices in bulk.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    if (unpricedCount > 0) {
                        item {
                            Card(
                                onClick = { showOnlyUnpriced = !showOnlyUnpriced },
                                colors = CardDefaults.cardColors(
                                    containerColor = MaterialTheme.colorScheme.errorContainer
                                ),
                                modifier = Modifier.fillMaxWidth()
                            ) {
                                Column(modifier = Modifier.padding(12.dp)) {
                                    Text(
                                        if (unpricedCount == 1) "1 item has no price set"
                                        else "$unpricedCount items have no price set",
                                        fontWeight = FontWeight.SemiBold,
                                        color = MaterialTheme.colorScheme.onErrorContainer
                                    )
                                    Text(
                                        if (showOnlyUnpriced)
                                            "Showing only those. Tap to show everything again."
                                        else
                                            "They count as $0.00 in an estimate, so any quote using one " +
                                                "comes out under cost. Tap to see just those.",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onErrorContainer
                                    )
                                }
                            }
                        }
                    }
                    item {
                        Button(onClick = { showNewDialog = true }, modifier = Modifier.fillMaxWidth()) {
                            Text("Add Custom Item")
                        }
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
                if (searching) {
                    item {
                        Text(
                            if (visibleItems.isEmpty()) "Nothing matches \"${search.trim()}\"."
                            else "${visibleItems.size} " +
                                (if (visibleItems.size == 1) "match" else "matches") +
                                " across all fence types",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                } else if (visibleItems.isEmpty()) {
                    item {
                        Text(
                            if (showOnlyUnpriced) "Every item has a price. Nothing to fix."
                            else "No items for this fence type yet.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                items(visibleItems.groupBy { it.category }.toList(), key = { it.first }) { (category, itemsInCategory) ->
                    Column {
                        Text(
                            category.label,
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.padding(top = 8.dp, bottom = 4.dp)
                        )
                        itemsInCategory.forEach { item ->
                            // Which fence type an item belongs to is obvious
                            // from the tab, but not from a search result.
                            CatalogRow(
                                item = item,
                                currency = currency,
                                manufacturers = manufacturers,
                                showFenceType = searching || showOnlyUnpriced
                            ) { editingItem = item }
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
private fun CatalogRow(
    item: MaterialItem,
    currency: NumberFormat,
    manufacturers: List<Manufacturer>,
    showFenceType: Boolean = false,
    onClick: () -> Unit
) {
    val manufacturerName = manufacturers.firstOrNull { it.id == item.manufacturerId }?.name
    val unpriced = item.unitPrice <= 0.0
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
                if (showFenceType) {
                    Text(
                        item.fenceType.label,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
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
                Text(
                    if (unpriced) "No price" else currency.format(item.unitPrice) + " / " + item.unit,
                    fontWeight = FontWeight.SemiBold,
                    // "No price" rather than "$0.00 / ea", because $0.00 reads
                    // as a decision and this is an omission.
                    color = if (unpriced) MaterialTheme.colorScheme.error else Color.Unspecified
                )
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
        val price = priceText.replace(',', '.').toDoubleOrNull() ?: item.unitPrice
        return item.copy(
            name = name, unitPrice = price, taxable = taxable, unit = unit,
            colorOrFinish = colorOrFinish, coversFt = coversFtText.replace(',', '.').toFloatOrNull(),
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
                priceText.replace(',', '.').toDoubleOrNull() ?: return@Button
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

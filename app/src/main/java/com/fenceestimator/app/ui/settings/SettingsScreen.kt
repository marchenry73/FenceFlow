package com.fenceestimator.app.ui.settings

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.data.AppLanguage
import com.fenceestimator.app.data.BackupManager
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.CsvExporter
import com.fenceestimator.app.data.DataExporter
import com.fenceestimator.app.data.PricingTier
import com.fenceestimator.app.data.ThemeMode
import com.fenceestimator.app.ui.components.DraftNumberField
import com.fenceestimator.app.ui.components.DraftTextField
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onOpenManufacturers: () -> Unit,
    onOpenEmployees: () -> Unit,
    onOpenAccount: () -> Unit,
    onOpenHelp: () -> Unit,
    onOpenFeedback: () -> Unit
) {
    val app = currentApp()
    val viewModel: SettingsViewModel = viewModel(
        factory = GenericViewModelFactory { SettingsViewModel(app.settingsStore, app.repository, app.applicationScope) }
    )
    val profile by viewModel.profile.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(Unit) {
        viewModel.saved.collect {
            snackbarHostState.showSnackbar("Settings saved")
        }
    }
    val pricingTiers by viewModel.pricingTiers.collectAsState()
    val manufacturers by viewModel.manufacturers.collectAsState()
    val loadedProfile = profile

    if (loadedProfile == null) {
        // Real persisted settings haven't loaded yet -- do NOT seed the edit buffer
        // with a placeholder default here, or a fast reload can make already-saved
        // settings look like they were never saved.
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }

    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    var showRestoreWarning by remember { mutableStateOf<android.net.Uri?>(null) }
    var showRestoreComplete by remember { mutableStateOf(false) }

    val backupLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        if (uri != null) {
            coroutineScope.launch {
                val result = BackupManager.backup(context, app.repository, uri)
                snackbarHostState.showSnackbar(if (result.isSuccess) "Backup saved" else "Backup failed: ${result.exceptionOrNull()?.message}")
            }
        }
    }
    val restoreLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) showRestoreWarning = uri
    }
    val csvLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri ->
        if (uri != null) {
            coroutineScope.launch {
                val expenses = app.repository.getAllExpenses()
                val jobs = app.repository.observeJobs().first()
                val result = CsvExporter.exportExpenses(context, expenses, jobs, uri)
                snackbarHostState.showSnackbar(if (result.isSuccess) "Expenses exported" else "Export failed: ${result.exceptionOrNull()?.message}")
            }
        }
    }
    var exporting by remember { mutableStateOf(false) }
    val fullExportLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        if (uri != null) {
            coroutineScope.launch {
                exporting = true
                val result = runCatching {
                    DataExporter.Bundle(
                        jobs = app.repository.getAllJobs(),
                        payments = app.repository.getAllPayments(),
                        expenses = app.repository.getAllExpenses(),
                        timeEntries = app.repository.getAllTimeEntries(),
                        changeOrders = app.repository.getAllChangeOrdersByJob().values.flatten(),
                        lineItems = app.repository.getAllLineItemsByJob().values.flatten(),
                        employees = app.repository.getAllEmployees()
                    )
                }.mapCatching { DataExporter.export(context, it, uri).getOrThrow() }
                exporting = false
                snackbarHostState.showSnackbar(
                    if (result.isSuccess) "Your data was exported"
                    else "Export failed: ${result.exceptionOrNull()?.message}"
                )
            }
        }
    }

    // Seeded exactly once, the first time we reach this line with real data.
    // Never re-seeded from upstream after that, so it won't reset mid-edit.
    var local by remember { mutableStateOf(loadedProfile) }
    var editingTier by remember { mutableStateOf<PricingTier?>(null) }
    var showNewTier by remember { mutableStateOf(false) }
    var manufacturerMenuExpanded by remember { mutableStateOf(false) }

    // Saves itself shortly after you stop changing things.
    //
    // The Save button stays -- people want to see something confirm it -- but
    // relying on it means a setting changed and then backed out of is lost, and
    // it is never obvious that it was. Debounced so a burst of typing is one
    // write rather than one per keystroke.
    androidx.compose.runtime.LaunchedEffect(local) {
        if (local == loadedProfile) return@LaunchedEffect
        kotlinx.coroutines.delay(1_200)
        viewModel.save(local)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                SectionCard("Security") {
                    Text(
                        "Locks the app after a period of inactivity. Useful on crew phones that get left in trucks.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    SettingsEnumDropdown(
                        "Auto-lock after",
                        listOf(0, 1, 5, 15, 30, 60),
                        local.autoLockMinutes,
                        { if (it == 0) "Never" else "$it minute${if (it == 1) "" else "s"}" }
                    ) { local = local.copy(autoLockMinutes = it) }

                    val biometricReady = remember { com.fenceestimator.app.ui.lock.biometricAvailable(context) }
                    if (biometricReady) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Unlock with fingerprint or face", modifier = Modifier.weight(1f))
                            androidx.compose.material3.Switch(
                                checked = local.biometricUnlockEnabled,
                                onCheckedChange = { local = local.copy(biometricUnlockEnabled = it) }
                            )
                        }
                        Text(
                            "Your device PIN or pattern always works as a fallback, so a fingerprint that stops reading can't lock you out mid-job.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    } else {
                        Text(
                            "This device has no fingerprint or face unlock set up, so biometric unlock isn't available.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
            item {
                SectionCard("Help & Feedback") {
                    OutlinedButton(onClick = onOpenHelp, modifier = Modifier.fillMaxWidth()) {
                        Text("How to Use the App + Fence Basics")
                    }
                    OutlinedButton(onClick = onOpenFeedback, modifier = Modifier.fillMaxWidth()) {
                        Text("Send a Suggestion or Complaint")
                    }
                }
            }
            item {
                SectionCard("Account & Team") {
                    Text(
                        "Sign in to share jobs with your crew across phones, with separate access levels for field and office. Optional -- the app works offline without it.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedButton(onClick = onOpenAccount, modifier = Modifier.fillMaxWidth()) {
                        Text("Manage Account & Team")
                    }
                }
            }
            item {
                SectionCard("Business Profile") {
                    DraftTextField(stableKey = "biz_name", initialValue = local.businessName, label = "Business name", modifier = Modifier.fillMaxWidth()) { local = local.copy(businessName = it) }
                    DraftTextField(stableKey = "biz_owner", initialValue = local.ownerName, label = "Owner name", modifier = Modifier.fillMaxWidth()) { local = local.copy(ownerName = it) }
                    DraftTextField(stableKey = "biz_phone", initialValue = local.phone, label = "Phone", keyboardType = KeyboardType.Phone, modifier = Modifier.fillMaxWidth()) { local = local.copy(phone = it) }
                    DraftTextField(stableKey = "biz_email", initialValue = local.email, label = "Email", keyboardType = KeyboardType.Email, modifier = Modifier.fillMaxWidth()) { local = local.copy(email = it) }
                    DraftTextField(stableKey = "biz_license", initialValue = local.licenseNumber, label = "License number", modifier = Modifier.fillMaxWidth()) { local = local.copy(licenseNumber = it) }
                }
            }
            item {
                SectionCard("Appearance & Language") {
                    SettingsEnumDropdown(
                        "Theme", listOf(ThemeMode.SYSTEM, ThemeMode.LIGHT, ThemeMode.DARK), local.themeMode,
                        { it.name.lowercase().replaceFirstChar { c -> c.uppercase() } }
                    ) { local = local.copy(themeMode = it) }
                    SettingsEnumDropdown(
                        "Language", AppLanguage.values().toList(), local.language,
                        { it.displayName }
                    ) { newLanguage ->
                        val wasDefault = local.orderEmailTemplate == BusinessProfile.defaultOrderTemplate(local.language) &&
                            local.hoaEmailTemplate == BusinessProfile.defaultHoaTemplate(local.language) &&
                            local.reviewRequestTemplate == BusinessProfile.defaultReviewTemplate(local.language)
                        local = if (wasDefault) {
                            local.copy(
                                language = newLanguage,
                                orderEmailTemplate = BusinessProfile.defaultOrderTemplate(newLanguage),
                                hoaEmailTemplate = BusinessProfile.defaultHoaTemplate(newLanguage),
                                reviewRequestTemplate = BusinessProfile.defaultReviewTemplate(newLanguage)
                            )
                        } else {
                            local.copy(language = newLanguage)
                        }
                    }
                    Text(
                        "Language currently switches your exported PDF labels and the default email/text templates below -- it does not yet translate every screen in the app.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item {
                SectionCard("Defaults for New Jobs") {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "tax", label = "Tax rate (%)", initialValue = local.defaultTaxRatePercent.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultTaxRatePercent = it.toDouble())
                        }
                        DraftNumberField(stableKey = "markup", label = "Markup (%)", initialValue = local.defaultMarkupPercent.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultMarkupPercent = it.toDouble())
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "panelw", label = "Panel width (ft)", initialValue = local.defaultPanelWidthFt, modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultPanelWidthFt = it)
                        }
                        DraftNumberField(stableKey = "panelh", label = "Panel height (ft)", initialValue = local.defaultPanelHeightFt, modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultPanelHeightFt = it)
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "spacing", label = "Post spacing (ft)", initialValue = local.defaultPostSpacingFt, modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultPostSpacingFt = it)
                        }
                        DraftNumberField(stableKey = "bags", label = "Concrete bags/post", initialValue = local.defaultConcreteBagsPerPost, modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultConcreteBagsPerPost = it)
                        }
                    }
                    DraftNumberField(stableKey = "labor", label = "Default labor rate ($/ft)", initialValue = local.defaultLaborRatePerFt.toFloat(), modifier = Modifier.fillMaxWidth()) {
                        local = local.copy(defaultLaborRatePerFt = it.toDouble())
                    }
                    DraftNumberField(stableKey = "minjob", label = "Minimum job charge ($)", initialValue = local.defaultMinimumJobCharge.toFloat(), modifier = Modifier.fillMaxWidth()) {
                        local = local.copy(defaultMinimumJobCharge = it.toDouble())
                    }
                }
            }
            item {
                SectionCard("How Fast Your Crew Works") {
                    Text(
                        "These drive the estimated hours on every job, and whether it warns you " +
                            "that a date can't be finished. Every crew is different — a schedule " +
                            "built on someone else's numbers is a schedule that slips.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "ftday", label = "Feet per day", initialValue = local.feetPerDay.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(feetPerDay = it.toDouble())
                        }
                        DraftNumberField(stableKey = "workday", label = "Hours per day", initialValue = local.workdayHours.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(workdayHours = it.toDouble())
                        }
                    }
                    DraftNumberField(stableKey = "breaks", label = "Break hours per day (lunch etc.)", initialValue = local.breakHoursPerDay.toFloat(), modifier = Modifier.fillMaxWidth()) {
                        local = local.copy(breakHoursPerDay = it.toDouble())
                    }
                    Text(
                        "Breaks come off the working day, so ${"%.1f".format(
                            (local.workdayHours - local.breakHoursPerDay).coerceAtLeast(1.0)
                        )} hours a day are actual install time.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "gatehrs", label = "Hours per gate", initialValue = local.hoursPerGate.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(hoursPerGate = it.toDouble())
                        }
                        DraftNumberField(stableKey = "cornerhrs", label = "Hours per corner", initialValue = local.hoursPerCorner.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(hoursPerCorner = it.toDouble())
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "treehrs", label = "Hours per tree", initialValue = local.hoursPerTree.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(hoursPerTree = it.toDouble())
                        }
                        DraftNumberField(stableKey = "obshrs", label = "Hours per obstacle", initialValue = local.hoursPerObstacle.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(hoursPerObstacle = it.toDouble())
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "setuphrs", label = "Setup hours per job", initialValue = local.setupHours.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(setupHours = it.toDouble())
                        }
                        DraftNumberField(stableKey = "teardownhrs", label = "Teardown hrs/ft", initialValue = local.teardownHoursPerFoot.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(teardownHoursPerFoot = it.toDouble())
                        }
                    }
                    Text(
                        "Trees and obstacles are counted from the markers placed on the drawing, " +
                            "so mark them during the walkthrough and the hours follow.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item {
                SectionCard("Pricing Tiers & Discounts") {
                    Text(
                        "Used per job to set labor rate, markup, and any discount (family, church, military, commercial, etc).",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    pricingTiers.forEach { tier ->
                        Card(onClick = { editingTier = tier }, modifier = Modifier.fillMaxWidth()) {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(12.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column {
                                    Text(tier.name.ifBlank { "Unnamed tier" }, fontWeight = FontWeight.Medium)
                                    Text(
                                        "Labor \$${tier.laborRatePerFt}/ft · Markup ${tier.markupPercent}% · Discount ${tier.discountPercent}%",
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                    }
                    OutlinedButton(onClick = { showNewTier = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("+ Add Pricing Tier")
                    }
                }
            }
            item {
                SectionCard("Tools & Materials") {
                    Text(
                        "Copied onto every job's checklist, so nothing gets left in the yard.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    // Chips rather than a wall of text.
                    //
                    // A newline-separated blob is quick to build and miserable to
                    // use: you cannot see at a glance whether the ladder is on the
                    // list, and removing one item means editing text around it.
                    // Each tool as its own thing is how people think about a
                    // toolbox.
                    val tools = local.defaultToolsListCsv.split(",")
                        .map { it.trim() }.filter { it.isNotBlank() }

                    androidx.compose.foundation.layout.FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(6.dp)
                    ) {
                        tools.forEach { tool ->
                            androidx.compose.material3.InputChip(
                                selected = false,
                                onClick = {
                                    local = local.copy(
                                        defaultToolsListCsv = tools.filter { it != tool }.joinToString(",")
                                    )
                                },
                                label = { Text(tool) }
                            )
                        }
                    }

                    var newTool by remember { mutableStateOf("") }
                    Row(
                        Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        OutlinedTextField(
                            value = newTool,
                            onValueChange = { newTool = it },
                            label = { Text("Add a tool") },
                            singleLine = true,
                            modifier = Modifier.weight(1f)
                        )
                        Button(
                            enabled = newTool.isNotBlank(),
                            onClick = {
                                local = local.copy(
                                    defaultToolsListCsv = (tools + newTool.trim()).joinToString(",")
                                )
                                newTool = ""
                            }
                        ) { Text("Add") }
                    }
                    Text(
                        "${tools.size} on the list. Tap one to remove it.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                // Which figures the home screen shows.
                //
                // A dashboard showing everything shows nothing -- the number
                // somebody checks every morning differs by business, and a fixed
                // set means most of it becomes scenery they look past.
                SectionCard("Home Screen") {
                    Text(
                        "Pick the figures worth seeing every morning.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    val chosen = com.fenceestimator.app.data.HomeCard.parse(local.homeCardsCsv)
                    com.fenceestimator.app.data.HomeCard.values().forEach { card ->
                        Row(
                            Modifier.fillMaxWidth().padding(vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(card.label, style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    card.explains,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            androidx.compose.material3.Switch(
                                checked = card in chosen,
                                onCheckedChange = { on ->
                                    val next = if (on) chosen + card else chosen - card
                                    local = local.copy(
                                        homeCardsCsv = next.joinToString(",") { it.name }
                                    )
                                }
                            )
                        }
                    }
                }
            }
            item {
                SectionCard("Ordering") {
                    Text("Preferred manufacturer picks its prices first when available, and is who order emails go to.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val selectedManufacturer = manufacturers.firstOrNull { it.id == local.preferredManufacturerId }
                    ExposedDropdownMenuBox(expanded = manufacturerMenuExpanded, onExpandedChange = { manufacturerMenuExpanded = it }) {
                        OutlinedTextField(
                            value = selectedManufacturer?.name ?: "None selected", onValueChange = {}, readOnly = true,
                            label = { Text("Preferred manufacturer") },
                            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = manufacturerMenuExpanded) },
                            modifier = Modifier.fillMaxWidth().menuAnchor()
                        )
                        DropdownMenu(expanded = manufacturerMenuExpanded, onDismissRequest = { manufacturerMenuExpanded = false }) {
                            manufacturers.forEach { m ->
                                DropdownMenuItem(text = { Text(m.name) }, onClick = { local = local.copy(preferredManufacturerId = m.id); manufacturerMenuExpanded = false })
                            }
                        }
                    }
                    OutlinedButton(onClick = onOpenManufacturers, modifier = Modifier.fillMaxWidth()) {
                        Text("Manage Manufacturers & Suppliers")
                    }
                    OutlinedButton(onClick = onOpenEmployees, modifier = Modifier.fillMaxWidth()) {
                        Text("Manage Crew & Employees")
                    }
                    DraftTextField(
                        stableKey = "order_tmpl", initialValue = local.orderEmailTemplate,
                        label = "Order email template", minLines = 5, modifier = Modifier.fillMaxWidth()
                    ) { local = local.copy(orderEmailTemplate = it) }
                    Text(
                        "Placeholders: {customerName} {address} {lineItems} {total} {businessName}",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    DraftTextField(
                        stableKey = "hoa_tmpl", initialValue = local.hoaEmailTemplate,
                        label = "HOA approval email template", minLines = 5, modifier = Modifier.fillMaxWidth()
                    ) { local = local.copy(hoaEmailTemplate = it) }
                    Text(
                        "Placeholders: {address} {fenceType} {height} {material} {businessName} {phone}",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item {
                SectionCard("Review Requests") {
                    DraftTextField(
                        stableKey = "review_tmpl", initialValue = local.reviewRequestTemplate,
                        label = "Review request message", minLines = 3, modifier = Modifier.fillMaxWidth()
                    ) { local = local.copy(reviewRequestTemplate = it) }
                    Text(
                        "Placeholders: {customerName} {businessName}. Send it from a job once it's complete.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item {
                SectionCard("Card Payments (Square)") {
                    Text(
                        "Connect your Square account and FenceFlow can create a payment link for the exact balance due, " +
                            "straight from the job. Money goes from the customer to Square to your bank -- the app never holds it.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        "Get your token free at developer.squareup.com -- sign in with your normal Square login, create an " +
                            "application, then copy the Production Access Token. There is no paid plan for this.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    DraftTextField(
                        stableKey = "square_token", initialValue = local.squareAccessToken,
                        label = "Square access token", modifier = Modifier.fillMaxWidth()
                    ) { local = local.copy(squareAccessToken = it) }
                    Text(
                        "Stored on this phone only. It is never uploaded to the FenceFlow cloud or shared with your crew.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    if (local.squareLocationId.isNotBlank()) {
                        Text(
                            "Connected. Location: ${local.squareLocationId}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary
                        )
                    }
                    OutlinedButton(
                        onClick = {
                            coroutineScope.launch {
                                val result = com.fenceestimator.app.payments.SquarePayments
                                    .firstLocationId(local.squareAccessToken.trim())
                                result.fold(
                                    onSuccess = { locationId ->
                                        local = local.copy(squareLocationId = locationId)
                                        viewModel.save(local)
                                        snackbarHostState.showSnackbar("Square connected")
                                    },
                                    onFailure = {
                                        snackbarHostState.showSnackbar(it.message ?: "Couldn't connect to Square")
                                    }
                                )
                            }
                        },
                        enabled = local.squareAccessToken.isNotBlank(),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("Test & Connect Square") }
                }
            }
            item {
                SectionCard("Export Your Data") {
                    Text(
                        "Everything you have -- jobs, payments, expenses, crew hours, change orders and materials -- as a set of spreadsheets you can open in Excel, Numbers or Google Sheets.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        "Your records are yours. You never need to ask us for a copy.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Button(
                        onClick = {
                            val name = "fenceflow_export_${SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())}.zip"
                            fullExportLauncher.launch(name)
                        },
                        enabled = !exporting,
                        modifier = Modifier.fillMaxWidth()
                    ) { Text(if (exporting) "Exporting..." else "Export Everything") }

                    HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

                    Text(
                        "Just the expenses, as a single CSV for a bookkeeper or tax software.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedButton(
                        onClick = {
                            val name = "fence_flow_expenses_${SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())}.csv"
                            csvLauncher.launch(name)
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("Export Expenses Only (CSV)") }
                }
            }
            item {
                SectionCard("Backup & Restore") {
                    Text(
                        "Local only -- no account, no cloud service. Back up to save all your jobs, customers, and catalog to a file you choose (Google Drive, Dropbox, local storage -- wherever you pick). Restore replaces everything currently on this phone.",
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Button(
                        onClick = {
                            val name = "fence_estimator_backup_${SimpleDateFormat("yyyy-MM-dd_HHmm", Locale.US).format(Date())}.db"
                            backupLauncher.launch(name)
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("Back Up Now") }
                    OutlinedButton(onClick = { restoreLauncher.launch(arrayOf("*/*")) }, modifier = Modifier.fillMaxWidth()) {
                        Text("Restore From Backup")
                    }
                }
            }
            item {
                // Saving is the end of the job, so leave. Sitting on the same
                // screen afterwards reads as "did that work?" and invites a
                // second press.
                Button(
                    onClick = { viewModel.save(local); onBack() },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text("Save Settings")
                }
            }
            item {
                // Quiet, at the very bottom, but findable. Worth having when
                // somebody reports a problem: the first useful question is
                // always which build they are on.
                //
                // The build number is shown as well as the name because the
                // number is what the update check actually compares.
                Text(
                    "FenceFlow " + com.fenceestimator.app.BuildConfig.VERSION_NAME +
                        "  (build " + com.fenceestimator.app.BuildConfig.VERSION_CODE + ")",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 24.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center
                )
            }
        }
    }

    showRestoreWarning?.let { uri ->
        AlertDialog(
            onDismissRequest = { showRestoreWarning = null },
            title = { Text("Replace all current data?") },
            text = { Text("Restoring will overwrite every job, customer, and catalog entry currently on this phone with what's in the backup file. This can't be undone. Continue?") },
            confirmButton = {
                Button(onClick = {
                    showRestoreWarning = null
                    coroutineScope.launch {
                        val result = BackupManager.restore(context, uri)
                        if (result.isSuccess) showRestoreComplete = true
                        else snackbarHostState.showSnackbar("Restore failed: ${result.exceptionOrNull()?.message}")
                    }
                }) { Text("Restore") }
            },
            dismissButton = { OutlinedButton(onClick = { showRestoreWarning = null }) { Text("Cancel") } }
        )
    }

    if (showRestoreComplete) {
        AlertDialog(
            onDismissRequest = { },
            title = { Text("Restore complete") },
            text = { Text("Please fully close this app (swipe it away from Recent Apps) and reopen it for the restored data to load.") },
            confirmButton = { Button(onClick = { showRestoreComplete = false }) { Text("OK") } }
        )
    }

    editingTier?.let { tier ->
        EditTierDialog(
            tier = tier,
            onSave = { viewModel.saveTier(it); editingTier = null },
            onDelete = { viewModel.deleteTier(tier); editingTier = null },
            onDismiss = { editingTier = null }
        )
    }
    if (showNewTier) {
        EditTierDialog(
            tier = PricingTier(sortOrder = pricingTiers.size),
            onSave = { viewModel.saveTier(it); showNewTier = false },
            onDelete = { showNewTier = false },
            onDismiss = { showNewTier = false }
        )
    }
}

/**
 * Every settings section collapses.
 *
 * Fourteen sections open at once is several screens of scrolling to reach the
 * one you want, and the thing you came for is buried among thirteen things you
 * did not. Closed by default, remembered while the screen is open, with a
 * one-line summary so a shut section still tells you what is inside.
 */
@Composable
private fun SectionCard(
    title: String,
    subtitle: String = "",
    startExpanded: Boolean = false,
    content: @Composable () -> Unit
) {
    var expanded by rememberSaveable(title) { mutableStateOf(startExpanded) }
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                Modifier.fillMaxWidth().clickable { expanded = !expanded },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(Modifier.weight(1f)) {
                    Text(title, style = MaterialTheme.typography.titleMedium)
                    if (!expanded && subtitle.isNotBlank()) {
                        Text(
                            subtitle,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                Icon(
                    if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                    contentDescription = if (expanded) "Collapse $title" else "Expand $title"
                )
            }
            if (expanded) content()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun <T> SettingsEnumDropdown(label: String, options: List<T>, selected: T, display: (T) -> String, onSelect: (T) -> Unit) {
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
private fun EditTierDialog(
    tier: PricingTier,
    onSave: (PricingTier) -> Unit,
    onDelete: () -> Unit,
    onDismiss: () -> Unit
) {
    var name by remember { mutableStateOf(tier.name) }
    var laborRate by remember { mutableStateOf(tier.laborRatePerFt.toString()) }
    var laborFlat by remember { mutableStateOf(tier.laborFlatFee.toString()) }
    var markup by remember { mutableStateOf(tier.markupPercent.toString()) }
    var discount by remember { mutableStateOf(tier.discountPercent.toString()) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (tier.id == 0L) "New Pricing Tier" else "Edit Pricing Tier") },
        text = {
            Column {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name (Residential, Commercial, Family...)") }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = laborRate, onValueChange = { laborRate = it }, label = { Text("Labor \$/ft") }, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = laborFlat, onValueChange = { laborFlat = it }, label = { Text("Labor flat fee") }, modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = markup, onValueChange = { markup = it }, label = { Text("Markup %") }, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = discount, onValueChange = { discount = it }, label = { Text("Discount %") }, modifier = Modifier.weight(1f))
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                onSave(
                    tier.copy(
                        name = name,
                        laborRatePerFt = laborRate.toDoubleOrNull() ?: 0.0,
                        laborFlatFee = laborFlat.toDoubleOrNull() ?: 0.0,
                        markupPercent = markup.toDoubleOrNull() ?: 0.0,
                        discountPercent = discount.toDoubleOrNull() ?: 0.0
                    )
                )
            }) { Text("Save") }
        },
        dismissButton = {
            Row {
                if (tier.id != 0L) {
                    OutlinedButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = null) }
                    Spacer(Modifier.width(8.dp))
                }
                OutlinedButton(onClick = onDismiss) { Text("Cancel") }
            }
        }
    )
}

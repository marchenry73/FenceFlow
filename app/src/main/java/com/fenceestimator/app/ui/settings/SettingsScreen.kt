package com.fenceestimator.app.ui.settings

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Storefront
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Sell
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.Handyman
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.LocalShipping
import androidx.compose.material.icons.filled.Palette
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.FileDownload
import androidx.compose.material.icons.filled.Backup
import androidx.compose.material.icons.filled.HelpOutline
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
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
import com.fenceestimator.app.ui.components.explains
import com.fenceestimator.app.ui.components.label
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
    val savedMessage = stringResource(R.string.settings_saved)
    val savedNotSyncedMessage = stringResource(R.string.set_saved_not_synced)

    LaunchedEffect(Unit) {
        viewModel.saved.collect { synced ->
            snackbarHostState.showSnackbar(if (synced) savedMessage else savedNotSyncedMessage)
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
                snackbarHostState.showSnackbar(
                    if (result.isSuccess) context.getString(R.string.set_backup_saved)
                    else context.getString(R.string.set_backup_failed, result.exceptionOrNull()?.message)
                )
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
                snackbarHostState.showSnackbar(
                    if (result.isSuccess) context.getString(R.string.set_expenses_exported)
                    else context.getString(R.string.set_export_failed, result.exceptionOrNull()?.message)
                )
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
                    if (result.isSuccess) context.getString(R.string.set_data_exported)
                    else context.getString(R.string.set_export_failed, result.exceptionOrNull()?.message)
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
    var lastSaved by remember { mutableStateOf(loadedProfile) }
    androidx.compose.runtime.LaunchedEffect(local) {
        if (local == lastSaved) return@LaunchedEffect
        kotlinx.coroutines.delay(1_200)
        viewModel.save(local)
        lastSaved = local
    }

    // The debounce above is a coroutine living in this composition, so leaving
    // the screen inside that second and a bit cancels it and the change is
    // gone -- with no sign it ever happened. And that is exactly when people
    // leave: they came to change one number, changed it, and pressed back.
    // Flushed on the way out instead. The save itself is uncancellable and
    // runs on the application scope, so it finishes after this screen is gone.
    val pending = androidx.compose.runtime.rememberUpdatedState(local)
    val saved = androidx.compose.runtime.rememberUpdatedState(lastSaved)
    androidx.compose.runtime.DisposableEffect(Unit) {
        onDispose {
            if (pending.value != saved.value) viewModel.save(pending.value)
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item { GroupHeading(stringResource(R.string.set_group_business)) }
            item {
                SectionCard(stringResource(R.string.settings_business_profile), icon = Icons.Filled.Storefront) {
                    DraftTextField(stableKey = "biz_name", initialValue = local.businessName, label = stringResource(R.string.set_business_name), modifier = Modifier.fillMaxWidth()) { local = local.copy(businessName = it) }
                    DraftTextField(stableKey = "biz_owner", initialValue = local.ownerName, label = stringResource(R.string.set_owner_name), modifier = Modifier.fillMaxWidth()) { local = local.copy(ownerName = it) }
                    DraftTextField(stableKey = "biz_phone", initialValue = local.phone, label = stringResource(R.string.field_phone), keyboardType = KeyboardType.Phone, modifier = Modifier.fillMaxWidth()) { local = local.copy(phone = it) }
                    DraftTextField(stableKey = "biz_email", initialValue = local.email, label = stringResource(R.string.field_email), keyboardType = KeyboardType.Email, modifier = Modifier.fillMaxWidth()) { local = local.copy(email = it) }
                    DraftTextField(stableKey = "biz_license", initialValue = local.licenseNumber, label = stringResource(R.string.set_license_number), modifier = Modifier.fillMaxWidth()) { local = local.copy(licenseNumber = it) }
                }
            }
            item {
                SectionCard(stringResource(R.string.settings_account_team), icon = Icons.Filled.Group) {
                    Text(
                        stringResource(R.string.set_account_explain),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedButton(onClick = onOpenAccount, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.set_manage_account))
                    }
                    // This lived under "Ordering", between the preferred
                    // manufacturer and the order-email template, because it sat
                    // next to Manage Manufacturers and both open a list. But
                    // one is suppliers and the other is people's pay, and
                    // nobody looks for a wage under Ordering -- it was reported
                    // as the app simply not having the option.
                    //
                    // Crew management is a Crew-plan feature; a Solo company
                    // has no seats to manage (the server refuses joins too).
                    // Hiding the row outright used to read as the app simply
                    // not having the option -- this says what it is and where
                    // to get it instead.
                    if (com.fenceestimator.app.ui.components.LocalEntitlements.current.timeAndCrew) {
                        OutlinedButton(onClick = onOpenEmployees, modifier = Modifier.fillMaxWidth()) {
                            Text(stringResource(R.string.set_manage_crew))
                        }
                    } else {
                        com.fenceestimator.app.ui.components.LockedNote(
                            feature = stringResource(R.string.set_manage_crew),
                            plan = stringResource(R.string.plan_crew)
                        )
                    }
                }
            }
            item {
                SectionCard(stringResource(R.string.set_pricing_tiers), icon = Icons.Filled.Sell) {
                    Text(
                        stringResource(R.string.set_pricing_tiers_explain),
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
                                    Text(tier.name.ifBlank { stringResource(R.string.set_unnamed_tier) }, fontWeight = FontWeight.Medium)
                                    Text(
                                        stringResource(
                                            R.string.set_tier_summary,
                                            tier.laborRatePerFt.toString(),
                                            tier.markupPercent.toString(),
                                            tier.discountPercent.toString()
                                        ),
                                        style = MaterialTheme.typography.bodyMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant
                                    )
                                }
                            }
                        }
                    }
                    OutlinedButton(onClick = { showNewTier = true }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.set_add_pricing_tier))
                    }
                }
            }
            item { GroupHeading(stringResource(R.string.set_group_estimating)) }
            item {
                SectionCard(stringResource(R.string.set_defaults_new_jobs), icon = Icons.Filled.Tune) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "tax", label = stringResource(R.string.set_tax_rate), initialValue = local.defaultTaxRatePercent.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultTaxRatePercent = it.toDouble())
                        }
                        DraftNumberField(stableKey = "markup", label = stringResource(R.string.set_markup_pct), initialValue = local.defaultMarkupPercent.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultMarkupPercent = it.toDouble())
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "panelw", label = stringResource(R.string.set_panel_width), initialValue = local.defaultPanelWidthFt, modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultPanelWidthFt = it)
                        }
                        DraftNumberField(stableKey = "panelh", label = stringResource(R.string.set_panel_height), initialValue = local.defaultPanelHeightFt, modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultPanelHeightFt = it)
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "spacing", label = stringResource(R.string.set_post_spacing), initialValue = local.defaultPostSpacingFt, modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultPostSpacingFt = it)
                        }
                        DraftNumberField(stableKey = "bags", label = stringResource(R.string.set_concrete_bags), initialValue = local.defaultConcreteBagsPerPost, modifier = Modifier.weight(1f)) {
                            local = local.copy(defaultConcreteBagsPerPost = it)
                        }
                    }
                    DraftNumberField(stableKey = "labor", label = stringResource(R.string.set_default_labor_rate), initialValue = local.defaultLaborRatePerFt.toFloat(), modifier = Modifier.fillMaxWidth()) {
                        local = local.copy(defaultLaborRatePerFt = it.toDouble())
                    }
                    DraftNumberField(stableKey = "minjob", label = stringResource(R.string.set_min_job_charge), initialValue = local.defaultMinimumJobCharge.toFloat(), modifier = Modifier.fillMaxWidth()) {
                        local = local.copy(defaultMinimumJobCharge = it.toDouble())
                    }
                }
            }
            item {
                SectionCard(stringResource(R.string.set_tools_materials), icon = Icons.Filled.Handyman) {
                    Text(
                        stringResource(R.string.set_tools_explain),
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
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)
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
                            label = { Text(stringResource(R.string.set_add_a_tool)) },
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
                        ) { Text(stringResource(R.string.action_add)) }
                    }
                    Text(
                        stringResource(R.string.set_tools_count, tools.size),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

            }
            item {
                SectionCard(stringResource(R.string.set_crew_speed), icon = Icons.Filled.Speed) {
                    Text(
                        stringResource(R.string.set_crew_speed_explain),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "ftday", label = stringResource(R.string.set_feet_per_day), initialValue = local.feetPerDay.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(feetPerDay = it.toDouble())
                        }
                        DraftNumberField(stableKey = "workday", label = stringResource(R.string.set_hours_per_day), initialValue = local.workdayHours.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(workdayHours = it.toDouble())
                        }
                    }
                    DraftNumberField(stableKey = "breaks", label = stringResource(R.string.set_break_hours), initialValue = local.breakHoursPerDay.toFloat(), modifier = Modifier.fillMaxWidth()) {
                        local = local.copy(breakHoursPerDay = it.toDouble())
                    }
                    Text(
                        stringResource(
                            R.string.set_break_note,
                            "%.1f".format((local.workdayHours - local.breakHoursPerDay).coerceAtLeast(1.0))
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "gatehrs", label = stringResource(R.string.set_hours_per_gate), initialValue = local.hoursPerGate.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(hoursPerGate = it.toDouble())
                        }
                        DraftNumberField(stableKey = "cornerhrs", label = stringResource(R.string.set_hours_per_corner), initialValue = local.hoursPerCorner.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(hoursPerCorner = it.toDouble())
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "treehrs", label = stringResource(R.string.set_hours_per_tree), initialValue = local.hoursPerTree.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(hoursPerTree = it.toDouble())
                        }
                        DraftNumberField(stableKey = "obshrs", label = stringResource(R.string.set_hours_per_obstacle), initialValue = local.hoursPerObstacle.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(hoursPerObstacle = it.toDouble())
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        DraftNumberField(stableKey = "setuphrs", label = stringResource(R.string.set_setup_hours), initialValue = local.setupHours.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(setupHours = it.toDouble())
                        }
                        DraftNumberField(stableKey = "teardownhrs", label = stringResource(R.string.set_teardown_hrs_per_ft), initialValue = local.teardownHoursPerFoot.toFloat(), modifier = Modifier.weight(1f)) {
                            local = local.copy(teardownHoursPerFoot = it.toDouble())
                        }
                    }
                    Text(
                        stringResource(R.string.set_trees_note),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item {
                SectionCard(stringResource(R.string.set_ordering), icon = Icons.Filled.LocalShipping) {
                    Text(stringResource(R.string.set_ordering_explain), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val selectedManufacturer = manufacturers.firstOrNull { it.id == local.preferredManufacturerId }
                    ExposedDropdownMenuBox(expanded = manufacturerMenuExpanded, onExpandedChange = { manufacturerMenuExpanded = it }) {
                        OutlinedTextField(
                            value = selectedManufacturer?.name ?: stringResource(R.string.set_none_selected), onValueChange = {}, readOnly = true,
                            label = { Text(stringResource(R.string.set_preferred_manufacturer)) },
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
                        Text(stringResource(R.string.set_manage_manufacturers))
                    }
                    DraftTextField(
                        stableKey = "order_tmpl", initialValue = local.orderEmailTemplate,
                        label = stringResource(R.string.set_order_template), minLines = 5, modifier = Modifier.fillMaxWidth()
                    ) { local = local.copy(orderEmailTemplate = it) }
                    Text(
                        stringResource(R.string.set_order_placeholders),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    DraftTextField(
                        stableKey = "hoa_tmpl", initialValue = local.hoaEmailTemplate,
                        label = stringResource(R.string.set_hoa_template), minLines = 5, modifier = Modifier.fillMaxWidth()
                    ) { local = local.copy(hoaEmailTemplate = it) }
                    Text(
                        stringResource(R.string.set_hoa_placeholders),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item { GroupHeading(stringResource(R.string.set_group_app)) }
            item {
                SectionCard(stringResource(R.string.settings_appearance), icon = Icons.Filled.Palette) {
                    val themeLabels = mapOf(
                        ThemeMode.SYSTEM to stringResource(R.string.set_theme_system),
                        ThemeMode.LIGHT to stringResource(R.string.set_theme_light),
                        ThemeMode.DARK to stringResource(R.string.set_theme_dark)
                    )
                    SettingsEnumDropdown(
                        stringResource(R.string.settings_theme), listOf(ThemeMode.SYSTEM, ThemeMode.LIGHT, ThemeMode.DARK), local.themeMode,
                        { themeLabels[it] ?: it.name.lowercase().replaceFirstChar { c -> c.uppercase() } }
                    ) { local = local.copy(themeMode = it) }
                    SettingsEnumDropdown(
                        stringResource(R.string.settings_language), AppLanguage.values().toList(), local.language,
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
                        stringResource(R.string.set_language_note),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item {
                // Which figures the home screen shows.
                //
                // A dashboard showing everything shows nothing -- the number
                // somebody checks every morning differs by business, and a fixed
                // set means most of it becomes scenery they look past.
                SectionCard(stringResource(R.string.set_home_screen), icon = Icons.Filled.Dashboard) {
                    Text(
                        stringResource(R.string.set_home_explain),
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
                                Text(card.label(), style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    card.explains(),
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
                SectionCard(stringResource(R.string.set_security), icon = Icons.Filled.Lock) {
                    Text(
                        stringResource(R.string.set_security_explain),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    val autoLockNever = stringResource(R.string.set_auto_lock_never)
                    val autoLockOneMinute = stringResource(R.string.set_auto_lock_one_minute)
                    SettingsEnumDropdown(
                        stringResource(R.string.set_auto_lock_after),
                        listOf(0, 1, 5, 15, 30, 60),
                        local.autoLockMinutes,
                        {
                            when (it) {
                                0 -> autoLockNever
                                1 -> autoLockOneMinute
                                else -> context.getString(R.string.set_auto_lock_minutes, it)
                            }
                        }
                    ) { local = local.copy(autoLockMinutes = it) }

                    val biometricReady = remember { com.fenceestimator.app.ui.lock.biometricAvailable(context) }
                    if (biometricReady) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.set_biometric_unlock), modifier = Modifier.weight(1f))
                            androidx.compose.material3.Switch(
                                checked = local.biometricUnlockEnabled,
                                onCheckedChange = { local = local.copy(biometricUnlockEnabled = it) }
                            )
                        }
                        Text(
                            stringResource(R.string.set_biometric_fallback),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    } else {
                        Text(
                            stringResource(R.string.set_biometric_unavailable),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
            item {
                SectionCard(stringResource(R.string.set_review_requests), icon = Icons.Filled.Star) {
                    DraftTextField(
                        stableKey = "review_tmpl", initialValue = local.reviewRequestTemplate,
                        label = stringResource(R.string.set_review_template), minLines = 3, modifier = Modifier.fillMaxWidth()
                    ) { local = local.copy(reviewRequestTemplate = it) }
                    Text(
                        stringResource(R.string.set_review_placeholders),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            item { GroupHeading(stringResource(R.string.set_group_data)) }
            item {
                SectionCard(stringResource(R.string.set_export_title), icon = Icons.Filled.FileDownload) {
                    Text(
                        stringResource(R.string.set_export_explain),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        stringResource(R.string.set_records_yours),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Button(
                        onClick = {
                            val name = "fenceflow_export_${SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())}.zip"
                            fullExportLauncher.launch(name)
                        },
                        enabled = !exporting,
                        modifier = Modifier.fillMaxWidth()
                    ) { Text(stringResource(if (exporting) R.string.set_exporting else R.string.set_export_everything)) }

                    HorizontalDivider(modifier = Modifier.padding(vertical = 4.dp))

                    Text(
                        stringResource(R.string.set_expenses_csv_explain),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedButton(
                        onClick = {
                            val name = "fence_flow_expenses_${SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())}.csv"
                            csvLauncher.launch(name)
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text(stringResource(R.string.set_export_expenses_csv)) }
                }
            }
            item {
                SectionCard(stringResource(R.string.settings_backup), icon = Icons.Filled.Backup) {
                    Text(
                        stringResource(R.string.set_backup_explain),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Button(
                        onClick = {
                            val name = "fence_estimator_backup_${SimpleDateFormat("yyyy-MM-dd_HHmm", Locale.US).format(Date())}.db"
                            backupLauncher.launch(name)
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) { Text(stringResource(R.string.settings_backup_now)) }
                    OutlinedButton(onClick = { restoreLauncher.launch(arrayOf("*/*")) }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.settings_restore))
                    }
                }
            }
            item { GroupHeading(stringResource(R.string.set_group_help)) }
            item {
                SectionCard(stringResource(R.string.settings_help_feedback), icon = Icons.Filled.HelpOutline) {
                    OutlinedButton(onClick = onOpenHelp, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.set_how_to_use))
                    }
                    OutlinedButton(onClick = onOpenFeedback, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.set_send_suggestion))
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
                    Text(stringResource(R.string.settings_save))
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
                    stringResource(
                        R.string.set_version_line,
                        com.fenceestimator.app.BuildConfig.VERSION_NAME,
                        com.fenceestimator.app.BuildConfig.VERSION_CODE
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 4.dp),
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center
                )

                // Asking for an update by hand, because the automatic ask has
                // exactly one chance to work.
                //
                // It runs when the app's process starts -- and swiping an app
                // out of the recents list usually does not end its process, so
                // "close it and open it again" quietly does nothing and the
                // prompt never comes. Somebody who has been told there is a
                // fix waiting needs a way to go and get it that does not
                // depend on guessing how Android feels about their process.
                // Only where the app actually updates itself. In a Play build
                // the Store owns updates, and a button that always answers
                // "you are up to date" is worse than no button.
                if (com.fenceestimator.app.BuildConfig.SELF_UPDATE) {
                    UpdateCheckRow(
                        modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp)
                    )
                }
            }
        }
    }

    showRestoreWarning?.let { uri ->
        AlertDialog(
            onDismissRequest = { showRestoreWarning = null },
            title = { Text(stringResource(R.string.set_restore_title)) },
            text = { Text(stringResource(R.string.set_restore_text)) },
            confirmButton = {
                Button(onClick = {
                    showRestoreWarning = null
                    coroutineScope.launch {
                        val result = BackupManager.restore(context, uri)
                        if (result.isSuccess) showRestoreComplete = true
                        else snackbarHostState.showSnackbar(context.getString(R.string.set_restore_failed, result.exceptionOrNull()?.message))
                    }
                }) { Text(stringResource(R.string.set_restore_button)) }
            },
            dismissButton = { OutlinedButton(onClick = { showRestoreWarning = null }) { Text(stringResource(R.string.action_cancel)) } }
        )
    }

    if (showRestoreComplete) {
        AlertDialog(
            onDismissRequest = { },
            title = { Text(stringResource(R.string.set_restore_complete_title)) },
            text = { Text(stringResource(R.string.set_restore_complete_text)) },
            confirmButton = { Button(onClick = { showRestoreComplete = false }) { Text(stringResource(R.string.set_ok)) } }
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
    icon: androidx.compose.ui.graphics.vector.ImageVector? = null,
    content: @Composable () -> Unit
) {
    var expanded by rememberSaveable(title) { mutableStateOf(startExpanded) }
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = androidx.compose.foundation.shape.RoundedCornerShape(14.dp),
        colors = androidx.compose.material3.CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        ),
        elevation = androidx.compose.material3.CardDefaults.cardElevation(
            defaultElevation = if (expanded) 3.dp else 1.dp
        )
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                Modifier.fillMaxWidth().clickable { expanded = !expanded },
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (icon != null) {
                    // A tinted square rather than a bare glyph: at a glance the
                    // eye finds the row it wants by shape and colour instead of
                    // reading fourteen near-identical headings.
                    Box(
                        Modifier
                            .padding(end = 12.dp)
                            .size(36.dp)
                            .background(
                                MaterialTheme.colorScheme.secondaryContainer,
                                androidx.compose.foundation.shape.RoundedCornerShape(10.dp)
                            ),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(
                            icon,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSecondaryContainer,
                            modifier = Modifier.size(20.dp)
                        )
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(
                        title,
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold
                    )
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
                    contentDescription = if (expanded) stringResource(R.string.set_collapse_section, title) else stringResource(R.string.set_expand_section, title),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (expanded) {
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                content()
            }
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
        title = { Text(stringResource(if (tier.id == 0L) R.string.set_new_tier else R.string.set_edit_tier)) },
        text = {
            Column {
                OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text(stringResource(R.string.set_tier_name)) }, modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = laborRate, onValueChange = { laborRate = it }, label = { Text(stringResource(R.string.set_tier_labor_per_ft)) }, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = laborFlat, onValueChange = { laborFlat = it }, label = { Text(stringResource(R.string.set_tier_labor_flat)) }, modifier = Modifier.weight(1f))
                }
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = markup, onValueChange = { markup = it }, label = { Text(stringResource(R.string.set_tier_markup)) }, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = discount, onValueChange = { discount = it }, label = { Text(stringResource(R.string.set_tier_discount)) }, modifier = Modifier.weight(1f))
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                onSave(
                    tier.copy(
                        name = name,
                        laborRatePerFt = laborRate.replace(',', '.').toDoubleOrNull() ?: 0.0,
                        laborFlatFee = laborFlat.replace(',', '.').toDoubleOrNull() ?: 0.0,
                        markupPercent = markup.replace(',', '.').toDoubleOrNull() ?: 0.0,
                        discountPercent = discount.replace(',', '.').toDoubleOrNull() ?: 0.0
                    )
                )
            }) { Text(stringResource(R.string.action_save)) }
        },
        dismissButton = {
            Row {
                if (tier.id != 0L) {
                    OutlinedButton(onClick = onDelete) { Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.action_delete)) }
                    Spacer(Modifier.width(8.dp))
                }
                OutlinedButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
            }
        }
    )
}

/**
 * "Check for updates", and the whole update in one place if there is one.
 *
 * The automatic check happens once, when the app's process starts. Swiping an
 * app off the recents list usually leaves the process running, so being told
 * to "close it and open it again" can do nothing at all, several times in a
 * row, while a fix sits on the server. This asks on demand and says plainly
 * what came back -- including when the answer is that you are already current,
 * which is worth hearing rather than being left to wonder.
 */
@Composable
private fun UpdateCheckRow(modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var checking by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    var found by remember {
        mutableStateOf<com.fenceestimator.app.cloud.AppRelease?>(null)
    }
    var progress by remember {
        mutableStateOf<com.fenceestimator.app.cloud.ApkUpdater.Progress?>(null)
    }

    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        OutlinedButton(
            enabled = !checking,
            onClick = {
                scope.launch {
                    checking = true
                    note = null
                    val result = runCatching {
                        com.fenceestimator.app.cloud.UpdateChecker.checkNow()
                    }.getOrElse { com.fenceestimator.app.cloud.UpdateChecker.CheckResult.CouldNotCheck }
                    checking = false
                    when (result) {
                        is com.fenceestimator.app.cloud.UpdateChecker.CheckResult.Available ->
                            found = result.release
                        com.fenceestimator.app.cloud.UpdateChecker.CheckResult.UpToDate ->
                            note = context.getString(R.string.set_update_current)
                        // Never "you are up to date" -- it did not find out.
                        com.fenceestimator.app.cloud.UpdateChecker.CheckResult.CouldNotCheck ->
                            note = context.getString(R.string.set_update_unreachable)
                    }
                }
            }
        ) {
            Text(
                stringResource(
                    if (checking) R.string.set_update_checking else R.string.set_update_check
                )
            )
        }
        note?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 6.dp)
            )
        }
    }

    found?.let { release ->
        com.fenceestimator.app.ui.onboarding.UpdateAvailableDialog(
            release = release,
            progress = progress,
            onDownload = {
                scope.launch {
                    progress = com.fenceestimator.app.cloud.ApkUpdater.Progress.Downloading(0)
                    val apk = com.fenceestimator.app.cloud.ApkUpdater.download(
                        context, release.downloadUrl
                    ) { p -> progress = p }
                    if (apk != null) {
                        progress = com.fenceestimator.app.cloud.ApkUpdater.Progress.Installing
                        com.fenceestimator.app.cloud.ApkUpdater.install(context, apk)
                    }
                }
            },
            onOpenInBrowser = {
                val opened = runCatching {
                    context.startActivity(
                        android.content.Intent(
                            android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse(release.downloadUrl)
                        )
                    )
                }
                // A device with no browser at all used to fail here with
                // nothing on screen -- the dialog just closed and the tap
                // appeared to have done nothing.
                if (opened.isFailure) {
                    android.widget.Toast.makeText(
                        context, context.getString(R.string.set_no_browser), android.widget.Toast.LENGTH_SHORT
                    ).show()
                }
                found = null
            },
            onLater = { found = null }
        )
    }
}

/**
 * The name of a group of settings.
 *
 * Fourteen cards in a row all look alike, and a screen you have to read top to
 * bottom to find one thing is a screen people stop opening. These break the
 * list into the handful of reasons somebody actually comes here: their
 * business, how work gets priced, how the app behaves, their data, and help.
 */
@Composable
private fun GroupHeading(text: String) {
    Text(
        text.uppercase(Locale.getDefault()),
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.8.sp,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 4.dp, top = 10.dp, bottom = 2.dp)
    )
}

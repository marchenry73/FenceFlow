package com.fenceestimator.app.ui.admin

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.cloud.AdminRepository
import com.fenceestimator.app.cloud.shownError
import com.fenceestimator.app.ui.components.EmptyState
import com.fenceestimator.app.ui.theme.Space
import kotlinx.coroutines.launch
import androidx.compose.runtime.rememberCoroutineScope

/**
 * THE PLATFORM CONSOLE, ON THE PHONE.
 *
 * The same powers as website/admin.html: every fence company, their standing
 * and billing, creating and inviting one, the releases, and what has been
 * failing. See [AdminRepository] for the complete list -- if a call is not
 * there, this screen cannot do it.
 *
 * THE SECOND FACTOR IS NOT OPTIONAL AND NOT DECORATIVE. Since
 * supabase_r7_admin_second_factor.sql the database itself refuses every admin
 * power to a session that has not done the authenticator, so what this screen
 * does with [AdminEntry] only decides whether he is ASKED nicely or discovers
 * it as a wall of empty lists. The code box below is the nicety; the gate is
 * in Postgres.
 *
 * EMPTY IS NOT THE SAME AS REFUSED. Every section reports a failed read as a
 * failure, never as "none". An admin console that shows no companies because
 * the call was refused, in the same grey text it uses for "no companies", is
 * the exact bug this project has met four times over.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AdminScreen(onBack: () -> Unit) {
    val scope = rememberCoroutineScope()

    var entry by remember { mutableStateOf<AdminEntry?>(null) }
    var code by remember { mutableStateOf("") }
    var stepUpError by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var tab by remember { mutableStateOf(0) }

    /** Re-reads who this is and how far the session has got. */
    suspend fun refreshEntry() {
        val admin = AdminRepository.isPlatformAdmin()
        val aal = AdminRepository.assuranceLevel()
        // A failed admin lookup must not read as "not an admin": that would
        // hide the console from the real admin over a network blip. Hold the
        // previous answer and let the sections report their own failures.
        val isAdmin = admin.getOrNull() ?: (entry != null && entry != AdminEntry.HIDDEN)
        entry = adminEntryFor(
            signedIn = true,
            isPlatformAdmin = isAdmin,
            aalCurrent = aal.getOrNull()?.first,
            aalNext = aal.getOrNull()?.second,
        )
    }

    LaunchedEffect(Unit) { refreshEntry() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Admin") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(Space.md)) {
            when (entry) {
                null -> Row(
                    Modifier.fillMaxWidth().padding(Space.lg),
                    horizontalArrangement = Arrangement.Center
                ) { CircularProgressIndicator() }

                AdminEntry.HIDDEN -> EmptyState(
                    "This account is not a FenceFlow platform admin."
                )

                AdminEntry.NEEDS_ENROLMENT -> EmptyState(
                    "No authenticator is enrolled on this account. Enrol one on the admin website " +
                        "first -- enrolling from a phone that is already signed in would weaken the " +
                        "second factor to whoever is holding the phone."
                )

                AdminEntry.NEEDS_CODE -> {
                    Text(
                        "Enter the code from your authenticator",
                        fontWeight = FontWeight.Bold,
                        style = MaterialTheme.typography.titleMedium
                    )
                    Text(
                        "The same one you use on the admin website. Admin powers are refused by the " +
                            "server until this session has done it.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = Space.xs, bottom = Space.md)
                    )
                    OutlinedTextField(
                        value = code,
                        onValueChange = { code = it.filter(Char::isDigit).take(6); stepUpError = null },
                        label = { Text("6-digit code") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                        modifier = Modifier.fillMaxWidth()
                    )
                    stepUpError?.let {
                        Text(
                            it,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(top = Space.xs)
                        )
                    }
                    OutlinedButton(
                        enabled = code.length == 6 && !busy,
                        onClick = {
                            scope.launch {
                                busy = true
                                stepUpError = null
                                AdminRepository.verifyTotp(code)
                                    .onSuccess { code = ""; refreshEntry() }
                                    // The reason, not just "failed": a wrong
                                    // code and an expired session need
                                    // different things from him.
                                    .onFailure { stepUpError = shownError(it, "That code was not accepted.") }
                                busy = false
                            }
                        },
                        modifier = Modifier.padding(top = Space.md)
                    ) { Text(if (busy) "Checking..." else "Unlock admin") }
                }

                AdminEntry.OPEN -> {
                    val tabs = listOf("Overview", "Companies", "Releases", "Errors", "Drift", "Sign-ins")
                    TabRow(selectedTabIndex = tab) {
                        tabs.forEachIndexed { i, title ->
                            Tab(selected = tab == i, onClick = { tab = i }, text = { Text(title) })
                        }
                    }
                    when (tab) {
                        0 -> OverviewTab()
                        1 -> CompaniesTab()
                        2 -> ReleasesTab()
                        3 -> ErrorsTab()
                        4 -> DriftTab()
                        else -> SignInsTab()
                    }
                }
            }
        }
    }
}

/**
 * One section's state: loading, a failure with its reason, or rows.
 *
 * A sealed shape rather than a nullable list, so "refused" cannot be rendered
 * by the same branch as "there are none".
 */
private sealed interface Load<out T> {
    data object Loading : Load<Nothing>
    data class Failed(val why: String) : Load<Nothing>
    data class Rows<T>(val rows: List<T>) : Load<T>
}

@Composable
private fun <T> Section(
    state: Load<T>,
    emptyText: String,
    row: @Composable (T) -> Unit,
) {
    when (state) {
        is Load.Loading -> Row(
            Modifier.fillMaxWidth().padding(Space.lg),
            horizontalArrangement = Arrangement.Center
        ) { CircularProgressIndicator() }

        is Load.Failed -> EmptyState("Could not load this: ${state.why}")

        is Load.Rows -> if (state.rows.isEmpty()) EmptyState(emptyText)
        else LazyColumn(
            contentPadding = PaddingValues(vertical = Space.sm),
            verticalArrangement = Arrangement.spacedBy(Space.sm)
        ) { items(state.rows) { row(it) } }
    }
}

@Composable
private fun AdminCard(
    title: String,
    lines: List<String>,
    /** Anything the card should carry under its lines -- the company actions. */
    footer: (@androidx.compose.runtime.Composable () -> Unit)? = null,
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(Modifier.padding(Space.md)) {
            Text(title, fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium)
            lines.filter { it.isNotBlank() }.forEach {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            footer?.invoke()
        }
    }
}

/**
 * Is anything on fire, in six numbers.
 *
 * Built from the SAME one call the Companies tab makes, so the two can never
 * disagree about how many companies there are -- and so opening this costs one
 * request rather than seven.
 *
 * Every figure here is a count of rows that came back. If that read is ever
 * truncated the numbers are a floor rather than a total; the web console says
 * so in those words when it happens, and the phone would need the same note
 * before any of these could be treated as exact. With eleven companies it is
 * not a live concern, and it is written down here so it is not forgotten when
 * it becomes one.
 */
@Composable
private fun OverviewTab() {
    var state by remember { mutableStateOf<Load<AdminRepository.Company>>(Load.Loading) }
    LaunchedEffect(Unit) {
        state = AdminRepository.companies()
            .fold({ Load.Rows(it) }, { Load.Failed(shownError(it, "unknown error")) })
    }
    when (val s = state) {
        is Load.Loading -> Text("Loading...", style = MaterialTheme.typography.bodyMedium)
        is Load.Failed -> Text(
            s.why,
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodyMedium
        )
        is Load.Rows -> {
            val all = s.rows
            // "On trial" and "paying" by the console's own tests, not a second
            // reading of them: trialing OR a trial end date still ahead, and
            // paying means Stripe is charging money TODAY -- active, not
            // suspended, not still inside a trial, and with a price on file. A
            // hand-granted open-ended account carries 'active' with no price
            // at all, and counting that as revenue is the flattering-direction
            // mistake the console exists to avoid.
            val onTrial = all.filter {
                !it.suspended && (it.subscriptionStatus == "trialing" || (it.daysLeft ?: 0) > 0)
            }
            val paying = all.filter {
                it.subscriptionStatus == "active" && !it.suspended &&
                    it.subscriptionStatus != "trialing" && (it.daysLeft ?: 0) <= 0 &&
                    (it.monthlyPrice ?: 0.0) > 0.0
            }
            val usingIt = all.count { it.health == AdminRepository.Health.ACTIVE }
            val dormant = all.count { it.health == AdminRepository.Health.DORMANT }
            Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                Tile("${all.size}", "companies")
                Tile("$usingIt", "used it in the last 30 days")
                Tile("$dormant", "dormant -- nobody opened it in 30 days")
                Tile("${onTrial.size}", "on trial")
                Tile("${paying.size}", "paying")
                Tile("${all.count { it.suspended }}", "suspended")
            }
        }
    }
}

@Composable
private fun Tile(figure: String, label: String) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(Space.md)) {
            Text(figure, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun CompaniesTab() {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<Load<AdminRepository.Company>>(Load.Loading) }
    var adding by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    var newEmail by remember { mutableStateOf("") }
    var addError by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    // The company an action is waiting to be confirmed for, and which action.
    // Null means nothing is pending. Held here rather than inside the row so
    // the dialog survives the list reloading underneath it.
    var pending by remember { mutableStateOf<Pair<AdminRepository.Company, AdminAction>?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    /** The company whose plan, price, billing address and notes are open. */
    var managing by remember { mutableStateOf<AdminRepository.Company?>(null) }

    suspend fun load() {
        state = AdminRepository.companies()
            .fold({ Load.Rows(it) }, { Load.Failed(shownError(it, "unknown error")) })
    }
    LaunchedEffect(Unit) { load() }

    if (adding) {
        Column(Modifier.fillMaxWidth().padding(bottom = Space.sm)) {
            OutlinedTextField(
                value = newName,
                onValueChange = { newName = it; addError = null },
                label = { Text("Company name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = newEmail,
                onValueChange = { newEmail = it; addError = null },
                // The console allows a company with no contact address, so
                // this does too rather than inventing a stricter rule than
                // the function enforces.
                label = { Text("Contact email (optional)") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(top = Space.xs)
            )
            addError?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(top = Space.xs)
                )
            }
            Row(
                Modifier.fillMaxWidth().padding(top = Space.sm),
                horizontalArrangement = Arrangement.spacedBy(Space.sm)
            ) {
                OutlinedButton(
                    enabled = newName.isNotBlank() && !busy,
                    onClick = {
                        scope.launch {
                            busy = true
                            addError = null
                            AdminRepository.createCompany(newName.trim(), newEmail.trim())
                                .onSuccess {
                                    newName = ""; newEmail = ""; adding = false; load()
                                }
                                .onFailure { addError = shownError(it, "Could not create it.") }
                            busy = false
                        }
                    },
                    modifier = Modifier.weight(1f)
                ) { Text(if (busy) "Creating..." else "Create") }
                OutlinedButton(
                    enabled = !busy,
                    onClick = { adding = false; addError = null },
                    modifier = Modifier.weight(1f)
                ) { Text("Cancel") }
            }
        }
    } else {
        OutlinedButton(
            onClick = { adding = true },
            modifier = Modifier.fillMaxWidth().padding(bottom = Space.sm)
        ) { Text("Add a company") }
    }

    actionError?.let { why ->
        Text(
            why,
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.fillMaxWidth().padding(bottom = Space.sm)
        )
    }

    MailSenderRow()

    Section(state, "No companies.") { c ->
        AdminCard(
            title = c.name.ifBlank { "(unnamed)" },
            lines = listOf(
                c.email,
                // The server's own verdict, not re-derived here: the office
                // opens for them or it does not, and only one place decides.
                (if (c.allowed) "Allowed" else "Blocked") +
                    (c.subscriptionStatus?.let { " - $it" } ?: "") +
                    (c.daysLeft?.let { " - $it days left" } ?: "") +
                    (if (c.suspended) " - suspended" else ""),
                "${c.people} people, ${c.jobs} jobs",
                // EVER above; the last thirty days here. The counts are
                // printed beside the verdict so the rule can be checked
                // rather than believed -- the same thing the web console
                // does under its pill.
                when (c.health) {
                    AdminRepository.Health.ACTIVE ->
                        "Using it - ${c.activePeople30d} seen, ${c.jobs30d} jobs, ${c.quotes30d} quotes in 30 days"
                    AdminRepository.Health.QUIET ->
                        "Quiet - ${c.activePeople30d} seen in 30 days, nothing built"
                    AdminRepository.Health.DORMANT -> "Dormant - nobody opened it in 30 days"
                    AdminRepository.Health.NOT_STARTED -> "Invited, never signed in"
                },
                c.lastActive?.let { "Last active $it" } ?: "Never active",
                c.adminNotes,
            )
        ) {
            // EVERY ONE OF THESE ASKS FIRST. They change whether somebody
            // else's business can open tomorrow morning, from a phone, with a
            // thumb -- the console asks before each of them and so does this.
            Row(
                horizontalArrangement = Arrangement.spacedBy(Space.sm),
                modifier = Modifier.padding(top = Space.sm)
            ) {
                OutlinedButton(
                    enabled = !busy,
                    onClick = { actionError = null; managing = c },
                ) { Text("Manage") }
                OutlinedButton(
                    enabled = !busy,
                    onClick = { actionError = null; pending = c to AdminAction.ExtendOneDay },
                ) { Text("+1 day") }
                OutlinedButton(
                    enabled = !busy,
                    onClick = { actionError = null; pending = c to AdminAction.ExtendTwoWeeks },
                ) { Text("+14 days") }
                if (c.suspended) {
                    OutlinedButton(
                        enabled = !busy,
                        onClick = { actionError = null; pending = c to AdminAction.Reinstate },
                    ) { Text("Reinstate") }
                } else {
                    OutlinedButton(
                        enabled = !busy,
                        onClick = { actionError = null; pending = c to AdminAction.Suspend },
                    ) { Text("Suspend") }
                }
            }
        }
    }

    managing?.let { c ->
        var plan by remember(c.id) { mutableStateOf(c.subscriptionPlan ?: "") }
        var price by remember(c.id) { mutableStateOf(c.monthlyPrice?.let { "%.2f".format(it) } ?: "") }
        var billing by remember(c.id) { mutableStateOf("") }
        var notes by remember(c.id) { mutableStateOf(c.adminNotes) }
        var saving by remember(c.id) { mutableStateOf(false) }
        // HISTORY, read on demand. Keyed on c.id so opening a second company
        // never shows the first one's rows while its own are in flight.
        var showHistory by remember(c.id) { mutableStateOf(false) }
        var history by remember(c.id) { mutableStateOf<List<AdminRepository.AuditEntry>>(emptyList()) }
        var historyBusy by remember(c.id) { mutableStateOf(false) }
        var historyMore by remember(c.id) { mutableStateOf(false) }
        var historyError by remember(c.id) { mutableStateOf<String?>(null) }
        val loadHistory: () -> Unit = {
            if (!historyBusy) {
                historyBusy = true
                historyError = null
                scope.launch {
                    AdminRepository.companyHistory(c.id, offset = history.size.toLong())
                        .onSuccess { page ->
                            history = history + page
                            // A full page means there is probably another; a
                            // short one is the end. The same test every paged
                            // read in this project makes.
                            historyMore = page.size.toLong() == AdminRepository.HISTORY_PAGE
                        }
                        .onFailure { historyError = shownError(it, "Could not read the history.") }
                    historyBusy = false
                }
            }
        }
        AlertDialog(
            onDismissRequest = { if (!saving) managing = null },
            title = { Text(c.name.ifBlank { "(unnamed)" }) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                        for (p in listOf("solo", "crew", "pro")) {
                            OutlinedButton(
                                enabled = !saving && plan != p,
                                onClick = { plan = p }
                            ) { Text(if (plan == p) p.uppercase() else p) }
                        }
                    }
                    OutlinedTextField(
                        value = price, onValueChange = { price = it },
                        label = { Text("Monthly price") }, singleLine = true, enabled = !saving,
                        modifier = Modifier.fillMaxWidth()
                    )
                    // Said where the box is, not in a comment nobody reads:
                    // Stripe decides what they are charged and overwrites this
                    // on its next event.
                    Text(
                        "Stripe sets what they actually pay. This is a note, and the next " +
                            "subscription event overwrites it. To take money off a bill, use a special.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedTextField(
                        value = billing, onValueChange = { billing = it },
                        // Blank leaves it: the column is NOT NULL, so an empty
                        // string saves perfectly while wiping where invoices go.
                        label = { Text("Billing email (blank leaves it: " + (c.billingEmail ?: "none") + ")") },
                        singleLine = true, enabled = !saving, modifier = Modifier.fillMaxWidth()
                    )
                    OutlinedTextField(
                        value = notes, onValueChange = { notes = it },
                        label = { Text("Notes") }, enabled = !saving, minLines = 2,
                        modifier = Modifier.fillMaxWidth()
                    )

                    // ---- THIS COMPANY'S HISTORY --------------------------
                    //
                    // "I also want to be able to click on the company on the
                    // app and the website and to see all the details about
                    // the company along with its histories."
                    //
                    // Shut until asked for: this dialog is opened to change
                    // something far more often than to read what happened,
                    // and the rows are a table read.
                    TextButton(onClick = {
                        showHistory = !showHistory
                        if (showHistory && history.isEmpty() && historyError == null) loadHistory()
                    }) {
                        Text(if (showHistory) "Hide history" else "History and details")
                    }
                    if (showHistory) {
                        // WHAT THE LIST ALREADY KNOWS. No extra read: these come
                        // off the Company row admin_companies returned.
                        val dates = buildList {
                            c.joinedAt?.let { add("Joined " + it.take(10)) }
                            c.trialEndsAt?.let { add("Trial ends " + it.take(10)) }
                            c.lastActive?.let { add("Last active " + it.take(10)) }
                            c.daysLeft?.let { add("$it days left") }
                            add("${c.people} people, ${c.jobs} jobs")
                            add("Last 30 days: ${c.activePeople30d} active, ${c.jobs30d} jobs, ${c.quotes30d} quotes")
                            if (c.billingEmail?.isNotBlank() == true) add("Billing " + c.billingEmail)
                        }
                        for (line in dates) {
                            Text(
                                line,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }

                        historyError?.let { problem ->
                            Text(
                                problem,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error
                            )
                        }
                        if (history.isEmpty() && !historyBusy && historyError == null) {
                            Text(
                                "Nothing has been written down against this company yet.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        for (h in history) {
                            Column(Modifier.padding(top = Space.xs)) {
                                Text(
                                    (h.at?.let { it.take(10) } ?: "") + "  " +
                                        h.action.lowercase() + " " + h.tableName,
                                    style = MaterialTheme.typography.bodySmall
                                )
                                Text(
                                    // The field and what it became. Both are
                                    // stored text, shown as they are.
                                    (h.field ?: "") +
                                        (if (h.field != null) ": " else "") +
                                        (h.oldValue ?: "-") + " -> " + (h.newValue ?: "-") +
                                        (h.actorEmail.takeIf { it.isNotBlank() }?.let { "  (" + it + ")" } ?: ""),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                        if (historyBusy) {
                            Text(
                                "Reading...",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        } else if (historyMore) {
                            TextButton(onClick = loadHistory) { Text("Show more") }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(
                    enabled = !saving,
                    onClick = {
                        saving = true
                        scope.launch {
                            AdminRepository.updateCompany(
                                companyId = c.id,
                                plan = plan.takeIf { it.isNotBlank() && it != c.subscriptionPlan },
                                // A BLANK PRICE IS NOT A PRICE OF ZERO. num("")
                                // is 0, and a blank box writing a real zero over
                                // a real figure is the bug the office's own save
                                // was fixed for.
                                monthlyPrice = price.trim().takeIf { it.isNotEmpty() }?.toDoubleOrNull(),
                                billingEmail = billing.trim().takeIf { it.isNotEmpty() },
                                // Notes go as typed, blank included: the box is
                                // pre-filled with what is stored, so deleting
                                // the text is the only way to clear a note and
                                // there is no ambiguity about what blank means.
                                adminNotes = notes,
                            ).onFailure { actionError = shownError(it, "That did not go through.") }
                            saving = false
                            managing = null
                            load()
                        }
                    }
                ) { Text(if (saving) "Saving..." else "Save") }
            },
            dismissButton = {
                TextButton(enabled = !saving, onClick = { managing = null }) { Text("Cancel") }
            }
        )
    }

    pending?.let { p: Pair<AdminRepository.Company, AdminAction> ->
        val company = p.first
        val action = p.second
        AlertDialog(
            onDismissRequest = { if (!busy) pending = null },
            title = { Text(action.title(company)) },
            text = { Text(action.body(company)) },
            confirmButton = {
                TextButton(
                    enabled = !busy,
                    onClick = {
                        busy = true
                        scope.launch {
                            val result = when (action) {
                                AdminAction.ExtendOneDay ->
                                    AdminRepository.extendTrial(company.id, 1)
                                AdminAction.ExtendTwoWeeks ->
                                    AdminRepository.extendTrial(company.id, 14)
                                AdminAction.Suspend ->
                                    // hold = false: a plain suspension is a
                                    // billing matter and the office keeps
                                    // offering them a plan. A HOLD says paying
                                    // will not help, and that is a decision
                                    // worth making at a keyboard with the
                                    // reason typed out, not on a phone.
                                    AdminRepository.suspendCompany(company.id, null, hold = false)
                                AdminAction.Reinstate ->
                                    AdminRepository.unsuspendCompany(company.id)
                            }
                            // The server decides; the list is re-read rather
                            // than patched in place, so what is on screen is
                            // what admin_companies actually says afterwards.
                            result.onFailure { actionError = shownError(it, "That did not go through.") }
                            load()
                            busy = false
                            pending = null
                        }
                    }
                ) { Text(action.confirmLabel) }
            },
            dismissButton = {
                TextButton(enabled = !busy, onClick = { pending = null }) { Text("Cancel") }
            },
        )
    }
}

/**
 * Which service carries FenceFlow mail, and the switch for it.
 *
 * Here rather than in Settings because it is a PLATFORM decision: one row,
 * every company at once. A company that has connected its own mailbox is
 * unaffected -- this only decides what "FenceFlow mail" means for everyone
 * who has not.
 *
 * It asks before it flips, and names the consequence rather than the setting:
 * what somebody needs to know is that the next quote goes out through a
 * different service, not that a column changed.
 */
@Composable
private fun MailSenderRow() {
    val scope = rememberCoroutineScope()
    var current by remember { mutableStateOf<String?>(null) }
    var asking by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        AdminRepository.mailSender()
            .onSuccess { current = it }
            .onFailure { error = shownError(it, "Could not read the mail sender.") }
    }
    LaunchedEffect(Unit) { load() }

    Card(
        modifier = Modifier.fillMaxWidth().padding(bottom = Space.sm),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(Modifier.padding(Space.md)) {
            Text("FenceFlow mail goes through", fontWeight = FontWeight.Medium,
                style = MaterialTheme.typography.bodyMedium)
            Text(
                "Every company that has not connected its own mailbox. " +
                    "A company's own inbox is unaffected.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            error?.let {
                Text(it, color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall)
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(Space.sm),
                modifier = Modifier.padding(top = Space.sm)
            ) {
                for (p in listOf("resend", "brevo")) {
                    val selected = current == p
                    OutlinedButton(
                        enabled = !busy && current != null && !selected,
                        onClick = { error = null; asking = p },
                    ) {
                        Text(if (selected) "${p.replaceFirstChar { it.uppercase() }} (in use)"
                             else p.replaceFirstChar { it.uppercase() })
                    }
                }
            }
        }
    }

    asking?.let { want ->
        AlertDialog(
            onDismissRequest = { if (!busy) asking = null },
            title = { Text("Send through ${want.replaceFirstChar { it.uppercase() }}?") },
            text = {
                Text(
                    if (want == "brevo")
                        "Every company's next quote, follow-up and reply goes out through Brevo. " +
                            "It needs BREVO_API_KEY set on the server and the sending address " +
                            "verified in Brevo -- without those, sending stops with " +
                            "\"not set up on the server\" until you switch back."
                    else
                        "Every company's mail goes back through Resend, which is what it used before."
                )
            },
            confirmButton = {
                TextButton(
                    enabled = !busy,
                    onClick = {
                        busy = true
                        scope.launch {
                            AdminRepository.setMailSender(want)
                                .onFailure { error = shownError(it, "That did not go through.") }
                            // Re-read rather than assume: the server decides,
                            // and a refusal must not leave the screen showing
                            // a switch that never happened.
                            load()
                            busy = false
                            asking = null
                        }
                    }
                ) { Text("Switch") }
            },
            dismissButton = {
                TextButton(enabled = !busy, onClick = { asking = null }) { Text("Cancel") }
            },
        )
    }
}

/** What the company buttons can do, with the words each one asks in. */
private enum class AdminAction(val confirmLabel: String) {
    ExtendOneDay("Give 1 day"),
    ExtendTwoWeeks("Give 14 days"),
    Suspend("Suspend"),
    Reinstate("Reinstate");

    fun title(c: AdminRepository.Company): String {
        val name = c.name.ifBlank { "this company" }
        return when (this) {
            ExtendOneDay, ExtendTwoWeeks -> "Extend $name's trial?"
            Suspend -> "Suspend $name?"
            Reinstate -> "Reinstate $name?"
        }
    }

    fun body(c: AdminRepository.Company): String = when (this) {
        // Said as "from today", because that is what the server does with a
        // trial that has already ended -- it restarts from now rather than
        // adding to a date in the past.
        ExtendOneDay ->
            "Their office opens again for one more day, counted from today. " +
                "A suspension would be lifted too."
        ExtendTwoWeeks ->
            "Their office opens again for another 14 days, counted from today. " +
                "A suspension would be lifted too."
        Suspend ->
            "Everyone at ${c.name.ifBlank { "this company" }} is locked out of the office and the " +
                "app until this is lifted. Nothing is deleted. They are still offered a plan, " +
                "so paying would let them back in."
        Reinstate ->
            "The suspension is lifted. Their plan and billing are left exactly as they are, " +
                "so if the trial has also run out they will still need more time or a plan."
    }
}

@Composable
private fun ReleasesTab() {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<Load<AdminRepository.Release>>(Load.Loading) }
    var busy by remember { mutableStateOf(false) }
    var asking by remember { mutableStateOf<AdminRepository.Release?>(null) }
    var why by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        state = AdminRepository.releases()
            .fold({ Load.Rows(it) }, { Load.Failed(shownError(it, "unknown error")) })
    }
    LaunchedEffect(Unit) { load() }
    why?.let {
        Text(
            it,
            color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.fillMaxWidth().padding(bottom = Space.sm)
        )
    }
    Section(state, "No releases.") { r ->
        AdminCard(
            title = "${r.versionName} (${r.versionCode})",
            lines = listOf(
                r.notes,
                r.audience + (if (r.isMandatory) " - mandatory" else ""),
                if (r.downloadUrl.isNullOrBlank()) "NO DOWNLOAD URL" else "",
            )
        ) {
            // Only for a release that is NOT already everyone's. A limited
            // rollout that is never promoted is a stuck rollout: the audience
            // named keeps getting it and nobody else moves at all. This is the
            // control that unsticks it, and the moment you want it is rarely
            // one where you are sitting at a desk.
            if (!r.audience.equals("everyone", ignoreCase = true) && r.id.isNotBlank()) {
                OutlinedButton(
                    enabled = !busy,
                    onClick = { why = null; asking = r },
                    modifier = Modifier.padding(top = Space.sm)
                ) { Text("Give it to everyone") }
            }
        }
    }

    asking?.let { rel ->
        AlertDialog(
            onDismissRequest = { if (!busy) asking = null },
            title = { Text("Give ${rel.versionName} to every company?") },
            text = {
                Text(
                    "Every phone on every company will be offered this build the next time the app " +
                        "is opened" + (if (rel.isMandatory) ", with no way to put it off." else ".") +
                        " It cannot be taken back from a phone that has already installed it."
                )
            },
            confirmButton = {
                TextButton(
                    enabled = !busy,
                    onClick = {
                        busy = true
                        scope.launch {
                            AdminRepository.promoteRelease(rel.id)
                                .onFailure { why = shownError(it, "That did not go through.") }
                            busy = false
                            asking = null
                            load()
                        }
                    }
                ) { Text(if (busy) "Working..." else "Give it to everyone") }
            },
            dismissButton = {
                TextButton(enabled = !busy, onClick = { asking = null }) { Text("Cancel") }
            }
        )
    }
}

@Composable
private fun ErrorsTab() {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<Load<AdminRepository.ErrorGroup>>(Load.Loading) }
    var currentOnly by remember { mutableStateOf(false) }
    // What "the current build" means: the newest release on record, not this
    // handset's own version. An admin looking at crashes is asking about the
    // fleet, and the phone in his hand may not be on the newest build itself.
    var newestVersion by remember { mutableStateOf<String?>(null) }
    suspend fun load() {
        state = AdminRepository.errorSummary()
            .fold({ Load.Rows(it) }, { Load.Failed(shownError(it, "unknown error")) })
        newestVersion = AdminRepository.releases().getOrNull()
            ?.maxByOrNull { it.versionCode }?.versionName
    }
    LaunchedEffect(Unit) { load() }

    Row(
        Modifier.fillMaxWidth().padding(bottom = Space.sm),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Checkbox(checked = currentOnly, onCheckedChange = { currentOnly = it })
        Text(
            newestVersion?.let { "Only still happening on $it" } ?: "Only on the current build",
            style = MaterialTheme.typography.bodyMedium
        )
    }

    val shown = when (val st = state) {
        is Load.Rows -> Load.Rows(
            st.rows.filter { e ->
                // AN OFFICE ERROR IS NEVER HIDDEN BY THIS FILTER. It carries
                // the word "office" where a version belongs, so a build
                // comparison can never be satisfied by it -- and with the box
                // ticked, which is how somebody hunting a live problem reads
                // this screen, every office failure disappeared. The web
                // console had exactly this bug until it was fixed this
                // morning; the rule is written here rather than rediscovered.
                !currentOnly || e.isOffice || newestVersion == null || e.latestVersion == newestVersion
            }
        )
        else -> state
    }

    Section(shown, "Nothing has failed in the last 14 days.") { e ->
        Card(
            modifier = Modifier.fillMaxWidth().clickable {
                scope.launch {
                    AdminRepository.markErrorsSeen(e.message, e.whereAt)
                    load()
                }
            },
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
        ) {
            Column(Modifier.padding(Space.md)) {
                Text(e.message, fontWeight = FontWeight.Medium, style = MaterialTheme.typography.bodyMedium)
                Text(
                    "${e.whereAt} - ${e.occurrences} times" +
                        (if (e.devices > 0) " on ${e.devices} phones" else "") +
                        (e.lastSeen?.let { ", last $it" } ?: ""),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                // WHICH BUILD, or that it is not a build at all. Printing
                // "office" as though it were a version number is what made an
                // office failure read as a phone crash on a build nobody can
                // find.
                Text(
                    when {
                        e.isOffice -> "Office website"
                        e.latestVersion.isNullOrBlank() -> "No version recorded"
                        else -> "Newest on ${e.latestVersion}"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    fontWeight = FontWeight.Medium,
                    color = if (e.isOffice) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    "Tap to mark seen",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary
                )
            }
        }
    }
}

/**
 * Jobs where the two pricing engines disagreed about a total.
 *
 * The figure that matters is the GAP, so it leads. Both totals are shown
 * under it because which way round it went decides who was undercharged, and
 * the engine versions because a disagreement between two different versions
 * is a different thing from one between two copies of the same version.
 */
@Composable
private fun DriftTab() {
    var state by remember { mutableStateOf<Load<AdminRepository.Drift>>(Load.Loading) }
    LaunchedEffect(Unit) {
        state = AdminRepository.drift()
            .fold({ Load.Rows(it) }, { Load.Failed(shownError(it, "unknown error")) })
    }
    Section(state, "The two engines have not disagreed about a total.") { d ->
        AdminCard(
            title = "$" + String.format("%,.2f", d.gap) + " apart",
            lines = listOf(
                "Office $" + String.format("%,.2f", d.officeTotal) +
                    "   Phone $" + String.format("%,.2f", d.phoneTotal),
                "Engines " + d.officeEngine + " / " + d.phoneEngine,
                d.notedAt?.let { "Noted $it" } ?: "",
                if (d.seenAt == null) "Not looked at yet" else "Seen",
                "Job " + d.jobSyncId.take(8),
            )
        )
    }
}

@Composable
private fun SignInsTab() {
    var state by remember { mutableStateOf<Load<AdminRepository.SignInAttemptGroup>>(Load.Loading) }
    LaunchedEffect(Unit) {
        state = AdminRepository.signInAttempts()
            .fold({ Load.Rows(it) }, { Load.Failed(shownError(it, "unknown error")) })
    }
    Section(state, "No failed sign-ins in the last 7 days.") { s ->
        AdminCard(
            title = s.email,
            lines = listOf("${s.attempts} failed attempts" + (s.lastAt?.let { ", last $it" } ?: ""))
        )
    }
}

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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.cloud.AdminRepository
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
                                    .onFailure { stepUpError = it.message ?: "That code was not accepted." }
                                busy = false
                            }
                        },
                        modifier = Modifier.padding(top = Space.md)
                    ) { Text(if (busy) "Checking..." else "Unlock admin") }
                }

                AdminEntry.OPEN -> {
                    val tabs = listOf("Companies", "Releases", "Errors", "Sign-ins")
                    TabRow(selectedTabIndex = tab) {
                        tabs.forEachIndexed { i, title ->
                            Tab(selected = tab == i, onClick = { tab = i }, text = { Text(title) })
                        }
                    }
                    when (tab) {
                        0 -> CompaniesTab()
                        1 -> ReleasesTab()
                        2 -> ErrorsTab()
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

    suspend fun load() {
        state = AdminRepository.companies()
            .fold({ Load.Rows(it) }, { Load.Failed(it.message ?: "unknown error") })
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
                                .onFailure { addError = it.message ?: "Could not create it." }
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
                            result.onFailure { actionError = it.message ?: "That did not go through." }
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
            .onFailure { error = it.message ?: "Could not read the mail sender." }
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
                                .onFailure { error = it.message ?: "That did not go through." }
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
    var state by remember { mutableStateOf<Load<AdminRepository.Release>>(Load.Loading) }
    LaunchedEffect(Unit) {
        state = AdminRepository.releases()
            .fold({ Load.Rows(it) }, { Load.Failed(it.message ?: "unknown error") })
    }
    Section(state, "No releases.") { r ->
        AdminCard(
            title = "${r.versionName} (${r.versionCode})",
            lines = listOf(
                r.notes,
                r.audience + (if (r.isMandatory) " - mandatory" else ""),
                if (r.downloadUrl.isNullOrBlank()) "NO DOWNLOAD URL" else "",
            )
        )
    }
}

@Composable
private fun ErrorsTab() {
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf<Load<AdminRepository.ErrorGroup>>(Load.Loading) }
    suspend fun load() {
        state = AdminRepository.errorSummary()
            .fold({ Load.Rows(it) }, { Load.Failed(it.message ?: "unknown error") })
    }
    LaunchedEffect(Unit) { load() }
    Section(state, "Nothing has failed in the last 14 days.") { e ->
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
                    "${e.whereAt} - ${e.occurrences} times" + (e.lastSeen?.let { ", last $it" } ?: ""),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
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

@Composable
private fun SignInsTab() {
    var state by remember { mutableStateOf<Load<AdminRepository.SignInAttemptGroup>>(Load.Loading) }
    LaunchedEffect(Unit) {
        state = AdminRepository.signInAttempts()
            .fold({ Load.Rows(it) }, { Load.Failed(it.message ?: "unknown error") })
    }
    Section(state, "No failed sign-ins in the last 7 days.") { s ->
        AdminCard(
            title = s.email,
            lines = listOf("${s.attempts} failed attempts" + (s.lastAt?.let { ", last $it" } ?: ""))
        )
    }
}

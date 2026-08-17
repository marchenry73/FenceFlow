package com.fenceestimator.app.ui.account

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.foundation.text.KeyboardOptions
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.cloud.SyncPhase
import com.fenceestimator.app.ui.components.currentApp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountScreen(onBack: () -> Unit, onOpenAccess: () -> Unit = {}) {
    val app = currentApp()
    val viewModel: AccountViewModel = viewModel(
        factory = com.fenceestimator.app.ui.components.GenericViewModelFactory {
            AccountViewModel(app.repository, app.dataOwnership)
        }
    )
    val state by viewModel.state.collectAsState()
    val session by app.session.state.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(state.message) {
        state.message?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearMessage()
        }
    }

    // Keep the app-wide role in step with sign-in/out so the gated screens
    // update without needing a restart.
    LaunchedEffect(state.signedInEmail, state.profile?.companyId, state.profile?.role) {
        app.session.refresh()
        // A freshly-joined company means there is cloud data to reconcile now.
        if (state.profile?.companyId != null) app.autoSync.requestSync()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Account & Team") },
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
            if (!SupabaseModule.isConfigured) {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Text(
                            "Cloud accounts aren't configured in this build. The app still works fully offline on this device.",
                            Modifier.padding(16.dp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                return@LazyColumn
            }

            if (state.busy) {
                item { CircularProgressIndicator() }
            }

            if (!state.isSignedIn) {
                item { SignedOutSection(viewModel) }
            } else {
                item {
                    SignedInSection(
                        state = state,
                        viewModel = viewModel,
                        canManageAccess = session.canManageAccess,
                        canShareInviteCode = session.canShareInviteCode,
                        onOpenAccess = onOpenAccess
                    )
                }
                item { SyncStatusCard() }
                if (state.needsCompany) {
                    item { CompanySetupSection(viewModel) }
                }
            }
        }
    }
}

@Composable
private fun SignedOutSection(viewModel: AccountViewModel) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var isSignUp by remember { mutableStateOf(false) }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(if (isSignUp) "Create Account" else "Sign In", style = MaterialTheme.typography.titleMedium)
            Text(
                "Signing in lets your crew share one set of jobs. Without an account the app keeps working offline on this phone only.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedTextField(
                value = email, onValueChange = { email = it },
                label = { Text("Email") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = password, onValueChange = { password = it },
                label = { Text("Password") },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = { if (isSignUp) viewModel.signUp(email, password) else viewModel.signIn(email, password) },
                enabled = email.isNotBlank() && password.length >= 6,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(if (isSignUp) "Create Account" else "Sign In")
            }
            TextButton(onClick = { isSignUp = !isSignUp }, modifier = Modifier.fillMaxWidth()) {
                Text(if (isSignUp) "I already have an account" else "I need to create an account")
            }
        }
    }
}

@Composable
private fun SignedInSection(
    state: AccountUiState,
    viewModel: AccountViewModel,
    canManageAccess: Boolean,
    canShareInviteCode: Boolean,
    onOpenAccess: () -> Unit
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Signed In", style = MaterialTheme.typography.titleMedium)
            Text(state.signedInEmail.orEmpty(), fontWeight = FontWeight.Medium)
            state.profile?.let { profile ->
                Text(
                    "Access level: ${profile.userRole.name}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                profile.companyId?.takeIf { canShareInviteCode }?.let { id ->
                    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
                    val context = androidx.compose.ui.platform.LocalContext.current

                    Text("Team invite code", style = MaterialTheme.typography.labelLarge)
                    // Selectable as well as copyable: a long UUID is miserable
                    // to retype, and crews will inevitably want to send it on.
                    androidx.compose.foundation.text.selection.SelectionContainer {
                        Text(
                            id,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        OutlinedButton(
                            onClick = {
                                clipboard.setText(androidx.compose.ui.text.AnnotatedString(id))
                            },
                            modifier = Modifier.weight(1f)
                        ) { Text("Copy code") }
                        OutlinedButton(
                            onClick = {
                                com.fenceestimator.app.ui.components.IntentHelpers.openEmailDraft(
                                    context, "", "Join our FenceFlow team",
                                    "Install FenceFlow, create an account, then choose \"Join as Crew\" " +
                                        "and enter this invite code:\n\n$id"
                                )
                            },
                            modifier = Modifier.weight(1f)
                        ) { Text("Share") }
                    }
                    Text(
                        "Crew members enter this when joining your business.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            // Only shown to someone who can actually use it. Offering a screen
            // that refuses you when you arrive is worse than not offering it.
            if (canManageAccess) {
                Button(onClick = onOpenAccess, modifier = Modifier.fillMaxWidth()) {
                    Text("Who Can Do What")
                }
            }
            OutlinedButton(onClick = { viewModel.signOut() }, modifier = Modifier.fillMaxWidth()) {
                Text("Sign Out")
            }
        }
    }
}

@Composable
private fun SyncStatusCard() {
    val app = currentApp()
    val sync by app.autoSync.state.collectAsState()
    val timeFormat = remember { java.text.SimpleDateFormat("h:mm a", java.util.Locale.US) }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Cloud Save", style = MaterialTheme.typography.titleMedium)
            val (label, detail) = when (sync.phase) {
                SyncPhase.SYNCING -> "Saving to cloud..." to null
                SyncPhase.OK -> "Everything saved" to
                    sync.lastSyncedAt?.let { "Last saved ${timeFormat.format(java.util.Date(it))}" }
                // No signal is normal on a job site and fixes itself, so it
                // reads as a status rather than a failure. Calling it an error
                // teaches people to ignore the one that isn't.
                SyncPhase.WAITING_FOR_SIGNAL -> "Waiting for signal" to
                    "Your work is saved on this phone and uploads the moment you're back online."
                SyncPhase.FAILED -> "Couldn't reach the cloud" to
                    (sync.lastError ?: "Your work is safe on this phone and will upload automatically when you're back online.")
                SyncPhase.OFFLINE_ONLY -> "Saving on this phone only" to
                    "Join or create a business above to save to the cloud."
                SyncPhase.IDLE -> "Waiting..." to null
            }
            Text(label, fontWeight = FontWeight.Medium)
            detail?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                "Your jobs save automatically -- when you make a change, when you open the app, and every so often in the background. " +
                    "Everything works offline; changes upload once you have signal.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedButton(
                onClick = { app.autoSync.requestSync() },
                enabled = sync.phase != SyncPhase.SYNCING,
                modifier = Modifier.fillMaxWidth()
            ) { Text("Sync Now") }
        }
    }
}

@Composable
private fun CompanySetupSection(viewModel: AccountViewModel) {
    var companyName by remember { mutableStateOf("") }
    var ownerName by remember { mutableStateOf("") }
    var inviteCode by remember { mutableStateOf("") }
    var requestedRole by remember { mutableStateOf(com.fenceestimator.app.cloud.UserRole.CREW) }
    var memberName by remember { mutableStateOf("") }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Set Up Your Business", style = MaterialTheme.typography.titleMedium)
            Text(
                "Owners create the business. Crew members join with the invite code the owner shares.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedTextField(
                value = companyName, onValueChange = { companyName = it },
                label = { Text("Business name") }, modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = ownerName, onValueChange = { ownerName = it },
                label = { Text("Your name") }, modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = { viewModel.createCompany(companyName, ownerName) },
                enabled = companyName.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) { Text("Create My Business (Owner)") }

            Text("— or —", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)

            OutlinedTextField(
                value = inviteCode, onValueChange = { inviteCode = it },
                label = { Text("Invite code from your owner") }, modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = memberName, onValueChange = { memberName = it },
                label = { Text("Your name") }, modifier = Modifier.fillMaxWidth()
            )
            // What they do, in their words.
            //
            // This is a statement, not a choice: everybody joins as crew
            // whatever they pick here, and the owner confirms it. Letting the
            // joiner set their own role would mean anyone holding the invite
            // code could arrive as a manager and read the company's money. But
            // asking is still worth it -- the alternative is the owner facing a
            // list of unnamed crew rows and having to work out who is who.
            Text("What do you do?", style = MaterialTheme.typography.labelLarge)
            com.fenceestimator.app.cloud.UserRole.values()
                .filter { it != com.fenceestimator.app.cloud.UserRole.OWNER }
                .forEach { option ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 2.dp),
                        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically
                    ) {
                        androidx.compose.material3.RadioButton(
                            selected = requestedRole == option,
                            onClick = { requestedRole = option }
                        )
                        Text(option.label, style = MaterialTheme.typography.bodyMedium)
                    }
                }
            Text(
                "Your owner confirms this before it takes effect. Until then you " +
                    "will see today's work only.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            OutlinedButton(
                onClick = { viewModel.joinCompany(inviteCode, memberName, requestedRole) },
                enabled = inviteCode.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) { Text("Join the team") }
        }
    }
}

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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.foundation.text.KeyboardOptions
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.cloud.SyncPhase
import com.fenceestimator.app.ui.components.currentApp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountScreen(
    onBack: () -> Unit,
    onOpenAccess: () -> Unit = {},
    onOpenTrash: () -> Unit = {}
) {
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
                title = { Text(stringResource(R.string.account_title)) },
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
            if (!SupabaseModule.isConfigured) {
                item {
                    Card(Modifier.fillMaxWidth()) {
                        Text(
                            stringResource(R.string.acct_cloud_not_configured),
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
                        canRestore = session.canDelete,
                        onOpenAccess = onOpenAccess,
                        onOpenTrash = onOpenTrash
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
            Text(
                stringResource(if (isSignUp) R.string.acct_create_account else R.string.action_sign_in),
                style = MaterialTheme.typography.titleMedium
            )
            Text(
                stringResource(R.string.acct_sign_in_explain),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedTextField(
                value = email, onValueChange = { email = it },
                label = { Text(stringResource(R.string.field_email)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = password, onValueChange = { password = it },
                label = { Text(stringResource(R.string.acct_password)) },
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = { if (isSignUp) viewModel.signUp(email, password) else viewModel.signIn(email, password) },
                enabled = email.isNotBlank() && password.length >= 6,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(if (isSignUp) R.string.acct_create_account else R.string.action_sign_in))
            }
            TextButton(onClick = { isSignUp = !isSignUp }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(if (isSignUp) R.string.acct_already_have_account else R.string.acct_need_create_account))
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
    canRestore: Boolean,
    onOpenAccess: () -> Unit,
    onOpenTrash: () -> Unit
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.acct_signed_in), style = MaterialTheme.typography.titleMedium)
            Text(state.signedInEmail.orEmpty(), fontWeight = FontWeight.Medium)
            state.profile?.let { profile ->
                Text(
                    stringResource(R.string.acct_access_level, profile.userRole.name),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                profile.companyId?.takeIf { canShareInviteCode }?.let { id ->
                    val clipboard = androidx.compose.ui.platform.LocalClipboardManager.current
                    val context = androidx.compose.ui.platform.LocalContext.current
                    val shareSubject = stringResource(R.string.acct_invite_share_subject)
                    val shareBody = stringResource(R.string.acct_invite_share_body, id)
                    val shareChooserTitle = stringResource(R.string.acct_invite_share_chooser)

                    Text(stringResource(R.string.acct_team_invite_code), style = MaterialTheme.typography.labelLarge)
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
                        ) { Text(stringResource(R.string.acct_copy_code)) }
                        OutlinedButton(
                            onClick = {
                                // Share sheet, not email. Crew get sent this on
                                // whatever they actually use, and assuming email
                                // is how a code ends up read out over the phone.
                                com.fenceestimator.app.ui.components.IntentHelpers.shareText(
                                    context = context,
                                    subject = shareSubject,
                                    body = shareBody,
                                    chooserTitle = shareChooserTitle
                                )
                            },
                            modifier = Modifier.weight(1f)
                        ) { Text(stringResource(R.string.action_share)) }
                    }
                    Text(
                        stringResource(R.string.acct_invite_code_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            // Only shown to someone who can actually use it. Offering a screen
            // that refuses you when you arrive is worse than not offering it.
            if (canManageAccess) {
                Button(onClick = onOpenAccess, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.acct_who_can_do_what))
                }
            }
            if (canRestore) {
                OutlinedButton(onClick = onOpenTrash, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.acct_deleted_items))
                }
            }
            OutlinedButton(onClick = { viewModel.signOut() }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.action_sign_out))
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
            Text(stringResource(R.string.account_cloud_save), style = MaterialTheme.typography.titleMedium)
            val (label, detail) = when (sync.phase) {
                SyncPhase.SYNCING -> stringResource(R.string.sync_saving) to null
                SyncPhase.OK -> stringResource(R.string.sync_saved) to
                    sync.lastSyncedAt?.let { stringResource(R.string.acct_sync_last_saved, timeFormat.format(java.util.Date(it))) }
                // No signal is normal on a job site and fixes itself, so it
                // reads as a status rather than a failure. Calling it an error
                // teaches people to ignore the one that isn't.
                SyncPhase.WAITING_FOR_SIGNAL -> stringResource(R.string.acct_sync_waiting_for_signal) to
                    stringResource(R.string.acct_sync_waiting_for_signal_detail)
                SyncPhase.FAILED -> stringResource(R.string.sync_failed) to
                    (sync.lastError ?: stringResource(R.string.acct_sync_failed_detail))
                SyncPhase.OFFLINE_ONLY -> stringResource(R.string.sync_local_only) to
                    stringResource(R.string.acct_sync_local_only_detail)
                SyncPhase.IDLE -> stringResource(R.string.acct_sync_waiting) to null
            }
            Text(label, fontWeight = FontWeight.Medium)
            detail?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(
                stringResource(R.string.sync_explain),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedButton(
                onClick = { app.autoSync.requestSync() },
                enabled = sync.phase != SyncPhase.SYNCING,
                modifier = Modifier.fillMaxWidth()
            ) { Text(stringResource(R.string.action_sync_now)) }
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
    var setupCode by remember { mutableStateOf("") }
    var setupName by remember { mutableStateOf("") }

    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(stringResource(R.string.acct_set_up_business), style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.acct_set_up_business_explain),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            // The path for a company FenceFlow set up in advance.
            //
            // First, because it is the one a new customer will be using: they
            // were sent a code and told to sign up. Their company is already
            // waiting; this attaches their new account to it as the owner,
            // without anybody at FenceFlow ever handling their password.
            Text(
                stringResource(R.string.acct_sent_setup_code),
                style = MaterialTheme.typography.titleSmall
            )
            OutlinedTextField(
                value = setupCode,
                onValueChange = { setupCode = it.uppercase() },
                label = { Text(stringResource(R.string.acct_setup_code)) },
                placeholder = { Text(stringResource(R.string.acct_setup_code_placeholder)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = setupName, onValueChange = { setupName = it },
                label = { Text(stringResource(R.string.acct_your_name)) }, modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = { viewModel.claimCompanySetup(setupCode, setupName) },
                enabled = setupCode.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) { Text(stringResource(R.string.acct_set_up_my_company)) }

            Text(
                stringResource(R.string.acct_or_if_nobody_sent_one),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedTextField(
                value = companyName, onValueChange = { companyName = it },
                label = { Text(stringResource(R.string.acct_business_name)) }, modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = ownerName, onValueChange = { ownerName = it },
                label = { Text(stringResource(R.string.acct_your_name)) }, modifier = Modifier.fillMaxWidth()
            )
            Button(
                onClick = { viewModel.createCompany(companyName, ownerName) },
                enabled = companyName.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) { Text(stringResource(R.string.acct_create_my_business)) }

            Text(stringResource(R.string.acct_or_separator), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)

            OutlinedTextField(
                value = inviteCode, onValueChange = { inviteCode = it },
                label = { Text(stringResource(R.string.acct_invite_code_from_owner)) }, modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = memberName, onValueChange = { memberName = it },
                label = { Text(stringResource(R.string.acct_your_name)) }, modifier = Modifier.fillMaxWidth()
            )
            // What they do, in their words.
            //
            // This is a statement, not a choice: everybody joins as crew
            // whatever they pick here, and the owner confirms it. Letting the
            // joiner set their own role would mean anyone holding the invite
            // code could arrive as a manager and read the company's money. But
            // asking is still worth it -- the alternative is the owner facing a
            // list of unnamed crew rows and having to work out who is who.
            Text(stringResource(R.string.acct_what_do_you_do), style = MaterialTheme.typography.labelLarge)
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
                stringResource(R.string.acct_owner_confirms_role),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            OutlinedButton(
                onClick = { viewModel.joinCompany(inviteCode, memberName, requestedRole) },
                enabled = inviteCode.isNotBlank(),
                modifier = Modifier.fillMaxWidth()
            ) { Text(stringResource(R.string.acct_join_the_team)) }
        }
    }
}

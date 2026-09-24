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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import io.github.jan.supabase.auth.auth
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.cloud.SyncPhase
import com.fenceestimator.app.ui.components.UiMessage
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.label
import com.fenceestimator.app.ui.components.resolve
import com.fenceestimator.app.ui.theme.Space

/**
 * How long a fresh sign-in waits for the app-wide session to catch up before
 * giving up on going home by itself. That catch-up can include waiting out
 * the auth plugin (up to five seconds, see SessionManager) and a profile read
 * on poor signal. Giving up only means staying here, which is where sign-in
 * always used to leave people.
 */
private const val SESSION_CATCH_UP_MS = 20_000L

/**
 * Where the reset email's link opens. The phone has no page of its own to
 * land on -- website/dashboard.html's own "Forgot your password?" handler is
 * the only place that flow has ever worked, so this matches its redirectTo
 * (location.origin + location.pathname on the live site) instead of pointing
 * at something the app has never built.
 */
private const val PASSWORD_RESET_REDIRECT_URL = "https://fenceflowapp.com/dashboard.html"

/**
 * @param onSignedIn a sign-in made on this screen got in and the account has
 *   nothing left to do here -- the caller takes it to the home screen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountScreen(
    onBack: () -> Unit,
    onOpenAccess: () -> Unit = {},
    onOpenTrash: () -> Unit = {},
    onSignedIn: () -> Unit = {}
) {
    val app = currentApp()
    val viewModel: AccountViewModel = viewModel(
        factory = com.fenceestimator.app.ui.components.GenericViewModelFactory {
            AccountViewModel(app.repository, app.dataOwnership, app.settingsStore)
        }
    )
    val state by viewModel.state.collectAsState()
    val session by app.session.state.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }

    // Resolved here because the snackbar coroutine is not a composition --
    // the resource lookup has to happen while we still are.
    val messageText = state.message?.resolve()
    LaunchedEffect(state.message) {
        messageText?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.clearMessage()
        }
    }

    // Confirm a sign-out that happened somewhere else.
    //
    // Signing out from the paused screen simply swaps that screen for this one,
    // which looks identical to the app having dropped you -- and that screen is
    // already somewhere people are unsure what is going on. Said once, then
    // forgotten.
    val signedOutText = stringResource(R.string.vm_signed_out)
    LaunchedEffect(Unit) {
        if (com.fenceestimator.app.cloud.SupabaseModule.justSignedOut) {
            com.fenceestimator.app.cloud.SupabaseModule.justSignedOut = false
            snackbarHostState.showSnackbar(signedOutText)
        }
    }

    // Keep the app-wide role in step with sign-in/out so the gated screens
    // update without needing a restart.
    LaunchedEffect(state.signedInEmail, state.profile?.companyId, state.profile?.role) {
        app.session.refresh()
        // A freshly-joined company means there is cloud data to reconcile now.
        if (state.profile?.companyId != null) app.autoSync.requestSync()
    }

    // Straight on to the home screen after a sign-in made here, rather than
    // leaving somebody on a card that says "Signed in" to find their own way
    // back. Everyone's home is the same route: the jobs screen draws the
    // office dashboard or the crew's own view from the role.
    //
    // Not before the app-wide session has caught up with who just signed in.
    // Until it does it still reads signed out, and signed out means full
    // access on your own phone -- arriving early would draw a crew member the
    // owner's dashboard, money and all, for as long as the gap lasted.
    //
    // And not at all while a step is left. No company yet stays here for the
    // setup form below -- which is also where the welcome screen's "Sign in"
    // leaves a brand-new account -- and a profile that could not be read stays
    // for its retry. The held-work and paused screens need nothing from here:
    // they sit above every route and take over wherever this lands.
    var goingHome by remember { mutableStateOf(false) }
    LaunchedEffect(state.justSignedIn) {
        if (!state.justSignedIn) return@LaunchedEffect
        val email = state.signedInEmail
        goingHome = true
        val caughtUp = email?.let {
            withTimeoutOrNull(SESSION_CATCH_UP_MS) {
                app.session.state.first { s ->
                    s.signedIn && s.accessKnown && s.email.equals(email, ignoreCase = true)
                }
            }
        }
        goingHome = false
        viewModel.consumeJustSignedIn()
        // Both have to agree there is a company. The session can answer from
        // this phone's memory of an earlier sign-in; the profile read here is
        // fresh, and is what decides whether the setup form shows.
        if (caughtUp?.companyId != null && state.profile?.companyId != null) onSignedIn()
    }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = { Text(stringResource(R.string.account_title)) },
                    navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
                )
                // Up here, not as a row at the top of the list. Inserting it
                // there shifted every card below it down one slot, and a card
                // in a new slot is a new card: the sign-in form was rebuilt
                // blank the moment Sign in was tapped, which is how a wrong
                // password cost people the email they had typed as well.
                if (state.busy || goingHome) {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
            }
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

            if (!state.isSignedIn) {
                item { SignedOutSection(state, viewModel) }
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
                item { SyncStatusCard(onRecalculate = { viewModel.recalculateTotals() }) }
                // A dropped connection while loading the profile must never be
                // read as "no company" -- that is exactly the mixup that once
                // put the setup form in front of an owner who already had a
                // business, and they built a second, empty one. Only a fetch
                // that actually succeeded and came back empty gets the form.
                if (state.profileFetchFailed) {
                    item { ProfileUnreachableSection(onRetry = { viewModel.refresh() }) }
                } else if (state.needsCompany) {
                    item { CompanySetupSection(viewModel) }
                }
            }
        }
    }
}

@Composable
private fun SignedOutSection(state: AccountUiState, viewModel: AccountViewModel) {
    // Saveable, so the address also survives the phone being turned sideways.
    var email by rememberSaveable { mutableStateOf("") }
    // Never saveable. Saved state is written out with the activity, and a
    // password has no business being anywhere but this box.
    var password by remember { mutableStateOf("") }
    var isSignUp by rememberSaveable { mutableStateOf(false) }
    val passwordFocus = remember { FocusRequester() }

    // The address that last got in on this phone, once the settings store has
    // answered. Only ever fills an empty box -- never what somebody has
    // already started typing.
    LaunchedEffect(state.lastSignInEmail) {
        val remembered = state.lastSignInEmail
        if (email.isEmpty() && !remembered.isNullOrBlank()) email = remembered
    }

    // Wrong password: the address stays, only the password is emptied, and the
    // cursor goes back into it -- so trying again is one box, not two.
    LaunchedEffect(state.passwordRejected) {
        if (state.passwordRejected) {
            password = ""
            runCatching { passwordFocus.requestFocus() }
            viewModel.consumePasswordRejected()
        }
    }

    // Not while one is already running: a second tap used to fire a second
    // sign-in behind the first.
    val canSubmit = !state.busy && email.isNotBlank() && password.length >= 6
    val submit = { if (isSignUp) viewModel.signUp(email, password) else viewModel.signIn(email, password) }
    val errorText = state.signInError?.resolve()

    // Kept local to this screen rather than in AccountViewModel -- nothing
    // else needs to know a reset was requested, and there is no session state
    // for it to affect either way.
    var resetBusy by remember { mutableStateOf(false) }
    var resetMessage by remember { mutableStateOf<UiMessage?>(null) }
    var resetIsError by remember { mutableStateOf(false) }
    val resetScope = rememberCoroutineScope()

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
                value = email,
                onValueChange = {
                    email = it
                    viewModel.clearSignInError()
                },
                label = { Text(stringResource(R.string.field_email)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth()
            )
            OutlinedTextField(
                value = password,
                onValueChange = {
                    password = it
                    viewModel.clearSignInError()
                },
                label = { Text(stringResource(R.string.acct_password)) },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(
                    onDone = { if (canSubmit) submit() else defaultKeyboardAction(ImeAction.Done) }
                ),
                modifier = Modifier.fillMaxWidth().focusRequester(passwordFocus)
            )
            if (errorText != null) {
                Text(
                    errorText,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error
                )
            }
            Button(
                onClick = submit,
                enabled = canSubmit,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text(stringResource(if (isSignUp) R.string.acct_create_account else R.string.action_sign_in))
            }
            // Sign-up has no password to forget yet -- matches the office,
            // which hides its own "Forgot your password?" link in that state.
            if (!isSignUp) {
                TextButton(
                    onClick = {
                        val target = email.trim()
                        if (target.isEmpty()) {
                            resetIsError = true
                            resetMessage = UiMessage(R.string.acct_forgot_password_enter_email_first)
                            return@TextButton
                        }
                        resetBusy = true
                        resetMessage = null
                        resetScope.launch {
                            val result = runCatching {
                                SupabaseModule.client.auth.resetPasswordForEmail(
                                    target,
                                    PASSWORD_RESET_REDIRECT_URL
                                )
                            }
                            resetBusy = false
                            result.fold(
                                onSuccess = {
                                    resetIsError = false
                                    // Same wording whether or not this address has
                                    // an account. The office does the same for the
                                    // same reason: telling someone an email is NOT
                                    // registered hands an attacker a list of who is.
                                    resetMessage = UiMessage(R.string.acct_forgot_password_sent)
                                },
                                onFailure = { error ->
                                    // One fixed sentence, never the server's own
                                    // words. GoTrue answers a request for an address
                                    // with no account by doing nothing and returning
                                    // success -- so it is only a REAL address that
                                    // can get as far as trying to send and come back
                                    // with "Email rate limit exceeded". Printing the
                                    // error verbatim turned "Couldn't send that" into
                                    // an answer to "does this person have an account
                                    // here" -- exactly what the success wording above
                                    // is careful not to give away.
                                    //
                                    // The error still goes to the log, where the
                                    // person who owns the phone can read it and a
                                    // stranger at the sign-in screen cannot.
                                    android.util.Log.w(
                                        "AccountScreen",
                                        "password reset request failed: " + error.message
                                    )
                                    resetIsError = true
                                    resetMessage = UiMessage(R.string.acct_forgot_password_failed)
                                }
                            )
                        }
                    },
                    enabled = !resetBusy,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Text(stringResource(R.string.acct_forgot_password))
                }
                resetMessage?.let {
                    Text(
                        it.resolve(),
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (resetIsError) MaterialTheme.colorScheme.error
                                else MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            TextButton(
                onClick = {
                    isSignUp = !isSignUp
                    viewModel.clearSignInError()
                },
                modifier = Modifier.fillMaxWidth()
            ) {
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
                    stringResource(R.string.acct_access_level, profile.userRole.label()),
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
            var confirmingSignOut by remember { mutableStateOf(false) }
            // Checked here, not just inside signOut() itself, so the dialog
            // below can say up front what a tap would throw away instead of
            // the person finding out from an error after the fact -- the
            // same thing ServiceBlockedScreen already does before its own
            // sign-out button.
            var unsynced by remember { mutableStateOf<com.fenceestimator.app.data.UnsyncedSummary?>(null) }
            val app = currentApp()
            LaunchedEffect(confirmingSignOut) {
                if (confirmingSignOut) {
                    unsynced = runCatching { app.repository.unsyncedSummary() }.getOrNull()
                }
            }
            val holdsUnsyncedWork = unsynced?.isEmpty == false

            // A refusal can arrive even after this dialog's own "sign out
            // anyway" pass -- the local unsynced check here was stale, or a
            // deeper server-side rejection kept the real push from landing.
            // Re-show the dialog with a fresh read of what's waiting instead
            // of leaving the refusal as a Snackbar that scrolls away.
            LaunchedEffect(state.signOutBlockedByUnsyncedWork) {
                if (state.signOutBlockedByUnsyncedWork) {
                    unsynced = runCatching { app.repository.unsyncedSummary() }.getOrNull()
                    confirmingSignOut = true
                    viewModel.consumeSignOutBlocked()
                }
            }

            OutlinedButton(onClick = { confirmingSignOut = true }, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.action_sign_out))
            }

            if (confirmingSignOut) {
                AlertDialog(
                    onDismissRequest = { confirmingSignOut = false },
                    title = { Text(stringResource(R.string.action_sign_out)) },
                    text = {
                        // Shifts that can never sync as they stand never gate
                        // sign-out (see Repository.hasUnsyncedWork) -- but a
                        // sign-out that quietly leaves them behind with no
                        // mention is its own way of hiding the same problem.
                        val blockedShifts = unsynced?.blockedTimeEntries ?: 0
                        val body = if (holdsUnsyncedWork) {
                            stringResource(
                                R.string.onb_sign_out_unsynced_warning,
                                unsynced?.jobs ?: 0,
                                unsynced?.files ?: 0
                            )
                        } else {
                            stringResource(R.string.acct_sign_out_confirm_body)
                        }
                        Text(
                            if (blockedShifts > 0) {
                                body + "\n\n" + stringResource(
                                    R.string.sync_blocked_shifts_sign_out_note,
                                    blockedShifts
                                )
                            } else body
                        )
                    },
                    confirmButton = {
                        Button(
                            onClick = {
                                confirmingSignOut = false
                                // force only when the warning above already
                                // told them it would happen -- the plain
                                // confirm below never needs it, since signOut()
                                // itself still refuses if it turns out there is
                                // unsynced work this check missed.
                                viewModel.signOut(force = holdsUnsyncedWork)
                            }
                        ) {
                            Text(
                                stringResource(
                                    if (holdsUnsyncedWork) R.string.onb_sign_out_anyway
                                    else R.string.action_sign_out
                                )
                            )
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { confirmingSignOut = false }) {
                            Text(stringResource(R.string.action_cancel))
                        }
                    }
                )
            }
        }
    }
}

@Composable
private fun SyncStatusCard(onRecalculate: () -> Unit) {
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
                // Deliberately NOT grouped with "no signal" above. That one
                // fixes itself and is right to read as a status; this one never
                // does, and reading as a status is exactly how it went unnoticed.
                SyncPhase.SIGNED_OUT -> stringResource(R.string.acct_sync_signed_out) to
                    stringResource(R.string.acct_sync_signed_out_detail)
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
            // The escape hatch for a money figure that looks wrong: rebuild
            // every cached total from the payment ledger on the server, then
            // pull the corrected rows. Safe at any time -- it only writes what
            // the ledger already says.
            OutlinedButton(
                onClick = onRecalculate,
                modifier = Modifier.fillMaxWidth()
            ) { Text(stringResource(R.string.acct_recalculate_totals)) }
        }
    }
}

/**
 * Shown instead of [CompanySetupSection] while the profile fetch itself
 * failed -- never while it succeeded and simply found no company. Offering
 * the setup form here is how an owner who already has a business ends up
 * building a second, empty one because their signal dropped mid-load.
 */
@Composable
private fun ProfileUnreachableSection(onRetry: () -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.row)) {
            Text(
                stringResource(R.string.acct_profile_unreachable),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            OutlinedButton(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.action_retry))
            }
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
            // Setup code above is the recommended path -- it is the one FenceFlow
            // actually sends people to sign up with. This and Join below are
            // both alternatives to it, so only setup code gets the filled
            // button; two equally-weighted filled buttons for mutually
            // exclusive paths made it look like a choice with no wrong answer,
            // when picking this over a setup code you were sent means a second,
            // empty business instead of the one waiting for you.
            OutlinedButton(
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
                        Text(option.label(), style = MaterialTheme.typography.bodyMedium)
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

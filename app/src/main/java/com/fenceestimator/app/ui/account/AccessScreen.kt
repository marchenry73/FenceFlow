package com.fenceestimator.app.ui.account

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
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Divider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.cloud.CloudProfile
import com.fenceestimator.app.cloud.Permission
import com.fenceestimator.app.cloud.PermissionOverrides
import com.fenceestimator.app.cloud.UserRole
import com.fenceestimator.app.cloud.defaultPermissions
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.lock.confirmIdentity

/**
 * Who on the team can do what.
 *
 * Roles alone were too blunt for a real crew: the foreman of nine years and the
 * hire from last week share a role, and forcing a distinction between them
 * through six fixed roles ends with somebody being handed the owner login.
 * Here the role sets the starting point and each person is adjusted from it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccessScreen(onBack: () -> Unit) {
    val app = currentApp()
    val viewModel: AccessViewModel = viewModel(
        factory = GenericViewModelFactory { AccessViewModel(app.session) }
    )
    val session by app.session.state.collectAsState()
    val context = androidx.compose.ui.platform.LocalContext.current
    val team by viewModel.team.collectAsState()
    val message by viewModel.message.collectAsState()

    var editing by remember { mutableStateOf<CloudProfile?>(null) }
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(Unit) { viewModel.load() }
    LaunchedEffect(message) { message?.let { snackbarHostState.showSnackbar(it) } }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Who Can Do What") },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) }
    ) { padding ->
        if (!session.canManageAccess) {
            // Stated rather than left as an empty screen. "Nothing here" reads
            // as broken; "you do not have this" reads as a decision.
            Column(Modifier.fillMaxSize().padding(padding).padding(24.dp)) {
                Text(
                    "Only someone with \"Manage who can do what\" can change access.",
                    style = MaterialTheme.typography.bodyLarge
                )
            }
            return@Scaffold
        }

        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            item {
                Text(
                    "Each person starts with what their role allows. Tap someone to give " +
                        "them more, or take something away.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            items(team, key = { it.id }) { member ->
                val effective = PermissionOverrides.resolve(member.userRole, member.permissionOverrides)
                val adjusted = member.permissionOverrides.isNotBlank()
                Card(
                    onClick = { editing = member },
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Column(Modifier.padding(14.dp)) {
                        Text(
                            member.fullName.ifBlank { "(no name set)" },
                            style = MaterialTheme.typography.titleMedium
                        )
                        Text(
                            member.userRole.label + if (adjusted) " -- adjusted" else "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        // What they said they were when they joined. Everybody
                        // arrives as crew whatever they pick, so this is the
                        // only place it gets acted on -- and a request nobody
                        // ever sees is the same as not having asked.
                        val requested = runCatching {
                            UserRole.valueOf(member.requestedRole)
                        }.getOrNull()
                        if (requested != null && requested != member.userRole) {
                            Text(
                                "Says they are a " + requested.label + " -- tap to confirm",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.primary
                            )
                        }
                        Text(
                            "${effective.size} of ${Permission.ALL.size} things allowed",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        if (Permission.DELETE_RECORDS in effective || Permission.MANAGE_ACCESS in effective) {
                            Row(
                                verticalAlignment = Alignment.CenterVertically,
                                modifier = Modifier.padding(top = 4.dp)
                            ) {
                                Icon(
                                    Icons.Filled.WarningAmber,
                                    contentDescription = null,
                                    tint = MaterialTheme.colorScheme.error
                                )
                                Text(
                                    "  Can " + listOfNotNull(
                                        "delete records".takeIf { Permission.DELETE_RECORDS in effective },
                                        "change access".takeIf { Permission.MANAGE_ACCESS in effective }
                                    ).joinToString(" and "),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.error
                                )
                            }
                        }
                    }
                }
            }

            if (team.isEmpty()) {
                item {
                    Text(
                        "Nobody has joined yet. Share your invite code from Account & Team.",
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            }
        }
    }

    editing?.let { member ->
        MemberAccessDialog(
            member = member,
            isSelf = member.id == com.fenceestimator.app.cloud.SupabaseModule.currentUserId(),
            onSave = { role, permissions ->
                // Prove it is really you before this applies.
                //
                // Changing what somebody can do is not ordinary editing -- it
                // is the action that can hand over the money, the deletions, or
                // the ability to grant anything else. An unlocked phone left on
                // a truck seat should not be enough on its own.
                confirmIdentity(
                    context = context,
                    title = "Confirm access change",
                    subtitle = "Changing what this person can do",
                    onConfirmed = {
                        viewModel.save(member, role, permissions)
                        editing = null
                    }
                )
            },
            onDismiss = { editing = null }
        )
    }
}

/**
 * The per-person toggles.
 *
 * Grouped so the four that lose money or destroy records sit apart under a
 * warning, rather than in a list of thirteen switches where they read the same
 * as "see customer contact details".
 */
@Composable
private fun MemberAccessDialog(
    member: CloudProfile,
    isSelf: Boolean,
    onSave: (UserRole, Set<Permission>) -> Unit,
    onDismiss: () -> Unit
) {
    var role by remember { mutableStateOf(member.userRole) }
    var permissions by remember {
        mutableStateOf(PermissionOverrides.resolve(member.userRole, member.permissionOverrides))
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(member.fullName.ifBlank { "Team member" }) },
        text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (isSelf) {
                    item {
                        Card(
                            colors = CardDefaults.cardColors(
                                containerColor = MaterialTheme.colorScheme.errorContainer
                            )
                        ) {
                            Text(
                                "You cannot change your own access. Ask another owner -- " +
                                    "otherwise anyone who reaches this screen could give " +
                                    "themselves everything.",
                                modifier = Modifier.padding(10.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onErrorContainer
                            )
                        }
                    }
                }

                item {
                    Text("Role", style = MaterialTheme.typography.titleSmall)
                }
                items(UserRole.values()) { option ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        androidx.compose.material3.RadioButton(
                            selected = role == option,
                            enabled = !isSelf,
                            onClick = {
                                role = option
                                // Changing role resets to that role's starting
                                // point. Carrying old adjustments across would
                                // silently keep permissions the new role was
                                // never meant to include.
                                permissions = option.defaultPermissions
                            }
                        )
                        Column(Modifier.padding(start = 4.dp)) {
                            Text(option.label, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                option.description,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }

                item { Divider(Modifier.padding(vertical = 8.dp)) }
                item { Text("Allowed to", style = MaterialTheme.typography.titleSmall) }

                items(Permission.values().filter { !it.sensitive }) { permission ->
                    PermissionRow(permission, permission in permissions, enabled = !isSelf) { on ->
                        permissions = if (on) permissions + permission else permissions - permission
                    }
                }

                item { Divider(Modifier.padding(vertical = 8.dp)) }
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            Icons.Filled.WarningAmber,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.error
                        )
                        Text(
                            "  Give these carefully",
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                }
                items(Permission.values().filter { it.sensitive }) { permission ->
                    PermissionRow(permission, permission in permissions, enabled = !isSelf) { on ->
                        permissions = if (on) permissions + permission else permissions - permission
                    }
                }
            }
        },
        confirmButton = {
            Button(enabled = !isSelf, onClick = { onSave(role, permissions) }) { Text("Save") }
        },
        dismissButton = { OutlinedButton(onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun PermissionRow(
    permission: Permission,
    checked: Boolean,
    enabled: Boolean,
    onChange: (Boolean) -> Unit
) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                permission.label,
                style = MaterialTheme.typography.bodyMedium,
                color = if (permission.sensitive) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.onSurface
            )
            Text(
                permission.description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Switch(checked = checked, enabled = enabled, onCheckedChange = onChange)
    }
}

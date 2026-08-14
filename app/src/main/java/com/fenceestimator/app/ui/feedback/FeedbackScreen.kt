package com.fenceestimator.app.ui.feedback

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.Row
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.ui.components.IntentHelpers
import com.fenceestimator.app.ui.components.currentApp

private enum class FeedbackKind(val label: String) {
    SUGGESTION("Suggestion"),
    COMPLAINT("Complaint"),
    SAFETY("Safety concern")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FeedbackScreen(onBack: () -> Unit) {
    val app = currentApp()
    val context = LocalContext.current
    val profile by app.settingsStore.profile.collectAsState(initial = BusinessProfile())

    var kind by remember { mutableStateOf(FeedbackKind.SUGGESTION) }
    var anonymous by remember { mutableStateOf(true) }
    var name by remember { mutableStateOf("") }
    var message by remember { mutableStateOf("") }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Suggestions & Complaints") },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = "Back") } }
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxWidth().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(
                            "Got an idea that would make the work easier, or something that needs to be raised? Send it in. " +
                                "You can leave your name off if you'd rather.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FeedbackKind.values().forEach { k ->
                                FilterChip(selected = kind == k, onClick = { kind = k }, label = { Text(k.label) })
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Send anonymously", Modifier.weight(1f))
                            Switch(checked = anonymous, onCheckedChange = { anonymous = it })
                        }
                        if (!anonymous) {
                            OutlinedTextField(
                                value = name, onValueChange = { name = it },
                                label = { Text("Your name") }, modifier = Modifier.fillMaxWidth()
                            )
                        }
                        OutlinedTextField(
                            value = message, onValueChange = { message = it },
                            label = { Text("What would you like to say?") },
                            minLines = 6, modifier = Modifier.fillMaxWidth()
                        )
                        Button(
                            onClick = {
                                val from = if (anonymous) "Anonymous" else name.ifBlank { "Unnamed" }
                                val body = "Type: ${kind.label}\nFrom: $from\n\n$message"
                                IntentHelpers.openEmailDraft(
                                    context,
                                    profile.email,
                                    "${kind.label} from the crew",
                                    body
                                )
                            },
                            enabled = message.isNotBlank() && profile.email.isNotBlank(),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(if (profile.email.isBlank()) "Set a business email in Settings first" else "Send to the Office")
                        }
                        Text(
                            "This opens your email app with the message ready -- you tap send yourself. " +
                                if (anonymous) "Heads up: your email address will still be visible to whoever receives it, since it's sent from your own email app." else "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

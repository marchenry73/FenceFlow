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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.Row
import com.fenceestimator.app.R
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.ui.components.IntentHelpers
import com.fenceestimator.app.ui.components.currentApp

private enum class FeedbackKind(val labelRes: Int) {
    SUGGESTION(R.string.misc_feedback_kind_suggestion),
    COMPLAINT(R.string.misc_feedback_kind_complaint),
    SAFETY(R.string.misc_feedback_kind_safety)
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
                title = { Text(stringResource(R.string.misc_feedback_title)) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back)) } }
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
                            stringResource(R.string.misc_feedback_intro),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FeedbackKind.values().forEach { k ->
                                FilterChip(selected = kind == k, onClick = { kind = k }, label = { Text(stringResource(k.labelRes)) })
                            }
                        }
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(stringResource(R.string.misc_feedback_send_anonymously), Modifier.weight(1f))
                            Switch(checked = anonymous, onCheckedChange = { anonymous = it })
                        }
                        if (!anonymous) {
                            OutlinedTextField(
                                value = name, onValueChange = { name = it },
                                label = { Text(stringResource(R.string.misc_feedback_your_name)) }, modifier = Modifier.fillMaxWidth()
                            )
                        }
                        OutlinedTextField(
                            value = message, onValueChange = { message = it },
                            label = { Text(stringResource(R.string.misc_feedback_message_label)) },
                            minLines = 6, modifier = Modifier.fillMaxWidth()
                        )
                        Button(
                            onClick = {
                                val kindLabel = context.getString(kind.labelRes)
                                val from = if (anonymous) context.getString(R.string.misc_feedback_anonymous)
                                else name.ifBlank { context.getString(R.string.misc_feedback_unnamed) }
                                val body = context.getString(R.string.misc_feedback_type_line, kindLabel) + "\n" +
                                    context.getString(R.string.misc_feedback_from_line, from) + "\n\n" + message
                                IntentHelpers.openEmailDraft(
                                    context,
                                    profile.email,
                                    context.getString(R.string.misc_feedback_subject, kindLabel),
                                    body
                                )
                            },
                            enabled = message.isNotBlank() && profile.email.isNotBlank(),
                            modifier = Modifier.fillMaxWidth()
                        ) {
                            Text(stringResource(if (profile.email.isBlank()) R.string.misc_feedback_set_email_first else R.string.misc_feedback_send_to_office))
                        }
                        Text(
                            stringResource(R.string.misc_feedback_opens_email) + " " +
                                if (anonymous) stringResource(R.string.misc_feedback_anon_heads_up) else "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

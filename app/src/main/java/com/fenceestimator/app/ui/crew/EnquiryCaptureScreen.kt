package com.fenceestimator.app.ui.crew

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AddAPhoto
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.CloudOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.fenceestimator.app.R
import com.fenceestimator.app.data.EnquiryCapture
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.PhotoFiles
import com.fenceestimator.app.ui.components.currentApp
import com.fenceestimator.app.ui.components.labelRes
import com.fenceestimator.app.ui.components.resolve
import com.fenceestimator.app.ui.theme.Space
import kotlinx.coroutines.launch
import java.io.File
import java.text.DateFormat
import java.util.Date

/**
 * The route for [EnquiryCaptureScreen]. Kept here rather than in Routes so the
 * whole feature is one folder; the navigation graph names it once.
 */
const val ENQUIRY_CAPTURE_ROUTE = "capture_enquiry"

/**
 * Capture an enquiry: a neighbour asks about a fence while a crew member is on
 * a job, and the crew member takes it down. It goes to the office, who price it.
 *
 * Built for somebody standing in a garden with one hand free: three required
 * fields, chips instead of menus, big buttons, a camera one tap away. What they
 * type survives the camera app evicting this one from memory (the form is
 * saved state), and saving is instant and local -- the send happens after, and
 * its progress is the list's own status line, never a spinner they must wait on.
 *
 * NO MONEY, anywhere on this screen. No field asks for a price, no figure is
 * shown, and nothing here reads the lead back after it is sent -- the screen
 * only ever shows this phone's own copy. There is also no delete: a crew member
 * can correct a capture the office does not have yet, and that is all.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun EnquiryCaptureScreen(onBack: () -> Unit) {
    val app = currentApp()
    val context = LocalContext.current
    val viewModel: EnquiryCaptureViewModel = viewModel(
        factory = GenericViewModelFactory { EnquiryCaptureViewModel(app.repository, app.session, app.applicationContext) }
    )
    val rows by viewModel.rows.collectAsState()
    val online by app.connectivity.online.collectAsState()
    val waiting by EnquiryOutboxRunner.waiting.collectAsState()
    val message by viewModel.message.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    val messageText = message?.resolve()
    LaunchedEffect(message) {
        messageText?.let {
            snackbarHostState.showSnackbar(it)
            viewModel.consumeMessage()
        }
    }
    // Found out as the screen opens, and again when signal returns -- so a
    // signed-out phone says so before anything is typed.
    LaunchedEffect(online) {
        viewModel.checkSignIn()
        if (online) viewModel.send()
    }

    // The form. Saved state, so the camera app evicting this process, a call
    // coming in, or a rotation does not lose what was typed.
    var name by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var address by rememberSaveable { mutableStateOf("") }
    var fence by rememberSaveable { mutableStateOf("") }
    var feet by rememberSaveable { mutableStateOf("") }
    var notes by rememberSaveable { mutableStateOf("") }
    // Photo paths joined by newline: a plain String survives being saved where
    // a List<String> is a gamble on its concrete class.
    var photosJoined by rememberSaveable { mutableStateOf("") }
    var pendingPhoto by rememberSaveable { mutableStateOf("") }
    var editingId by rememberSaveable { mutableStateOf<Long?>(null) }
    var triedToSave by rememberSaveable { mutableStateOf(false) }
    var confirmLeave by rememberSaveable { mutableStateOf(false) }

    val photoPaths = photosJoined.split("\n").filter { it.isNotBlank() }
    val editingRow = rows.firstOrNull { it.capture.id == editingId }
    val alreadySaved = editingRow?.photos?.size ?: 0
    val photoRoom = (EnquiryCapture.MAX_PHOTOS - alreadySaved - photoPaths.size).coerceAtLeast(0)

    val draft = EnquiryDraft(name, phone, email, address, fence, feet, notes)
    val problems = draft.problems()
    val dirty = listOf(name, phone, email, address, feet, notes, photosJoined).any { it.isNotBlank() }

    fun clearForm() {
        name = ""; phone = ""; email = ""; address = ""; fence = ""; feet = ""; notes = ""
        photosJoined = ""; pendingPhoto = ""; editingId = null; triedToSave = false
    }

    val cameraLauncher = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { success ->
        if (success && pendingPhoto.isNotBlank()) {
            photosJoined = (photoPaths + pendingPhoto).joinToString("\n")
        }
        pendingPhoto = ""
    }

    // Leaving with something typed asks first; leaving an empty form does not.
    BackHandler(enabled = dirty) { confirmLeave = true }

    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val dateFormat = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.enq_title)) },
                navigationIcon = {
                    IconButton(onClick = { if (dirty) confirmLeave = true else onBack() }) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                }
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
        // Pinned, so the one thing every capture ends with is under the thumb
        // however far down the form or the list has been scrolled.
        bottomBar = {
            Surface(tonalElevation = 3.dp) {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = Space.screen, vertical = Space.sm),
                    verticalArrangement = Arrangement.spacedBy(Space.xs)
                ) {
                    Button(
                        onClick = {
                            triedToSave = true
                            if (problems.isEmpty()) {
                                viewModel.save(draft, photoPaths, editingId) {
                                    clearForm()
                                    scope.launch { listState.animateScrollToItem(0) }
                                }
                            } else {
                                // The fields are red, but the first of them may be
                                // off screen from here; say so where the thumb is.
                                scope.launch { snackbarHostState.showSnackbar(context.getString(R.string.enq_err_check)) }
                            }
                        },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
                    ) {
                        Text(stringResource(if (editingId == null) R.string.enq_save else R.string.enq_save_changes))
                    }
                    if (editingId != null) {
                        TextButton(onClick = { clearForm() }, modifier = Modifier.fillMaxWidth()) {
                            Text(stringResource(R.string.enq_cancel_edit))
                        }
                    }
                }
            }
        }
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(Space.screen),
            verticalArrangement = Arrangement.spacedBy(Space.row)
        ) {
            item {
                Text(
                    stringResource(R.string.enq_intro),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Why nothing is going up right now, said before anything is typed.
            val note = when {
                waiting == EnquiryWait.SIGNED_OUT -> R.string.enq_note_signed_out
                waiting == EnquiryWait.NOT_READY -> R.string.enq_note_not_ready
                !online || waiting == EnquiryWait.NO_SIGNAL -> R.string.enq_note_offline
                waiting == EnquiryWait.LIMIT -> R.string.enq_note_limit
                waiting == EnquiryWait.FAILED -> R.string.enq_note_failed
                else -> null
            }
            if (note != null) {
                item {
                    Card(
                        Modifier.fillMaxWidth(),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer)
                    ) {
                        Row(
                            Modifier.padding(Space.card),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Space.md)
                        ) {
                            Icon(Icons.Filled.CloudOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
                            Text(
                                stringResource(note),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSecondaryContainer
                            )
                        }
                    }
                }
            }

            if (editingId != null) {
                item {
                    Text(
                        stringResource(R.string.enq_editing),
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.Bold,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
            }

            item {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.enq_field_name)) },
                    singleLine = true,
                    isError = triedToSave && EnquiryProblem.NAME in problems,
                    supportingText = if (triedToSave && EnquiryProblem.NAME in problems) {
                        { Text(stringResource(R.string.enq_err_name)) }
                    } else null,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
                    modifier = Modifier.fillMaxWidth()
                )
            }
            item {
                OutlinedTextField(
                    value = phone,
                    onValueChange = { phone = it },
                    label = { Text(stringResource(R.string.enq_field_phone)) },
                    singleLine = true,
                    isError = triedToSave && EnquiryProblem.CONTACT in problems,
                    supportingText = if (triedToSave && EnquiryProblem.CONTACT in problems) {
                        { Text(stringResource(R.string.enq_err_contact)) }
                    } else null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                    modifier = Modifier.fillMaxWidth()
                )
            }
            item {
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text(stringResource(R.string.enq_field_email)) },
                    singleLine = true,
                    isError = triedToSave && EnquiryProblem.EMAIL in problems,
                    supportingText = if (triedToSave && EnquiryProblem.EMAIL in problems) {
                        { Text(stringResource(R.string.enq_err_email)) }
                    } else null,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                    modifier = Modifier.fillMaxWidth()
                )
            }
            item {
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it },
                    label = { Text(stringResource(R.string.enq_field_address)) },
                    minLines = 2,
                    isError = triedToSave && EnquiryProblem.ADDRESS in problems,
                    supportingText = if (triedToSave && EnquiryProblem.ADDRESS in problems) {
                        { Text(stringResource(R.string.enq_err_address)) }
                    } else null,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
                    modifier = Modifier.fillMaxWidth()
                )
            }

            item {
                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Text(stringResource(R.string.enq_field_fence), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    Text(
                        stringResource(R.string.enq_fence_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(Space.sm),
                        verticalArrangement = Arrangement.spacedBy(Space.sm)
                    ) {
                        ENQUIRY_FENCE_CHOICES.forEach { type ->
                            FilterChip(
                                selected = fence == type.name,
                                onClick = { fence = if (fence == type.name) "" else type.name },
                                label = { Text(stringResource(type.labelRes())) },
                                modifier = Modifier.heightIn(min = 48.dp)
                            )
                        }
                    }
                }
            }
            item {
                OutlinedTextField(
                    value = feet,
                    onValueChange = { feet = it.filter { c -> c.isDigit() }.take(5) },
                    label = { Text(stringResource(R.string.enq_field_feet)) },
                    supportingText = {
                        Text(
                            if (triedToSave && EnquiryProblem.FEET in problems) stringResource(R.string.enq_err_feet)
                            else stringResource(R.string.enq_field_feet_hint)
                        )
                    },
                    singleLine = true,
                    isError = triedToSave && EnquiryProblem.FEET in problems,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth()
                )
            }
            item {
                OutlinedTextField(
                    value = notes,
                    onValueChange = { notes = it },
                    label = { Text(stringResource(R.string.enq_field_notes)) },
                    placeholder = { Text(stringResource(R.string.enq_notes_hint)) },
                    minLines = 3,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.fillMaxWidth()
                )
            }

            item {
                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Text(stringResource(R.string.enq_photos_title), style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                    if (alreadySaved > 0) {
                        Text(
                            stringResource(R.string.enq_photos_saved),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                            editingRow?.photos?.forEachIndexed { i, p ->
                                AsyncImage(
                                    model = File(p.filePath),
                                    contentDescription = stringResource(R.string.enq_photo_desc, i + 1),
                                    contentScale = ContentScale.Crop,
                                    modifier = Modifier.size(72.dp)
                                )
                            }
                        }
                    }
                    if (photoPaths.isNotEmpty()) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                            photoPaths.forEachIndexed { i, path ->
                                AsyncImage(
                                    model = File(path),
                                    contentDescription = stringResource(R.string.enq_photo_desc, alreadySaved + i + 1),
                                    contentScale = ContentScale.Crop,
                                    modifier = Modifier.size(72.dp)
                                )
                            }
                        }
                    }
                    Text(
                        stringResource(R.string.enq_photo_count, alreadySaved + photoPaths.size, EnquiryCapture.MAX_PHOTOS),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedButton(
                        onClick = {
                            if (photoRoom == 0) {
                                scope.launch { snackbarHostState.showSnackbar(context.getString(R.string.enq_photo_limit)) }
                            } else {
                                val target = PhotoFiles.newTarget(context, "photos/enquiry")
                                pendingPhoto = target.absolutePath
                                cameraLauncher.launch(target.uri)
                            }
                        },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)
                    ) {
                        Icon(Icons.Filled.AddAPhoto, contentDescription = null)
                        Text(stringResource(R.string.enq_photo_add), modifier = Modifier.padding(start = Space.sm))
                    }
                }
            }

            item {
                Text(
                    stringResource(R.string.enq_list_title),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(top = Space.md)
                )
            }
            if (rows.isEmpty()) {
                item {
                    Text(
                        stringResource(R.string.enq_list_empty),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            items(rows, key = { it.capture.id }) { row ->
                EnquiryRowCard(
                    row = row,
                    capturedAt = dateFormat.format(Date(row.capture.capturedAt)),
                    onCorrect = {
                        val c = row.capture
                        name = c.customerName; phone = c.phone; email = c.email; address = c.address
                        fence = c.fenceType; feet = c.approxFeet?.toString().orEmpty(); notes = c.notes
                        photosJoined = ""; pendingPhoto = ""; triedToSave = false
                        editingId = c.id
                        scope.launch { listState.animateScrollToItem(0) }
                    },
                    onSendAgain = { viewModel.sendAgain(row.capture.id) }
                )
            }
        }
    }

    if (confirmLeave) {
        AlertDialog(
            onDismissRequest = { confirmLeave = false },
            title = { Text(stringResource(R.string.enq_discard_title)) },
            text = { Text(stringResource(R.string.enq_discard_body)) },
            confirmButton = {
                TextButton(onClick = { confirmLeave = false; clearForm(); onBack() }) {
                    Text(stringResource(R.string.enq_discard_yes))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmLeave = false }) { Text(stringResource(R.string.enq_discard_keep)) }
            }
        )
    }
}

/**
 * One capture, as this phone knows it. Name, place, when, and where it stands --
 * and nothing else about it: the phone never asks what the office did with it.
 */
@Composable
private fun EnquiryRowCard(
    row: EnquiryRow,
    capturedAt: String,
    onCorrect: () -> Unit,
    onSendAgain: () -> Unit
) {
    val c = row.capture
    Card(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp)) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.xs)) {
            Text(c.customerName, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
            Text(c.address, style = MaterialTheme.typography.bodyMedium)
            Text(
                stringResource(R.string.enq_captured_at, capturedAt),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            val status = when (row.status) {
                EnquiryStatus.WAITING -> stringResource(R.string.enq_status_waiting)
                EnquiryStatus.SENT -> stringResource(R.string.enq_status_sent)
                EnquiryStatus.SENT_PHOTOS_OWED -> stringResource(R.string.enq_status_sent_photos, row.photosOwed)
                EnquiryStatus.REJECTED -> stringResource(R.string.enq_status_rejected)
            }
            Text(
                status,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Bold,
                color = if (row.status == EnquiryStatus.REJECTED) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.primary
            )
            if (row.status == EnquiryStatus.REJECTED) {
                Text(
                    stringResource(
                        if (c.rejectedWhy == EnquiryRefusal.NOT_ALLOWED.name) R.string.enq_reject_not_allowed
                        else R.string.enq_reject_invalid
                    ),
                    style = MaterialTheme.typography.bodySmall
                )
            }
            if (row.status == EnquiryStatus.SENT || row.status == EnquiryStatus.SENT_PHOTOS_OWED) {
                Text(
                    stringResource(R.string.enq_sent_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(Space.sm)) {
                if (row.canCorrect) {
                    OutlinedButton(onClick = onCorrect, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(stringResource(R.string.enq_edit))
                    }
                }
                if (row.status == EnquiryStatus.REJECTED) {
                    Button(onClick = onSendAgain, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(stringResource(R.string.enq_send_again))
                    }
                }
            }
        }
    }
}

/**
 * The way in, for the crew home: shown only to someone who holds the
 * permission and cannot already create jobs (see
 * [EnquiryCaptureAccess.mayCapture]) -- anyone else gets nothing, not a
 * disabled button. Also what keeps a capture from being forgotten: every time
 * it is shown, and every time signal returns while it is, it runs a pass of the
 * send queue, and it says how many are still waiting.
 */
@Composable
fun EnquiryEntryCard(onOpen: () -> Unit, modifier: Modifier = Modifier) {
    val app = currentApp()
    val session by app.session.state.collectAsState()
    if (!EnquiryCaptureAccess.mayCapture(session)) return
    val online by app.connectivity.online.collectAsState()
    val company = session.companyId.orEmpty()
    val waitingCount by remember(company) { app.repository.observeEnquiriesWaiting(company) }.collectAsState(initial = 0)
    val appContext = LocalContext.current.applicationContext
    LaunchedEffect(online, session.companyId) {
        EnquiryOutboxRunner.flush(app.repository, app.session, appContext)
    }
    Card(modifier.fillMaxWidth(), shape = RoundedCornerShape(20.dp)) {
        Column(Modifier.padding(Space.card), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            Text(stringResource(R.string.enq_entry_title), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            Text(
                stringResource(R.string.enq_entry_body),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (waitingCount > 0) {
                Text(
                    if (waitingCount == 1) stringResource(R.string.enq_entry_waiting_one)
                    else stringResource(R.string.enq_entry_waiting_many, waitingCount),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.primary
                )
            }
            Button(onClick = onOpen, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Text(stringResource(R.string.enq_entry_button))
            }
        }
    }
}

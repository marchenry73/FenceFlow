package com.fenceestimator.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Payments
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.fenceestimator.app.R
import com.fenceestimator.app.data.PaymentOption
import com.fenceestimator.app.data.PaymentMethodRules
import com.fenceestimator.app.data.PaymentMethods
import com.fenceestimator.app.data.PaymentMethodsError
import com.fenceestimator.app.data.PaymentMethodsForm
import com.fenceestimator.app.data.PublicPaymentMethods
import com.fenceestimator.app.ui.components.GenericViewModelFactory
import com.fenceestimator.app.ui.components.currentApp

/**
 * "How customers can pay you", on the phone.
 *
 * The office has had this panel since 1 October; this is the same panel, the
 * same storage and the same rules, for the half of the day he spends in the
 * yard. Nothing here is a second home for the fact: it reads and writes
 * `company_settings.settings -> 'payment_methods'` through
 * `save_company_settings()`, which is what website/dashboard.html does.
 *
 * WHAT A WRONG ENTRY COSTS, AND WHAT IS HONEST ABOUT IT.  A mistyped Cash App
 * tag or Zelle number sends his customer's deposit to a stranger, and there is
 * no way to get it back. Nothing here can check that a handle exists -- no API
 * is asked, and pretending to have verified one would be the dangerous part. So
 * the honest design is: refuse what is obviously not a handle, never silently
 * repair or shorten what is, show him the result EXACTLY as the customer will
 * read it, and make him confirm that before anything is written.
 *
 * THE LIMIT IS HIS TO TYPE AND IT IS HERS, NOT HIS.  A personal Zelle or Cash
 * App caps what can be sent in one go, the cap is set by the SENDING bank, and
 * it changes. No number is supplied, suggested or defaulted here. Blank is the
 * default and blank shows nothing at all.
 */
@Composable
fun PaymentMethodsCard(editable: Boolean) {
    val app = currentApp()
    val session by app.session.state.collectAsState()
    val viewModel: PaymentMethodsViewModel = viewModel(
        factory = GenericViewModelFactory {
            PaymentMethodsViewModel(app.settingsStore, app.applicationScope)
        }
    )

    // The money shield, by its name. company_settings carries a RESTRICTIVE
    // select policy that hands no row to anybody without SEE_MONEY or the
    // OWNER/MANAGER role, so a crew phone gets nothing to draw -- this keeps
    // the app from offering a screen the database would refuse, rather than
    // being the thing that protects a bank account. Neither capability is new:
    // SEE_MONEY is the one the server names, EDIT_CATALOG_AND_SETTINGS is the
    // one the rest of company settings already asks for.
    if (!session.canSeeMoney || !session.canEditCatalogAndSettings) return

    val companyId = session.companyId
    val stored by viewModel.methods.collectAsState()
    val storedLimits by viewModel.limits.collectAsState()
    val status by viewModel.status.collectAsState()
    val loadedOk by viewModel.editable.collectAsState()

    LaunchedEffect(companyId) { viewModel.load(companyId) }

    // The edit buffer is seeded from what was actually read, never from a
    // placeholder -- the same rule SettingsScreen follows for the profile. A
    // form seeded before the read lands is a form whose Save writes blanks.
    var form by remember(stored, storedLimits) {
        mutableStateOf(PaymentMethodRules.toForm(stored, storedLimits))
    }
    var confirming by rememberSaveable { mutableStateOf(false) }

    // A guest demo, or a session that has never managed a server read, may look
    // and may not write. Writable is both: the demo predicate the rest of the
    // screen uses, AND a read having genuinely succeeded.
    val writable = editable && loadedOk

    SectionCard(
        title = stringResource(R.string.pm_title),
        subtitle = summaryLine(stored),
        icon = Icons.Filled.Payments
    ) {
        Text(
            stringResource(R.string.pm_explain),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

        StatusLine(status, loadedOk) { viewModel.flushPending(companyId) }

        if (!loadedOk) {
            // A failed or not-yet-made read must NOT leave an editable form:
            // pressing Save on it would write blanks over the real details, and
            // on a phone it would queue those blanks to be sent later. This is
            // the office's own refused case (loadPaymentMethods locks the form)
            // and the phone's version of it has to be stricter, not looser.
            return@SectionCard
        }

        MethodRow(
            label = stringResource(R.string.pm_cashapp_label),
            hint = stringResource(R.string.pm_cashapp_hint),
            on = form.cashAppOn,
            onToggle = { form = form.copy(cashAppOn = it) },
            value = form.cashAppTag,
            onValue = { form = form.copy(cashAppTag = it) },
            limit = form.cashAppLimit,
            onLimit = { form = form.copy(cashAppLimit = it) },
            enabled = writable
        )
        MethodRow(
            label = stringResource(R.string.pm_zelle_label),
            hint = stringResource(R.string.pm_zelle_hint),
            on = form.zelleOn,
            onToggle = { form = form.copy(zelleOn = it) },
            value = form.zelleTo,
            onValue = { form = form.copy(zelleTo = it) },
            limit = form.zelleLimit,
            onLimit = { form = form.copy(zelleLimit = it) },
            enabled = writable
        )
        MethodRow(
            label = stringResource(R.string.pm_wire_label),
            hint = stringResource(R.string.pm_wire_hint),
            on = form.wireOn,
            onToggle = { form = form.copy(wireOn = it) },
            value = form.wireDetails,
            onValue = { form = form.copy(wireDetails = it) },
            limit = form.wireLimit,
            onLimit = { form = form.copy(wireLimit = it) },
            enabled = writable,
            multiline = true
        )
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Switch(
                checked = form.cashOn,
                onCheckedChange = { form = form.copy(cashOn = it) },
                enabled = writable
            )
            Text(
                stringResource(R.string.pm_cash_label),
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.padding(start = 12.dp)
            )
        }

        // What the limit does, and does not do, today. Saying nothing here
        // would let him type a limit and believe his customer is being warned
        // about it, which she is not: quote-view sends four whitelisted keys
        // and `payment_limits` is not one of them yet.
        Text(
            stringResource(R.string.pm_limit_not_shown_yet),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )

        if (writable) {
            Button(
                onClick = { confirming = true },
                modifier = Modifier.fillMaxWidth()
            ) { Text(stringResource(R.string.pm_review_and_save)) }
        }
    }

    if (confirming) {
        ConfirmDialog(
            form = form,
            viewModel = viewModel,
            onDismiss = { confirming = false },
            onConfirm = {
                confirming = false
                viewModel.save(companyId, form)
            }
        )
    }
}

/**
 * The confirm step. He is shown THE CUSTOMER'S VIEW -- built by the same rules
 * quote-view uses -- not the boxes he typed into, because the two are not the
 * same thing: a switched-off method with a tag still in it shows nothing, a
 * Cash App tag gains its `$`, and a Zelle address has its spacing collapsed.
 * Seeing the boxes back would hide exactly the mistakes that cost money.
 */
@Composable
private fun ConfirmDialog(
    form: PaymentMethodsForm,
    viewModel: PaymentMethodsViewModel,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit
) {
    val refusal = remember(form) { viewModel.check(form) }
    val built = remember(form) { viewModel.preview(form).getOrNull() }
    val preview = built?.first
    val limits = built?.second

    if (refusal != null) {
        AlertDialog(
            onDismissRequest = onDismiss,
            title = { Text(stringResource(R.string.pm_refused_title)) },
            text = { Text(refusalText(refusal.reason, refusal.which)) },
            confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.pm_go_back)) } }
        )
        return
    }

    val view = preview ?: PublicPaymentMethods()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.pm_confirm_title)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    stringResource(R.string.pm_confirm_explain),
                    style = MaterialTheme.typography.bodyMedium
                )
                if (view.isEmpty) {
                    // His own rule, honoured: an empty method is not shown to
                    // the customer at all, and when every method is empty the
                    // whole How-to-pay panel is absent from her page.
                    Text(
                        stringResource(R.string.pm_confirm_nothing),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error
                    )
                } else {
                    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
                        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (view.cashApp.isNotEmpty()) {
                                CustomerLine(stringResource(R.string.pm_cashapp_label), view.cashApp, limits?.cashApp)
                            }
                            if (view.zelle.isNotEmpty()) {
                                CustomerLine(stringResource(R.string.pm_zelle_label), view.zelle, limits?.zelle)
                            }
                            if (view.wire.isNotEmpty()) {
                                CustomerLine(stringResource(R.string.pm_wire_label), view.wire, limits?.wire)
                            }
                            if (view.cash) {
                                CustomerLine(stringResource(R.string.pm_cash_label), "", null)
                            }
                        }
                    }
                    // The limit lines are drawn INSIDE a card headed "this is
                    // what the customer will see", and today she does not see
                    // them: quote-view selects settings->payment_methods only
                    // and its response type carries four fields, none of them a
                    // limit. Leaving the sentence unqualified here would have
                    // him read the preview and believe she is being warned
                    // about a cap she will never be shown. The same note the
                    // card carries, repeated where the claim is made, and no
                    // new string -- it is already in all three languages.
                    if (limits?.let { it.cashApp.isNotEmpty() || it.zelle.isNotEmpty() || it.wire.isNotEmpty() } == true) {
                        Text(
                            stringResource(R.string.pm_limit_not_shown_yet),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error
                        )
                    }
                    Text(
                        stringResource(R.string.pm_confirm_warning),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error
                    )
                }
            }
        },
        confirmButton = { Button(onClick = onConfirm) { Text(stringResource(R.string.pm_confirm_save)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.pm_go_back)) } }
    )
}

/**
 * One line of the customer's view. The value is drawn in a monospaced face and
 * never shortened: a handle he cannot read character by character is a handle
 * he cannot check, and an ellipsis in the middle of an account number hides
 * the digits that matter.
 */
@Composable
private fun CustomerLine(label: String, value: String, limit: String?) {
    Column {
        Text(label, style = MaterialTheme.typography.labelLarge)
        if (value.isNotEmpty()) {
            Text(
                value,
                style = MaterialTheme.typography.bodyMedium,
                fontFamily = FontFamily.Monospace
            )
        }
        // Blank limit, nothing said. No number is invented, and the sentence
        // names whose limit it is -- hers, at her bank, not his.
        if (!limit.isNullOrEmpty()) {
            Text(
                stringResource(R.string.pm_limit_line, limit),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun MethodRow(
    label: String,
    hint: String,
    on: Boolean,
    onToggle: (Boolean) -> Unit,
    value: String,
    onValue: (String) -> Unit,
    limit: String,
    onLimit: (String) -> Unit,
    enabled: Boolean,
    multiline: Boolean = false
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Switch(checked = on, onCheckedChange = onToggle, enabled = enabled)
            Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(start = 12.dp))
        }
        OutlinedTextField(
            value = value,
            onValueChange = onValue,
            label = { Text(hint) },
            enabled = enabled,
            singleLine = !multiline,
            minLines = if (multiline) 3 else 1,
            modifier = Modifier.fillMaxWidth()
        )
        OutlinedTextField(
            value = limit,
            onValueChange = onLimit,
            label = { Text(stringResource(R.string.pm_limit_hint)) },
            supportingText = { Text(stringResource(R.string.pm_limit_support)) },
            enabled = enabled,
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
            modifier = Modifier.fillMaxWidth()
        )
    }
}

@Composable
private fun StatusLine(
    status: PaymentMethodsViewModel.Status,
    loadedOk: Boolean,
    onRetry: () -> Unit
) {
    val text = when (status) {
        is PaymentMethodsViewModel.Status.Unknown ->
            if (loadedOk) null else stringResource(R.string.pm_never_loaded)
        is PaymentMethodsViewModel.Status.Loaded -> null
        is PaymentMethodsViewModel.Status.Offline -> stringResource(R.string.pm_offline_copy)
        is PaymentMethodsViewModel.Status.Pending -> stringResource(R.string.pm_pending)
        is PaymentMethodsViewModel.Status.Saved -> stringResource(R.string.pm_saved)
        is PaymentMethodsViewModel.Status.VerifyFailed -> stringResource(R.string.pm_verify_failed)
        is PaymentMethodsViewModel.Status.ServerRefused -> stringResource(R.string.pm_server_refused)
        is PaymentMethodsViewModel.Status.Refused -> refusalText(status.rejection.reason, status.rejection.which)
    } ?: return

    val bad = status is PaymentMethodsViewModel.Status.VerifyFailed ||
        status is PaymentMethodsViewModel.Status.ServerRefused ||
        status is PaymentMethodsViewModel.Status.Refused ||
        status is PaymentMethodsViewModel.Status.Unknown
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        textAlign = TextAlign.Start,
        color = if (bad) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
    )
    if (status is PaymentMethodsViewModel.Status.Pending) {
        TextButton(onClick = onRetry) { Text(stringResource(R.string.pm_send_now)) }
    }
}

@Composable
private fun refusalText(reason: PaymentMethodsError, which: PaymentOption?): String = when (reason) {
    PaymentMethodsError.CASH_APP_BAD -> stringResource(R.string.pm_err_cashapp)
    PaymentMethodsError.ZELLE_BAD -> stringResource(R.string.pm_err_zelle)
    PaymentMethodsError.ZELLE_LONG -> stringResource(R.string.pm_err_zelle_long, PaymentMethodRules.MAX_ZELLE_CHARS)
    PaymentMethodsError.WIRE_LONG -> stringResource(R.string.pm_err_wire_long, PaymentMethodRules.MAX_WIRE_CHARS)
    PaymentMethodsError.ON_BUT_EMPTY -> stringResource(R.string.pm_err_on_but_empty, methodName(which))
    PaymentMethodsError.LIMIT_BAD -> stringResource(R.string.pm_err_limit, methodName(which))
}

@Composable
private fun methodName(which: PaymentOption?): String = when (which) {
    PaymentOption.CASH_APP -> stringResource(R.string.pm_cashapp_label)
    PaymentOption.ZELLE -> stringResource(R.string.pm_zelle_label)
    PaymentOption.WIRE -> stringResource(R.string.pm_wire_label)
    PaymentOption.CASH, null -> stringResource(R.string.pm_cash_label)
}

/**
 * The card's subtitle: which methods a customer would actually be shown.
 *
 * The four labels are resolved BEFORE the list is joined. A stringResource call
 * inside joinToString's lambda is a composable call in a non-composable lambda,
 * which does not compile -- and resolving them up front keeps the order of the
 * labels fixed rather than depending on iteration.
 */
@Composable
private fun summaryLine(methods: PaymentMethods): String {
    val cashApp = stringResource(R.string.pm_cashapp_label)
    val zelle = stringResource(R.string.pm_zelle_label)
    val wire = stringResource(R.string.pm_wire_label)
    val cash = stringResource(R.string.pm_cash_label)
    val none = stringResource(R.string.pm_summary_none)
    val live = PaymentMethodRules.liveMethods(methods)
    if (live.isEmpty()) return none
    val names = live.map {
        when (it) {
            PaymentOption.CASH_APP -> cashApp
            PaymentOption.ZELLE -> zelle
            PaymentOption.WIRE -> wire
            PaymentOption.CASH -> cash
        }
    }
    return stringResource(R.string.pm_summary_on, names.joinToString(", "))
}

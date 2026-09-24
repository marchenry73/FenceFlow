package com.fenceestimator.app.ui.onboarding

import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.ClaimOutcome
import com.fenceestimator.app.cloud.ServiceGate
import com.fenceestimator.app.cloud.ServiceStatus
import kotlinx.coroutines.launch

/**
 * Shown when a company's access has genuinely ended.
 *
 * Written for the person holding the phone, who is usually not the person who
 * pays. A crew member seeing this has done nothing wrong and can do nothing
 * about it, so the screen tells them what happened, that their work is safe,
 * and who to ask -- rather than presenting a wall.
 *
 * Their data is deliberately NOT deleted and not hidden from the company that
 * owns it. Access ending is a billing state, not a reason to destroy somebody's
 * records; everything is still there the moment it is sorted out.
 */
@Composable
fun ServiceBlockedScreen(
    status: ServiceStatus,
    /** True while an answer is being fetched. */
    checking: Boolean = false,
    /** True when the last attempt never reached the server. */
    couldNotCheck: Boolean = false,
    /** True while signing out, which involves the network and is not instant. */
    signingOut: Boolean = false,
    /**
     * The company is fine; this LOGIN was taken by another phone (one login,
     * one phone at a time -- device_still_mine said no). A different screen
     * with a different way out: see [SignedInElsewhere].
     */
    displaced: Boolean = false,
    /** True while "Use this phone" is talking to the server. */
    reclaiming: Boolean = false,
    /** True when the last "Use this phone" never got through. */
    reclaimFailed: Boolean = false,
    onUseThisPhone: () -> Unit = {},
    onRetry: () -> Unit,
    onSignOut: () -> Unit
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    // A company that has never subscribed is not a company that has been cut
    // off, and telling somebody who just created their business that FenceFlow
    // "is paused" is a dead end: no explanation they can act on, and only
    // Check again and Sign out to choose between. That was the first thing a
    // new customer saw after signing up on the phone.
    //
    // Subscribing stays on the website deliberately -- selling it inside the
    // app would put it through Play billing and its cut -- so the honest move
    // is to say so and open the page.
    val neverSubscribed = status.subscriptionStatus.isBlank() ||
        status.subscriptionStatus in setOf("pending", "none")

    // What Sign out from here would actually throw away.
    //
    // This screen's sign-out used to skip straight to a forced wipe -- the
    // gate above already blocks syncing, so the reasoning was that waiting
    // for signal could never help anyway. True right up until somebody hits
    // this screen holding a signature or photos taken with no signal that
    // never got a chance to go up before their access was cut off. Checked
    // locally so the warning below is accurate on its own, independent of
    // whatever onSignOut itself ends up doing with force.
    var unsynced by remember { mutableStateOf<com.fenceestimator.app.data.UnsyncedSummary?>(null) }
    // Whether the check itself came back at all. It used to be folded into
    // unsynced via getOrNull(), so a thrown exception looked identical to "an
    // empty phone" -- the one case where the warning is least sure there is
    // nothing to lose is the case it silently skipped showing one. A failed
    // check now counts as "assume there is work to lose", not "assume there
    // is none".
    var checkFailed by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        val app = context.applicationContext as? com.fenceestimator.app.FenceEstimatorApp
        val result = app?.let { runCatching { it.repository.unsyncedSummary() } }
        if (result == null || result.isFailure) {
            checkFailed = true
        } else {
            unsynced = result.getOrNull()
        }
    }
    val holdsUnsyncedWork = checkFailed || unsynced?.isEmpty == false
    // The first tap only warns. Signing out -- and losing whatever is
    // counted above -- takes a second, deliberate tap once that warning is
    // on screen, the same "are you sure" shape as any other destructive
    // confirmation in this app.
    var confirmingLoss by remember { mutableStateOf(false) }

    // Scrollable, and that is not a detail.
    //
    // This screen grew: a heading, three paragraphs, a status line and three
    // buttons. A Column that does not scroll still LAYS OUT everything past
    // the bottom of the screen -- it is drawn, but it sits outside the
    // parent's bounds, and anything outside those bounds cannot be touched.
    // So the buttons at the end looked present and did nothing when pressed,
    // including Sign out, which is the one way off a screen somebody is stuck
    // on. Reported as "it won't let me click", which is exactly right.
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        if (displaced) {
            SignedInElsewhere(
                reclaiming = reclaiming,
                reclaimFailed = reclaimFailed,
                signingOut = signingOut,
                onUseThisPhone = onUseThisPhone,
                onRetry = onRetry
            )
        } else {
        Text(
            stringResource(
                if (neverSubscribed) R.string.onb_trial_title else R.string.onb_paused_title
            ),
            style = MaterialTheme.typography.headlineSmall,
            fontWeight = FontWeight.Bold
        )
        Text(
            if (neverSubscribed) stringResource(R.string.onb_trial_explain)
            else status.reason.ifBlank { stringResource(R.string.onb_paused_default_reason) },
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        if (!neverSubscribed) {
            Text(
                stringResource(R.string.onb_paused_nothing_lost),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Text(
            stringResource(
                if (neverSubscribed) R.string.onb_trial_where else R.string.onb_paused_crew_note
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        // What the last check actually did.
        //
        // Check again re-asked, got no answer, and changed nothing on screen --
        // which is indistinguishable from a button that does not work, and is
        // what somebody sitting on this screen reports. It says so now.
        if (checking) {
            Text(
                stringResource(R.string.onb_checking),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        } else if (couldNotCheck) {
            Text(
                stringResource(R.string.onb_check_failed),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error
            )
        }

        Button(
            onClick = {
                runCatching {
                    context.startActivity(
                        android.content.Intent(
                            android.content.Intent.ACTION_VIEW,
                            android.net.Uri.parse(BILLING_URL)
                        )
                    )
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                stringResource(
                    if (neverSubscribed) R.string.onb_trial_open else R.string.onb_paused_open_billing
                )
            )
        }
        OutlinedButton(
            onClick = onRetry,
            enabled = !checking,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(stringResource(if (checking) R.string.onb_checking else R.string.onb_check_again))
        }
        }
        // Told before it is lost, not after -- shown as soon as the first tap
        // asks for it, so the button's changed label ("Sign out anyway and
        // lose it") is not the first anyone hears of what it now means.
        if (holdsUnsyncedWork && confirmingLoss) {
            // Two different warnings, because only one of them has a count to
            // give. Inventing a number for the checkFailed case would be a
            // fake confidence the screen does not have.
            val blockedShifts = unsynced?.blockedTimeEntries ?: 0
            val warning = if (checkFailed) stringResource(R.string.onb_sign_out_could_not_check_warning)
            else stringResource(
                R.string.onb_sign_out_unsynced_warning,
                unsynced?.jobs ?: 0,
                unsynced?.files ?: 0
            )
            Text(
                if (blockedShifts > 0) {
                    warning + "\n\n" + stringResource(R.string.sync_blocked_shifts_sign_out_note, blockedShifts)
                } else warning,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error
            )
        }
        // Signing out talks to the server before it takes effect, so it is not
        // instant -- and with no sign of that, a second or two of nothing reads
        // as a button that does not work. It says what it is doing.
        OutlinedButton(
            onClick = {
                if (holdsUnsyncedWork && !confirmingLoss) {
                    // First tap: ask, don't act. The actual sign-out below is
                    // unchanged by this -- it is whatever onSignOut already
                    // does -- but nobody reaches it without seeing this first.
                    confirmingLoss = true
                } else {
                    onSignOut()
                }
            },
            enabled = !signingOut,
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                stringResource(
                    when {
                        signingOut -> R.string.onb_signing_out
                        confirmingLoss -> R.string.onb_sign_out_anyway
                        else -> R.string.onb_sign_out
                    }
                )
            )
        }
    }
}

/**
 * The top of the screen when the company is fine and only this LOGIN has moved
 * to another phone.
 *
 * It used to be the paused screen with the reason swapped in: the title came
 * from the subscription status alone, so an active company read "FenceFlow is
 * paused", told crew "this is one for the office" and offered Open billing --
 * while the manager app worked perfectly, because the only thing that had
 * happened was the crew login being signed in on a third handset. None of
 * that was true or useful. This says what happened, that one login works on
 * one phone at a time, and offers the one thing that fixes it from here: take
 * the login back (ServiceGate.reclaim -- the same claim a fresh sign-in makes,
 * so no seat is gained), or sign out below.
 *
 * A company can turn on requiring a device key for a second phone
 * (supabase_r8_device_keys.sql, require_device_key) -- an OWNER is never
 * asked, but anyone else taking the login from an existing holder is, unless
 * they have a code the office read out. [ServiceGate.lastClaimOutcome] is
 * how this screen learns that happened: [ServiceGate.reclaim] now reports it
 * there instead of throwing the server's answer away, and this reveals a key
 * field only once that answer says one is actually wanted -- never as a
 * standing option, or someone with a plain connectivity problem would be
 * sent hunting for a code that was never the issue. Submitting a key calls
 * [ServiceGate.reclaim] directly (the same function "Use this phone" calls
 * through [onUseThisPhone]) because that is the one place that can carry the
 * typed value to claim_device's second argument and read back which of the
 * two refusals it was.
 */
@Composable
private fun SignedInElsewhere(
    reclaiming: Boolean,
    reclaimFailed: Boolean,
    signingOut: Boolean,
    onUseThisPhone: () -> Unit,
    onRetry: () -> Unit
) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val lastOutcome by ServiceGate.lastClaimOutcome.collectAsState()
    // Sticky, not just "the latest answer was one of the two hints" -- so a
    // plain connectivity hiccup on the SUBMIT tap itself (attemptClaim reads
    // that as Failed, same as any other network failure) does not yank the
    // field away mid-retry and throw out the code someone just typed. Once
    // the server has asked for a key this screen instance keeps asking,
    // until a claim actually succeeds and the whole block above takes this
    // screen off entirely.
    var keyEverWanted by remember { mutableStateOf(false) }
    LaunchedEffect(lastOutcome) {
        if (lastOutcome == ClaimOutcome.KeyRequired || lastOutcome == ClaimOutcome.KeyInvalid) {
            keyEverWanted = true
        }
    }
    val keyWanted = keyEverWanted

    Text(
        stringResource(R.string.svc_elsewhere_title),
        style = MaterialTheme.typography.headlineSmall,
        fontWeight = FontWeight.Bold
    )
    Text(
        stringResource(R.string.svc_elsewhere_body),
        style = MaterialTheme.typography.bodyLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    Text(
        stringResource(R.string.svc_elsewhere_nothing_lost),
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    Text(
        stringResource(R.string.svc_elsewhere_seat_note),
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
    // What the tap actually did, for the same reason Check again says so: a
    // button that changes nothing on screen reads as a broken button. A
    // refusal that named a device key gets its own wording below instead of
    // this generic one -- reusing "couldn't reach FenceFlow" for a refusal
    // the server explained would send someone off checking their signal for
    // a problem that was never about their signal.
    if (reclaiming) {
        Text(
            stringResource(R.string.svc_use_this_phone_working),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    } else if (reclaimFailed && !keyWanted) {
        Text(
            stringResource(R.string.svc_use_this_phone_failed),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.error
        )
    }
    Button(
        onClick = onUseThisPhone,
        enabled = !reclaiming && !signingOut,
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(
            stringResource(
                if (reclaiming) R.string.svc_use_this_phone_working else R.string.svc_use_this_phone
            )
        )
    }

    if (keyWanted) {
        var keyCode by remember { mutableStateOf("") }
        var submitting by remember { mutableStateOf(false) }
        // The generic failure line above is suppressed while a key is wanted,
        // and reclaimFailed is the PARENT's state, which this screen's own
        // direct reclaim never sets. So a submit that simply did not land --
        // typed in a dead spot -- changed nothing on screen at all: the button
        // flickered and came back, and the obvious reading is that the code is
        // wrong. It is the same failure this file already warns about twenty
        // lines up.
        var submitFailed by remember { mutableStateOf(false) }
        Text(
            stringResource(
                if (lastOutcome == ClaimOutcome.KeyInvalid) R.string.svc_device_key_invalid
                else R.string.svc_device_key_required
            ),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        OutlinedTextField(
            value = keyCode,
            onValueChange = { keyCode = it },
            label = { Text(stringResource(R.string.svc_device_key_label)) },
            singleLine = true,
            enabled = !submitting && !reclaiming && !signingOut,
            modifier = Modifier.fillMaxWidth()
        )
        Button(
            onClick = {
                submitting = true
                submitFailed = false
                scope.launch {
                    // applicationContext, not the Activity context read above,
                    // because this write outlives the composition: the claim can
                    // still be in flight when the screen goes away, and a
                    // coroutine holding an Activity is a coroutine holding a
                    // window. The DataStore itself is indifferent -- the
                    // preferencesDataStore delegate resolves through
                    // applicationContext whichever Context it is handed.
                    //
                    // The same call "Use this phone" makes, this time carrying
                    // what was typed -- claim_device's own second argument.
                    val claimed = ServiceGate.reclaim(context.applicationContext, keyCode)
                    submitting = false
                    // A rejected KEY re-renders the wording above by itself, off
                    // lastOutcome. This covers the other way it can fail: the
                    // call never reached the server.
                    submitFailed = !claimed &&
                        ServiceGate.lastClaimOutcome.value is ClaimOutcome.Failed
                    // A successful claim already updated DISPLACED locally;
                    // asking the parent to recheck is what actually takes this
                    // screen off -- ServiceGate.stillMine reads the same
                    // active_device_id this claim just set, on the next check
                    // that recheck causes, rather than this screen assuming.
                    if (claimed) onRetry()
                }
            },
            enabled = !submitting && !reclaiming && !signingOut && keyCode.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) {
            Text(
                stringResource(
                    if (submitting) R.string.svc_device_key_submitting else R.string.svc_device_key_submit
                )
            )
        }
        if (submitFailed) {
            Text(
                stringResource(R.string.svc_use_this_phone_failed),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error
            )
        }
    }
}

/** Where a plan is chosen. Web only, so Play billing never applies. */
private const val BILLING_URL = "https://fenceflowapp.com/dashboard.html"

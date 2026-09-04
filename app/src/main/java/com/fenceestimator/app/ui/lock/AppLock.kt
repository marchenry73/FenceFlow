package com.fenceestimator.app.ui.lock

import android.os.Build
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.fenceestimator.app.R
import com.fenceestimator.app.ui.theme.Space

/**
 * Tracks how long the app has been idle and reports whether it should be locked.
 *
 * Kept out of any ViewModel on purpose: the clock has to survive screen changes
 * and configuration changes, and locking is an app-wide concern rather than
 * something owned by one screen.
 */
object IdleTimer {
    private var lastInteraction: Long = System.currentTimeMillis()

    fun touch() {
        lastInteraction = System.currentTimeMillis()
    }

    /** True when [timeoutMinutes] have passed with no interaction. 0 disables locking. */
    fun isExpired(timeoutMinutes: Int): Boolean {
        if (timeoutMinutes <= 0) return false
        val elapsedMinutes = (System.currentTimeMillis() - lastInteraction) / 60_000.0
        return elapsedMinutes >= timeoutMinutes
    }

    fun reset() = touch()
}

/** Whether this device can actually do biometrics, so the setting can be hidden if not. */
fun biometricAvailable(context: android.content.Context): Boolean {
    val manager = BiometricManager.from(context)
    return manager.canAuthenticate(
        BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
    ) == BiometricManager.BIOMETRIC_SUCCESS
}

/**
 * Full-screen lock. Offers biometrics when enabled and available, and always
 * falls back to the device PIN/pattern -- a fingerprint that stops working
 * must never lock someone out of their own job list mid-install.
 */
@Composable
fun LockScreen(useBiometric: Boolean, onUnlocked: () -> Unit) {
    val context = LocalContext.current
    val activity = context.findFragmentActivity()
    // Captured in composable scope: prompt() is a plain function, so it cannot
    // call stringResource itself.
    val promptTitle = stringResource(R.string.onb_unlock_prompt_title)
    val promptSubtitle = stringResource(R.string.onb_unlock_prompt_subtitle)
    val notRecognizedMessage = stringResource(R.string.lock_auth_not_recognized)
    // Only onAuthenticationSucceeded used to be handled, so a cancelled prompt
    // or a hardware error (a cold finger, a sensor locked out from too many
    // tries) left this screen exactly as it was -- nothing said what happened,
    // and nothing pointed at the button that tries again. It read as frozen.
    var errorMessage by remember { mutableStateOf<String?>(null) }

    fun prompt() {
        errorMessage = null
        if (activity == null) {
            // No FragmentActivity to host the prompt: better to let the user in
            // than to trap them behind a dialog that can never appear.
            onUnlocked()
            return
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(promptTitle)
            .setSubtitle(promptSubtitle)
            .setAllowedAuthenticators(
                BiometricManager.Authenticators.BIOMETRIC_WEAK or
                    BiometricManager.Authenticators.DEVICE_CREDENTIAL
            )
            .build()

        BiometricPrompt(
            activity,
            ContextCompat.getMainExecutor(context),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    IdleTimer.reset()
                    errorMessage = null
                    onUnlocked()
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    errorMessage = errString.toString()
                }

                override fun onAuthenticationFailed() {
                    errorMessage = notRecognizedMessage
                }
            }
        ).authenticate(info)
    }

    LaunchedEffect(useBiometric) {
        if (useBiometric && biometricAvailable(context)) prompt()
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(14.dp),
                modifier = Modifier.padding(Space.xxl)
            ) {
                Icon(
                    Icons.Filled.Lock,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary
                )
                Text(stringResource(R.string.onb_locked_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(
                    stringResource(R.string.onb_locked_body),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                errorMessage?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
                Button(onClick = { prompt() }, modifier = Modifier.fillMaxWidth()) {
                    Text(if (useBiometric) stringResource(R.string.onb_unlock) else stringResource(R.string.onb_unlock_with_screen_lock))
                }
            }
        }
    }
}

internal fun android.content.Context.findFragmentActivity(): FragmentActivity? {
    var ctx = this
    while (ctx is android.content.ContextWrapper) {
        if (ctx is FragmentActivity) return ctx
        ctx = ctx.baseContext
    }
    return null
}

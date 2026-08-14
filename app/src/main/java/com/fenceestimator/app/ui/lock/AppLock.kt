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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

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

    fun prompt() {
        if (activity == null) {
            // No FragmentActivity to host the prompt: better to let the user in
            // than to trap them behind a dialog that can never appear.
            onUnlocked()
            return
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock FenceFlow")
            .setSubtitle("Your session timed out")
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
                    onUnlocked()
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
                modifier = Modifier.padding(32.dp)
            ) {
                Icon(
                    Icons.Filled.Lock,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary
                )
                Text("FenceFlow is locked", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(
                    "Your session timed out for security.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Button(onClick = { prompt() }, modifier = Modifier.fillMaxWidth()) {
                    Text(if (useBiometric) "Unlock" else "Unlock with screen lock")
                }
            }
        }
    }
}

private fun android.content.Context.findFragmentActivity(): FragmentActivity? {
    var ctx = this
    while (ctx is android.content.ContextWrapper) {
        if (ctx is FragmentActivity) return ctx
        ctx = ctx.baseContext
    }
    return null
}

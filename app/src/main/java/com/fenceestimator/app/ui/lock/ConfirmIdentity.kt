package com.fenceestimator.app.ui.lock

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

/**
 * Makes someone prove who they are before a change that is hard to undo.
 *
 * Used for changing another person's access. That action is not ordinary
 * editing: it is the one that can hand somebody the ability to see the money,
 * delete signed records, or grant themselves anything else. An unlocked phone
 * left on a truck seat should not be enough.
 *
 * Deliberately the device's own credential rather than a passcode invented by
 * this app. A separate PIN is one more thing to forget, one more thing written
 * on the inside of a toolbox lid, and it proves less -- the device credential
 * is already the thing that says this is the owner's phone and the owner is
 * holding it. Biometric where available, device PIN or pattern otherwise, so a
 * fingerprint that stops working in the cold never locks an owner out of
 * running their own company.
 *
 * If no credential is set on the device at all, the change proceeds. Refusing
 * would strand someone who has no screen lock, and the honest position is that
 * the app cannot add security a device does not have.
 */
fun confirmIdentity(
    context: android.content.Context,
    title: String,
    subtitle: String,
    onConfirmed: () -> Unit,
    onCancelled: () -> Unit = {}
) {
    val activity = context.findFragmentActivity()
    val canPrompt = BiometricManager.from(context).canAuthenticate(
        BiometricManager.Authenticators.BIOMETRIC_WEAK or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
    ) == BiometricManager.BIOMETRIC_SUCCESS

    if (activity == null || !canPrompt) {
        onConfirmed()
        return
    }

    val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title)
        .setSubtitle(subtitle)
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
                onConfirmed()
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                onCancelled()
            }
        }
    ).authenticate(info)
}

package com.fenceestimator.app.ui.components

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource

/**
 * A message chosen by non-composable code (a ViewModel, a sync pass) but
 * worded by resources, so the screen that shows it renders it in the user's
 * language. Server-provided text (an exception message, a reason from the
 * backend) stays dynamic: it travels in [args] and is formatted into a
 * generic key rather than being baked into English at the point of failure.
 */
data class UiMessage(
    @StringRes val textRes: Int,
    val args: List<Any> = emptyList()
)

@Composable
fun UiMessage.resolve(): String = stringResource(textRes, *args.toTypedArray())

/**
 * A failure whose wording the app owns. Thrown by code with no Context so the
 * screen can still show the message in the user's language instead of the
 * English an ordinary exception would carry.
 */
class UiMessageException(val ui: UiMessage) : Exception()

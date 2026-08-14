package com.fenceestimator.app.ui.components

import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType

/**
 * A text field whose displayed value is a local draft, seeded once from
 * [initialValue] and never re-synced from upstream while [stableKey] stays
 * the same. Edits are pushed out one-way via [onValueChange].
 *
 * Binding a TextField directly to state that round-trips through an async
 * DB/Flow write (as this app's job/run screens do on every keystroke) resets
 * the cursor mid-type once the write lands and the Flow re-emits -- the next
 * character then lands in the wrong place. Keying the local draft on a
 * stable identity (e.g. the job/run id) instead of the live value avoids
 * that: the draft only resets when you switch to editing a different
 * record, never on your own keystrokes.
 */
@Composable
fun DraftTextField(
    stableKey: Any,
    initialValue: String,
    label: String,
    modifier: Modifier = Modifier,
    keyboardType: KeyboardType = KeyboardType.Text,
    minLines: Int = 1,
    enabled: Boolean = true,
    onValueChange: (String) -> Unit
) {
    var text by remember(stableKey) { mutableStateOf(initialValue) }
    OutlinedTextField(
        value = text,
        onValueChange = { newText ->
            text = newText
            onValueChange(newText)
        },
        label = { Text(label) },
        modifier = modifier,
        minLines = minLines,
        enabled = enabled,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType)
    )
}

/** Same fix as [DraftTextField], for numeric (Float-backed) inputs. */
@Composable
fun DraftNumberField(
    stableKey: Any,
    initialValue: Float,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onValueChange: (Float) -> Unit
) {
    var text by remember(stableKey) { mutableStateOf(formatFloat(initialValue)) }
    OutlinedTextField(
        value = text,
        onValueChange = { newText ->
            text = newText
            newText.toFloatOrNull()?.let(onValueChange)
        },
        label = { Text(label) },
        enabled = enabled,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = modifier
    )
}

private fun formatFloat(value: Float): String =
    if (value % 1f == 0f) value.toInt().toString() else value.toString()

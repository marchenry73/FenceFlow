package com.fenceestimator.app.ui.components

import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.text.input.KeyboardType

/**
 * A text field whose displayed value is a local draft, seeded from
 * [initialValue] and pushed out one-way via [onValueChange].
 *
 * Binding a TextField straight to state that round-trips through an async
 * DB/Flow write (as this app's job/run screens do on every keystroke) resets
 * the cursor mid-type once the write lands and the Flow re-emits -- the next
 * character then goes in the wrong place. So the draft is kept local and only
 * reseeded when [stableKey] changes, i.e. when you move to a different record.
 *
 * That alone was too strict, though: a value changed by anything *other* than
 * typing -- the Request Payment button filling in a link, a pricing tier
 * rewriting a rate, a sync pulling an edit made on another phone -- left the
 * box showing the old number forever, so the change looked like it had failed
 * when it had actually saved.
 *
 * So an upstream value is adopted, but only while the field is unfocused.
 * Focus is what separates the two cases: nobody is mid-word in a box they
 * aren't in. Adopting whenever the value merely differed was not enough --
 * each keystroke writes asynchronously, and a late echo of an earlier
 * keystroke would arrive looking exactly like an outside edit and rewind the
 * field under the user's fingers.
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
    var lastPushed by remember(stableKey) { mutableStateOf(initialValue) }
    var focused by remember(stableKey) { mutableStateOf(false) }

    LaunchedEffect(stableKey, initialValue, focused) {
        if (!focused && initialValue != lastPushed) {
            text = initialValue
            lastPushed = initialValue
        }
    }

    OutlinedTextField(
        value = text,
        onValueChange = { newText ->
            text = newText
            lastPushed = newText
            onValueChange(newText)
        },
        label = { Text(label) },
        modifier = modifier.onFocusChanged { focused = it.isFocused },
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
    // Compared as a number, not as text: "1.50" and "1.5" are the same value,
    // and treating them as different would fight the user mid-decimal.
    var lastPushed by remember(stableKey) { mutableStateOf(initialValue) }
    var focused by remember(stableKey) { mutableStateOf(false) }

    LaunchedEffect(stableKey, initialValue, focused) {
        if (!focused && initialValue != lastPushed) {
            text = formatFloat(initialValue)
            lastPushed = initialValue
        }
    }

    OutlinedTextField(
        value = text,
        onValueChange = { raw ->
            // A Spanish or French keyboard offers a comma as the decimal mark.
            // toFloatOrNull only reads a dot, so "8,5" parsed as nothing and
            // the field looked like it accepted the number but never saved it.
            val newText = raw.replace(',', '.')
            text = newText
            // Clearing the field means zero. It used to mean "keep whatever
            // was there" -- a markup wiped out to leave it at nothing quietly
            // stayed at 15%, and the blank box said otherwise.
            val parsed = if (newText.isBlank()) 0f else newText.toFloatOrNull()
            parsed?.let {
                lastPushed = it
                onValueChange(it)
            }
        },
        label = { Text(label) },
        enabled = enabled,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        modifier = modifier.onFocusChanged { focused = it.isFocused }
    )
}

private fun formatFloat(value: Float): String =
    if (value % 1f == 0f) value.toInt().toString() else value.toString()

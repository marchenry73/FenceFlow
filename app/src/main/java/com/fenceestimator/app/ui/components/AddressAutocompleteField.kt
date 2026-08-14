package com.fenceestimator.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.Divider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.fenceestimator.app.data.AddressSearch
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * A text field that suggests matching addresses as you type, using a free
 * OpenStreetMap search (no API key). Debounces network calls and only fires
 * once you've paused typing for a moment.
 */
@Composable
fun AddressAutocompleteField(
    stableKey: Any,
    initialValue: String,
    label: String = "Property address",
    modifier: Modifier = Modifier,
    onValueChange: (String) -> Unit
) {
    var text by remember(stableKey) { mutableStateOf(initialValue) }
    var suggestions by remember(stableKey) { mutableStateOf<List<String>>(emptyList()) }
    var showSuggestions by remember(stableKey) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(modifier = modifier) {
        OutlinedTextField(
            value = text,
            onValueChange = { newText ->
                text = newText
                onValueChange(newText)
                showSuggestions = true
                val query = newText
                scope.launch {
                    delay(450)
                    if (text == query) suggestions = AddressSearch.search(query)
                }
            },
            label = { Text(label) },
            modifier = Modifier.fillMaxWidth()
        )
        if (showSuggestions && suggestions.isNotEmpty()) {
            Card(modifier = Modifier.fillMaxWidth().padding(top = 4.dp)) {
                Column {
                    suggestions.forEachIndexed { index, suggestion ->
                        if (index > 0) Divider()
                        Text(
                            suggestion,
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    text = suggestion
                                    onValueChange(suggestion)
                                    showSuggestions = false
                                    suggestions = emptyList()
                                }
                                .padding(12.dp)
                        )
                    }
                }
            }
        }
    }
}

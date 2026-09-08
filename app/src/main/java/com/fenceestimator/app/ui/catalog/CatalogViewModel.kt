package com.fenceestimator.app.ui.catalog

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.R
import com.fenceestimator.app.data.Manufacturer
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.estimate.ImportMatch
import com.fenceestimator.app.estimate.InvoiceParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class CatalogViewModel(private val repository: Repository) : ViewModel() {
    val catalog: StateFlow<List<MaterialItem>> = repository.observeFullCatalog()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val manufacturers: StateFlow<List<Manufacturer>> = repository.observeManufacturers()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _importMatches = MutableStateFlow<List<ImportMatch>>(emptyList())
    val importMatches: StateFlow<List<ImportMatch>> = _importMatches

    private val _importError = MutableStateFlow<String?>(null)
    val importError: StateFlow<String?> = _importError

    private val _isImporting = MutableStateFlow(false)
    val isImporting: StateFlow<Boolean> = _isImporting

    fun saveItem(item: MaterialItem) {
        viewModelScope.launch {
            if (item.id == 0L) repository.saveMaterialItem(item) else repository.updateMaterialItem(item)
        }
    }

    fun deleteItem(item: MaterialItem) {
        viewModelScope.launch { repository.deleteMaterialItem(item) }
    }

    fun importPdf(context: Context, uri: Uri) {
        viewModelScope.launch {
            _isImporting.value = true
            _importError.value = null
            try {
                val text = withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(uri)?.use { InvoiceParser.extractText(it) }
                        ?: throw IllegalStateException("Could not open file")
                }
                val parsed = InvoiceParser.parseLineItems(text)
                if (parsed.isEmpty()) {
                    _importError.value = context.getString(R.string.cat_import_no_items)
                }
                _importMatches.value = InvoiceParser.matchAgainstCatalog(parsed, catalog.value)
            } catch (e: Exception) {
                // Never the library's own words.
                //
                // This printed the raw exception -- a stack-trace sentence
                // about streams and parsers -- to somebody holding a supplier
                // invoice. What they need to know is whether it is worth
                // trying another file, and that the manual path still exists.
                android.util.Log.w("CatalogImport", "PDF import failed", e)
                _importError.value = context.getString(R.string.cat_import_failed)
            } finally {
                _isImporting.value = false
            }
        }
    }

    fun clearImport() {
        _importMatches.value = emptyList()
        _importError.value = null
    }

    fun applyImportSelections(selected: List<ImportMatch>) {
        viewModelScope.launch {
            selected.forEach { match ->
                val existing = match.existingMatch
                if (existing != null) {
                    repository.updateMaterialItem(existing.copy(unitPrice = match.parsed.rate))
                } else {
                    repository.saveMaterialItem(
                        MaterialItem(
                            category = com.fenceestimator.app.data.MaterialCategory.MISC,
                            name = match.parsed.rawDescription.take(120),
                            unitPrice = match.parsed.rate,
                            taxable = match.parsed.taxable,
                            sourceDoc = "Imported"
                        )
                    )
                }
            }
            clearImport()
        }
    }
}

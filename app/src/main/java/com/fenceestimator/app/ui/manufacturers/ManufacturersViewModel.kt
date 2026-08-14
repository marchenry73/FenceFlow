package com.fenceestimator.app.ui.manufacturers

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.Manufacturer
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class ManufacturersViewModel(private val repository: Repository) : ViewModel() {
    val manufacturers: StateFlow<List<Manufacturer>> = repository.observeManufacturers()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun save(manufacturer: Manufacturer) {
        viewModelScope.launch { repository.saveManufacturer(manufacturer) }
    }

    fun delete(manufacturer: Manufacturer) {
        viewModelScope.launch { repository.deleteManufacturer(manufacturer) }
    }
}

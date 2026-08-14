package com.fenceestimator.app.ui.schedule

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

class ScheduleViewModel(repository: Repository) : ViewModel() {
    val scheduledJobs: StateFlow<List<Job>> = repository.observeJobs()
        .map { jobs -> jobs.filter { it.scheduledDate != null }.sortedBy { it.scheduledDate } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())
}

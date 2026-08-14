package com.fenceestimator.app.ui.components

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import com.fenceestimator.app.FenceEstimatorApp

class GenericViewModelFactory(private val creator: () -> ViewModel) : ViewModelProvider.Factory {
    @Suppress("UNCHECKED_CAST")
    override fun <T : ViewModel> create(modelClass: Class<T>): T = creator() as T
}

@Composable
fun currentApp(): FenceEstimatorApp {
    val context = LocalContext.current.applicationContext
    return context as FenceEstimatorApp
}

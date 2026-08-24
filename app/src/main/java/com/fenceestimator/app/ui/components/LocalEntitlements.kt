package com.fenceestimator.app.ui.components

import androidx.compose.runtime.compositionLocalOf
import com.fenceestimator.app.cloud.Entitlements

/**
 * What the company's plan includes, available to every screen.
 *
 * Defaults to full access: a phone that has never been told its plan (offline
 * first launch, hand-granted company) behaves like the app always has. The
 * server still enforces the boundaries that matter -- this only shapes what
 * is shown.
 */
val LocalEntitlements = compositionLocalOf { Entitlements.FULL }

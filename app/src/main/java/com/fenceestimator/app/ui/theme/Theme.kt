package com.fenceestimator.app.ui.theme

import android.app.Activity
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.ui.unit.dp
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val LightColors = lightColorScheme(
    primary = Graphite40,
    onPrimary = Color.White,
    primaryContainer = Graphite90,
    onPrimaryContainer = Graphite20,
    secondary = SafetyOrange40,
    onSecondary = Color.White,
    secondaryContainer = SafetyOrange80,
    onSecondaryContainer = SafetyOrange20,
    tertiary = SteelTeal40,
    onTertiary = Color.White,
    tertiaryContainer = SteelTeal80,
    onTertiaryContainer = SteelTeal20,
    background = Neutral98,
    onBackground = Neutral10,
    surface = Color.White,
    onSurface = Neutral10,
    surfaceVariant = Neutral95,
    onSurfaceVariant = Neutral30,
    error = ErrorRed,
)

private val DarkColors = darkColorScheme(
    primary = Graphite80,
    onPrimary = Graphite20,
    primaryContainer = Graphite40,
    onPrimaryContainer = Graphite90,
    secondary = SafetyOrange80,
    onSecondary = SafetyOrange20,
    secondaryContainer = SafetyOrange40,
    onSecondaryContainer = SafetyOrange80,
    tertiary = SteelTeal80,
    onTertiary = SteelTeal20,
    tertiaryContainer = SteelTeal40,
    onTertiaryContainer = SteelTeal80,
    background = Graphite10,
    onBackground = Neutral95,
    surface = Graphite20,
    onSurface = Neutral95,
    surfaceVariant = Neutral30,
    onSurfaceVariant = Neutral95,
    error = ErrorRed,
)

/**
 * One scale of corners for the whole app.
 *
 * Thirteen different radii were in use, six of them on one report screen,
 * because every card chose its own. Material's components read these five
 * -- cards take medium, text fields extraSmall, dialogs extraLarge -- so
 * setting them here straightens most of the app without touching a screen,
 * and [Radius] gives hand-drawn surfaces the same numbers to reach for.
 */
val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(Radius.sm),
    medium = RoundedCornerShape(Radius.md),
    large = RoundedCornerShape(Radius.lg),
    extraLarge = RoundedCornerShape(Radius.xl),
)

@Composable
fun FenceEstimatorTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    dynamicColor: Boolean = false,
    content: @Composable () -> Unit
) {
    val colorScheme = when {
        dynamicColor && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
            val context = LocalContext.current
            if (darkTheme) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
        }
        darkTheme -> DarkColors
        else -> LightColors
    }

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.primary.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = AppTypography,
        shapes = AppShapes,
        content = content
    )
}

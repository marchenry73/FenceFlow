package com.fenceestimator.app.ui.components

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.fenceestimator.app.BuildConfig

/**
 * Paints an unmissable marker over the whole app when this build is pointed at
 * the dev database.
 *
 * The dev app is pixel-identical to the real one. Same icon, same screens, same
 * company name unless you read it closely -- so a phone on the truck seat is
 * one glance away from being trusted with a real customer's deposit, and a
 * quote sent from the wrong build is not a thing you can take back. The cost of
 * being wrong is entirely on one side here, so this is loud on purpose: a red
 * frame around every screen plus a label, drawn over everything, dismissable by
 * nobody.
 *
 * Applied once at the top of the app rather than per screen. A badge you have
 * to remember to add is a badge that is missing from the screen where it
 * mattered.
 *
 * Costs nothing in a production build: [BuildConfig.IS_DEV_BACKEND] is a
 * compile-time constant, so this returns the modifier untouched and the drawing
 * code is removed by the shrinker.
 */
@Composable
fun Modifier.devBackendBadge(): Modifier {
    if (!BuildConfig.IS_DEV_BACKEND) return this

    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    // Sat under the status bar rather than over it: covering the clock and the
    // battery reads as a rendering fault, and a badge that looks like a bug is
    // a badge people learn to ignore.
    val topInset = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()

    val label = "DEV — TEST DATA"
    val style = TextStyle(
        color = Color.White,
        fontSize = 11.sp,
        fontWeight = FontWeight.Bold,
        letterSpacing = 1.sp,
    )

    return this.drawWithContent {
        drawContent()

        val frame = with(density) { 4.dp.toPx() }
        drawRect(
            color = BADGE_RED,
            topLeft = Offset(frame / 2f, frame / 2f),
            size = Size(size.width - frame, size.height - frame),
            style = Stroke(width = frame),
        )

        val laid = measurer.measure(label, style)
        val padH = with(density) { 10.dp.toPx() }
        val padV = with(density) { 4.dp.toPx() }
        val pillWidth = laid.size.width + padH * 2
        val pillHeight = laid.size.height + padV * 2
        val left = (size.width - pillWidth) / 2f
        val top = with(density) { topInset.toPx() } + frame

        drawRoundRect(
            color = BADGE_RED,
            topLeft = Offset(left, top),
            size = Size(pillWidth, pillHeight),
            cornerRadius = CornerRadius(pillHeight / 2f),
        )
        drawText(
            textLayoutResult = laid,
            topLeft = Offset(left + padH, top + padV),
        )
    }
}

private val BADGE_RED = Color(0xFFB3261E)

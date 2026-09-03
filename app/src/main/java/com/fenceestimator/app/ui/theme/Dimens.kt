package com.fenceestimator.app.ui.theme

import androidx.compose.ui.unit.dp

/**
 * The spacing scale.
 *
 * Sixteen distinct paddings were in use across the screens, most of them
 * doing the same job -- the gap between a card and the screen edge, the gap
 * between two rows. A short ladder, and every gap picks a rung, is what
 * makes forty screens feel like one app rather than forty.
 */
object Space {
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val xxl = 32.dp

    /** A screen's inset from the edge of the phone, and a card's inset from its own edge. */
    val screen = 16.dp
    val card = 16.dp
    /** Between two cards or two sections in a column. */
    val section = 12.dp
    /** Between two rows or two fields inside one card. */
    val row = 10.dp
}

/** Corner radii, matched to [AppShapes] so hand-built surfaces agree with Material's. */
object Radius {
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
}

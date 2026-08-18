package com.fenceestimator.app.ui.components

import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.MaterialCategory
import com.fenceestimator.app.data.MaterialRole

/**
 * How enum values are written when a person reads them.
 *
 * The app was calling `name.replace("_", " ")` in thirty-odd places, which
 * produces "CHAIN LINK" and "LINE POST" -- shouting, and inconsistent with
 * every other label on the screen. Worse, some of those strings end up on a
 * customer's quote, where "ORNAMENTAL IRON" reads as a database field that
 * escaped rather than a product being sold.
 *
 * Names are written the way the trade writes them, not the way the enum
 * spells them.
 */

/** "CHAIN_LINK" -> "Chain Link". The fallback when nothing better is defined. */
fun String.toTitleCase(): String =
    split('_').filter { it.isNotEmpty() }.joinToString(" ") { word ->
        word.lowercase().replaceFirstChar { it.uppercase() }
    }

val FenceType.label: String
    get() = when (this) {
        FenceType.VINYL -> "Vinyl"
        FenceType.WOOD -> "Wood"
        FenceType.CHAIN_LINK -> "Chain Link"
        FenceType.ALUMINUM -> "Aluminum"
        FenceType.ORNAMENTAL_IRON -> "Ornamental Iron"
        FenceType.SPLIT_RAIL -> "Split Rail"
        FenceType.COMPOSITE -> "Composite"
        // Parts that fit any fence -- concrete, fasteners, generic hardware.
        // "Universal" alone reads as a brand; this says what it means.
        FenceType.UNIVERSAL -> "Fits Any Fence"
    }

val MaterialCategory.label: String
    get() = when (this) {
        MaterialCategory.PANEL -> "Panels"
        MaterialCategory.POST -> "Posts"
        MaterialCategory.CAP -> "Caps"
        MaterialCategory.CONCRETE -> "Concrete"
        MaterialCategory.HARDWARE -> "Hardware"
        MaterialCategory.GATE -> "Gates"
        MaterialCategory.TRIM -> "Trim"
        MaterialCategory.FABRIC -> "Fabric"
        MaterialCategory.RAIL -> "Rails"
        MaterialCategory.PICKET -> "Pickets"
        MaterialCategory.MISC -> "Other"
    }

val MaterialRole.label: String
    get() = when (this) {
        MaterialRole.LINE_POST -> "Line post"
        MaterialRole.END_POST -> "End post"
        MaterialRole.CORNER_POST -> "Corner post"
        MaterialRole.GATE_POST -> "Gate post"
        MaterialRole.BLANK_POST -> "Blank post"
        MaterialRole.POST_CAP -> "Post cap"
        MaterialRole.CONCRETE_BAG -> "Concrete"
        MaterialRole.HOLE_PLUG -> "Hole plug"
        MaterialRole.GATE_PANEL -> "Gate panel"
        MaterialRole.HINGE_SET -> "Hinges"
        MaterialRole.CHAIN_FABRIC -> "Chain link fabric"
        MaterialRole.TOP_RAIL -> "Top rail"
        MaterialRole.TENSION_WIRE -> "Tension wire"
        MaterialRole.TENSION_BAND -> "Tension band"
        MaterialRole.BRACE_BAND -> "Brace band"
        MaterialRole.RAIL_END -> "Rail end"
        MaterialRole.BARBED_WIRE_ARM -> "Barbed wire arm"
        MaterialRole.PRIVACY_SLAT -> "Privacy slat"
        MaterialRole.WOOD_PICKET -> "Picket"
        MaterialRole.WOOD_RAIL -> "Rail"
        MaterialRole.GATE_FRAME_KIT -> "Gate frame kit"
        MaterialRole.NONE -> "Other"
        // Single words that title-case correctly on their own.
        else -> name.toTitleCase()
    }

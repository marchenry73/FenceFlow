package com.fenceestimator.app.ui.catalog

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.ChangeHistory
import androidx.compose.material.icons.filled.GridOn
import androidx.compose.material.icons.filled.Hardware
import androidx.compose.material.icons.filled.Height
import androidx.compose.material.icons.filled.HorizontalRule
import androidx.compose.material.icons.filled.Inventory2
import androidx.compose.material.icons.filled.LinearScale
import androidx.compose.material.icons.filled.SensorDoor
import androidx.compose.material.icons.filled.ViewColumn
import androidx.compose.material.icons.filled.ViewStream
import androidx.compose.ui.graphics.vector.ImageVector
import com.fenceestimator.app.data.MaterialCategory

/**
 * Simple, original generic icons per material category (Google's Material
 * Symbols set, Apache-2.0) -- not real product photos, since we don't have
 * rights to reproduce manufacturer imagery. Good enough to give the catalog
 * visual shorthand without a copyright question.
 */
fun categoryIcon(category: MaterialCategory): ImageVector = when (category) {
    MaterialCategory.PANEL -> Icons.Filled.ViewColumn
    MaterialCategory.POST -> Icons.Filled.Height
    MaterialCategory.CAP -> Icons.Filled.ChangeHistory
    MaterialCategory.CONCRETE -> Icons.Filled.Inventory2
    MaterialCategory.HARDWARE -> Icons.Filled.Hardware
    MaterialCategory.GATE -> Icons.Filled.SensorDoor
    MaterialCategory.TRIM -> Icons.Filled.HorizontalRule
    MaterialCategory.FABRIC -> Icons.Filled.GridOn
    MaterialCategory.RAIL -> Icons.Filled.LinearScale
    MaterialCategory.PICKET -> Icons.Filled.ViewStream
    MaterialCategory.MISC -> Icons.Filled.Category
}

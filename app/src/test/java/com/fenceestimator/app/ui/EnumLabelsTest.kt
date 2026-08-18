package com.fenceestimator.app.ui

import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.MaterialCategory
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.ui.components.label
import com.fenceestimator.app.ui.components.toTitleCase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * Enum values were being shown by replacing underscores with spaces, giving
 * "CHAIN LINK" and "ORNAMENTAL IRON". Some of those strings reach a customer's
 * quote, where a shouted database constant reads as a bug rather than a
 * product.
 */
class EnumLabelsTest {

    @Test
    fun `title case handles multi-word constants`() {
        assertEquals("Chain Link", "CHAIN_LINK".toTitleCase())
        assertEquals("Ornamental Iron", "ORNAMENTAL_IRON".toTitleCase())
        assertEquals("Vinyl", "VINYL".toTitleCase())
    }

    @Test
    fun `title case survives odd input rather than crashing`() {
        assertEquals("", "".toTitleCase())
        assertEquals("A", "A".toTitleCase())
        // Doubled and trailing underscores must not produce empty words.
        assertEquals("A B", "A__B_".toTitleCase())
    }

    @Test
    fun `universal says what it means`() {
        // "Universal" on its own reads like a brand of fence.
        assertEquals("Fits Any Fence", FenceType.UNIVERSAL.label)
    }

    @Test
    fun `every fence type has a readable label`() {
        for (type in FenceType.values()) {
            val label = type.label
            assertFalse("$type is still shouting", label == label.uppercase() && label.length > 2)
            assertFalse("$type kept its underscore", label.contains("_"))
        }
    }

    @Test
    fun `every material category has a readable label`() {
        for (category in MaterialCategory.values()) {
            val label = category.label
            assertFalse("$category is still shouting", label == label.uppercase() && label.length > 2)
            assertFalse("$category kept its underscore", label.contains("_"))
        }
    }

    @Test
    fun `every material role has a readable label`() {
        // This one has an else branch, so the risk is a new role slipping
        // through with an underscore still in it.
        for (role in MaterialRole.values()) {
            val label = role.label
            assertFalse("$role kept its underscore", label.contains("_"))
            assertFalse("$role is still shouting", label == label.uppercase() && label.length > 2)
        }
    }

    @Test
    fun `categories read as headings, not as single items`() {
        // These are section headers over a list, so they are plural.
        assertEquals("Posts", MaterialCategory.POST.label)
        assertEquals("Panels", MaterialCategory.PANEL.label)
        assertEquals("Other", MaterialCategory.MISC.label)
    }
}

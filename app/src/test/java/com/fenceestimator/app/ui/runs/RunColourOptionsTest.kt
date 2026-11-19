package com.fenceestimator.app.ui.runs

import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.MaterialCategory
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.MaterialRole
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE COLOUR PICKER'S FACTS, tested on the shape of the owner's real catalog.
 *
 * The case that matters is the one measured in production on 18 Nov 2026: he
 * stocks Tan panels, posts and caps and NO tan corner post or trim, so a tan
 * fence was being quoted -- and would have been ordered -- with white corner
 * posts, silently. The engines now report that after the fact; this is the
 * same fact at the moment of choosing.
 *
 * Every count here is derived from rows built in the test, not from a golden
 * number, so a change in the rule shows up as a changed row rather than a
 * number nobody can re-derive.
 */
class RunColourOptionsTest {

    private var n = 0
    private fun row(
        role: MaterialRole,
        colour: String,
        price: Double = 10.0,
        type: FenceType = FenceType.VINYL,
        active: Boolean = true
    ): MaterialItem {
        n += 1
        return MaterialItem(
            id = n.toLong(),
            syncId = "c$n",
            // The category is not read by the picker -- the rule is about role
            // and colour -- but the entity requires one, so each row carries the
            // category that role really has rather than a single stand-in that
            // would quietly make every row look alike.
            category = when (role) {
                MaterialRole.PANEL, MaterialRole.GATE_PANEL -> MaterialCategory.PANEL
                MaterialRole.CONCRETE_BAG -> MaterialCategory.CONCRETE
                MaterialRole.LATCH, MaterialRole.HINGE_SET, MaterialRole.HANDLE -> MaterialCategory.HARDWARE
                MaterialRole.TRIM -> MaterialCategory.TRIM
                else -> MaterialCategory.POST
            },
            role = role,
            fenceType = type,
            name = "$role $colour",
            unitPrice = price,
            colorOrFinish = colour,
            isActive = active
        )
    }

    /** His vinyl catalog in miniature: Tan in the big parts, White everywhere. */
    private fun ownersCatalog() = listOf(
        row(MaterialRole.PANEL, "White", 54.15),
        row(MaterialRole.PANEL, "Tan", 54.50),
        row(MaterialRole.PANEL, "Gray", 54.50),
        row(MaterialRole.END_POST, "White", 16.56),
        row(MaterialRole.END_POST, "Tan", 21.25),
        row(MaterialRole.LINE_POST, "White", 13.18),
        row(MaterialRole.LINE_POST, "Tan", 17.25),
        row(MaterialRole.POST_CAP, "White", 0.78),
        row(MaterialRole.POST_CAP, "Tan", 1.75),
        // The two that bite: stocked in White only.
        row(MaterialRole.CORNER_POST, "White", 16.56),
        row(MaterialRole.TRIM, "White", 2.00),
        // Colour is not a choice for this one at all.
        row(MaterialRole.CONCRETE_BAG, "", 6.25, type = FenceType.UNIVERSAL)
    )

    @Test
    fun `a colour the catalog cannot fully dress names the parts it is missing`() {
        val tan = RunColourOptions.forFenceType(ownersCatalog(), FenceType.VINYL)
            .first { it.colour == "Tan" }

        assertEquals(
            "Tan should be missing exactly the two roles stocked only in White",
            listOf(MaterialRole.CORNER_POST, MaterialRole.TRIM),
            tan.missingRoles
        )
        assertFalse("Tan cannot dress the whole fence and must not claim to", tan.coversEverything)
        assertEquals(54.50, tan.panelPrice!!, 0.0001)
    }

    @Test
    fun `the colour that can dress everything says so, and leads the list`() {
        val options = RunColourOptions.forFenceType(ownersCatalog(), FenceType.VINYL)
        val white = options.first { it.colour == "White" }

        assertTrue("White stocks every role that has a colour at all", white.coversEverything)
        assertEquals(emptyList<MaterialRole>(), white.missingRoles)
        assertEquals(
            "the colour that covers most of the fence is offered first",
            "White", options.first().colour
        )
    }

    @Test
    fun `a blank-colour part is nobody's missing part`() {
        // CONCRETE_BAG has no colour, so no colour is "missing" it. Without
        // this, every colour would be reported incomplete for ever and the
        // warning would be worth nothing.
        val options = RunColourOptions.forFenceType(ownersCatalog(), FenceType.VINYL)
        assertTrue(
            "concrete has no colour and must not be reported missing from any of them",
            options.none { MaterialRole.CONCRETE_BAG in it.missingRoles }
        )
        assertTrue(
            "nor should it be counted as covered, or the counts are inflated",
            options.none { MaterialRole.CONCRETE_BAG in it.coveredRoles }
        )
    }

    @Test
    fun `CANARY the missing-roles rule has teeth`() {
        // Add the tan corner post and tan trim the owner is still waiting on a
        // price for. Tan must then cover everything. If this still reports
        // something missing, the rule is counting the wrong thing -- and if the
        // test above still passed with these rows present, it was not measuring.
        val complete = ownersCatalog() +
            row(MaterialRole.CORNER_POST, "Tan", 21.25) +
            row(MaterialRole.TRIM, "Tan", 2.40)
        val tan = RunColourOptions.forFenceType(complete, FenceType.VINYL)
            .first { it.colour == "Tan" }
        assertEquals(emptyList<MaterialRole>(), tan.missingRoles)
        assertTrue(tan.coversEverything)
    }

    @Test
    fun `a colour stocked only in a part that is not a panel still appears, with no price`() {
        // A colour you cannot buy a panel in is not a colour you can build in,
        // and that is worth seeing rather than hiding. Null price, not zero:
        // zero is a price somebody could quote.
        val catalog = ownersCatalog() + row(MaterialRole.LATCH, "Black", 25.87)
        val black = RunColourOptions.forFenceType(catalog, FenceType.VINYL)
            .first { it.colour == "Black" }
        assertNull("no panel in Black, so no panel price", black.panelPrice)
        assertTrue(black.missingRoles.contains(MaterialRole.PANEL))
    }

    @Test
    fun `one paint, one entry, however it was typed`() {
        val catalog = ownersCatalog() + row(MaterialRole.PANEL, "tan", 54.50)
        val options = RunColourOptions.forFenceType(catalog, FenceType.VINYL)
        assertEquals(
            "\"Tan\" and \"tan\" are the same paint and the engines compare ignoring case",
            1, options.count { it.colour.equals("tan", ignoreCase = true) }
        )
    }

    @Test
    fun `matching what somebody typed is forgiving about case and spaces`() {
        val options = RunColourOptions.forFenceType(ownersCatalog(), FenceType.VINYL)
        assertEquals("Tan", RunColourOptions.match(options, "  tan ")?.colour)
        assertNull("a colour the catalog does not stock is not quietly matched",
            RunColourOptions.match(options, "Purple"))
        assertNull("an empty colour matches nothing", RunColourOptions.match(options, "   "))
    }

    @Test
    fun `another fence type's colours are not offered`() {
        val catalog = ownersCatalog() + row(MaterialRole.PANEL, "Cedar", 40.0, type = FenceType.WOOD)
        val vinyl = RunColourOptions.forFenceType(catalog, FenceType.VINYL)
        assertTrue("a wood colour must not be offered for a vinyl run",
            vinyl.none { it.colour == "Cedar" })
        val wood = RunColourOptions.forFenceType(catalog, FenceType.WOOD)
        assertEquals(listOf("Cedar"), wood.map { it.colour })
    }

    @Test
    fun `a retired row offers nothing`() {
        val catalog = ownersCatalog() + row(MaterialRole.PANEL, "Almond", 50.0, active = false)
        assertTrue(
            "an inactive row must not put a colour on the picker he can no longer buy",
            RunColourOptions.forFenceType(catalog, FenceType.VINYL).none { it.colour == "Almond" }
        )
    }

    @Test
    fun `an empty catalog offers nothing rather than pretending`() {
        assertEquals(emptyList<RunColourOptions.Option>(),
            RunColourOptions.forFenceType(emptyList(), FenceType.VINYL))
    }
}

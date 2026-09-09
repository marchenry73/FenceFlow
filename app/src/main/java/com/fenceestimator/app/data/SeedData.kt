package com.fenceestimator.app.data

// Every seeded price is a starting point, and none of them is this company's
// price. Sixteen of them used to ship marked as coming from a real supplier
// quote, which was true only for the company the quote belonged to: for the
// stranger who signs up on Tuesday it is somebody else's negotiated price
// wearing a label that says "verified". Those sixteen therefore passed the
// unverified-price check in silence and could be quoted off untouched.
//
// One label now, because from a new company's chair the distinction does not
// exist -- a genuine quote from a supplier they have never called is exactly
// as unchecked as a market estimate.
//
// PLACEHOLDER stays only so catalogs seeded by older builds keep answering
// the same way. The older "From a real supplier quote" is deliberately NOT
// matched: a company that has since checked those prices should not have them
// re-flagged underneath it.
internal const val SEEDED = "Starting price — verify with your supplier"
internal const val PLACEHOLDER = "Placeholder — verify with your supplier"

/**
 * True for a catalog item still carrying the price FenceFlow shipped rather
 * than one this company checked.
 *
 * Eighty-one of the ninety-one seeded items are typical market rates, not
 * quotes: they exist so a brand-new company has a working estimate on day
 * one, not so anybody sells off them. The label was already on every row --
 * it was simply never shown anywhere a person would look before quoting.
 */
fun isPlaceholderPrice(sourceDoc: String): Boolean =
    sourceDoc == SEEDED || sourceDoc == PLACEHOLDER

/**
 * Starting catalog, so a new company can produce an estimate on its first day
 * instead of facing an empty list. Every price is typical market rate and
 * every one is flagged unverified until this company confirms it -- the
 * estimate screen refuses to send a quote built on prices nobody has checked.
 */
object SeedData {
    fun materialItems(): List<MaterialItem> =
        vinylItems() + woodItems() + chainLinkItems() + aluminumItems() +
            ornamentalIronItems() + splitRailItems() + compositeItems() + universalItems()

    fun pricingTiers(): List<PricingTier> = listOf(
        PricingTier(name = "Residential", laborRatePerFt = 8.0, markupPercent = 15.0, sortOrder = 0),
        PricingTier(name = "Commercial", laborRatePerFt = 10.0, markupPercent = 20.0, sortOrder = 1),
        PricingTier(name = "Family", laborRatePerFt = 8.0, markupPercent = 15.0, discountPercent = 10.0, sortOrder = 2),
        PricingTier(name = "Church / Nonprofit", laborRatePerFt = 8.0, markupPercent = 10.0, discountPercent = 15.0, sortOrder = 3),
        PricingTier(name = "Military / Veteran", laborRatePerFt = 8.0, markupPercent = 15.0, discountPercent = 10.0, sortOrder = 4)
    )

    private fun item(
        category: MaterialCategory,
        role: MaterialRole,
        fenceType: FenceType,
        name: String,
        unit: String = "EA",
        unitPrice: Double,
        taxable: Boolean = true,
        coversFt: Float? = null,
        colorOrFinish: String = "",
        sourceDoc: String
    ) = MaterialItem(
        category = category, role = role, fenceType = fenceType, name = name, unit = unit,
        unitPrice = unitPrice, taxable = taxable, coversFt = coversFt, colorOrFinish = colorOrFinish,
        sourceDoc = sourceDoc
    )

    private fun universalItems(): List<MaterialItem> = listOf(
        item(MaterialCategory.CONCRETE, MaterialRole.CONCRETE_BAG, FenceType.UNIVERSAL, "Concrete Mix 60lb Bag", unitPrice = 4.75, sourceDoc = SEEDED),
        item(MaterialCategory.MISC, MaterialRole.HOLE_PLUG, FenceType.UNIVERSAL, "5/8\" Hole Plug, White", unitPrice = 0.15, colorOrFinish = "White", sourceDoc = SEEDED)
    )

    private fun vinylItems(): List<MaterialItem> {
        val t = FenceType.VINYL
        return listOf(
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Panel T&G Vinyl Privacy 6'H x 6'W - White", unitPrice = 52.35, taxable = false, coversFt = 6f, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Panel T&G Vinyl Privacy 6'H x 8'W - White", unitPrice = 71.40, taxable = true, coversFt = 8f, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "5\"x5\" Co-Ex Line Post, White", unitPrice = 16.56, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "5\"x5\" Co-Ex End Post, White", unitPrice = 16.56, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "5\"x5\" Co-Ex Corner Post, White", unitPrice = 16.56, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "5\"x5\" Co-Ex Gate Post, White", unitPrice = 16.56, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "5\" External Pyramid PVC Post Cap, White", unitPrice = 0.74, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.GATE, MaterialRole.GATE_PANEL, t, "Regular PVC Gate 6'H x 5'W, White", unitPrice = 145.05, taxable = false, coversFt = 5f, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Self-Closing Hinge Set (box, 12 pairs)", unit = "BOX", unitPrice = 32.25, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Two-Way Latch (box of 20)", unit = "BOX", unitPrice = 25.87, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.HANDLE, t, "7\" SS Gate Handle (box of 50)", unit = "BOX", unitPrice = 5.00, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.BRACE, t, "Gate Support Brace, 8'", unitPrice = 6.50, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.STIFFENER, t, "5\" Econo Stiffener x 8'(H)", unitPrice = 52.75, sourceDoc = SEEDED),
            item(MaterialCategory.TRIM, MaterialRole.TRIM, t, "7/8 x 1-1/2 x 62 1/4 Trim U-Channel, White", unitPrice = 2.00, colorOrFinish = "White", sourceDoc = SEEDED),

            // Color variants (placeholder -- correct once you have real supplier pricing per color)
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Panel T&G Vinyl Privacy 6'H x 6'W - Tan", unitPrice = 54.50, taxable = false, coversFt = 6f, colorOrFinish = "Tan", sourceDoc = SEEDED),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Panel T&G Vinyl Privacy 6'H x 6'W - Gray", unitPrice = 54.50, taxable = false, coversFt = 6f, colorOrFinish = "Gray", sourceDoc = SEEDED),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Panel T&G Vinyl Privacy 6'H x 8'W - Tan", unitPrice = 73.90, taxable = true, coversFt = 8f, colorOrFinish = "Tan", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "5\"x5\" Co-Ex Line Post, Tan", unitPrice = 17.25, colorOrFinish = "Tan", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "5\"x5\" Co-Ex Line Post, Gray", unitPrice = 17.25, colorOrFinish = "Gray", sourceDoc = SEEDED)
        )
    }

    private fun woodItems(): List<MaterialItem> {
        val t = FenceType.WOOD
        return listOf(
            item(MaterialCategory.PICKET, MaterialRole.WOOD_PICKET, t, "6' Dog-Ear Wood Picket, Pressure-Treated Pine", unitPrice = 3.25, sourceDoc = SEEDED),
            item(MaterialCategory.RAIL, MaterialRole.WOOD_RAIL, t, "2x4x8' Pressure-Treated Rail", unitPrice = 6.50, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "4x4x8' Pressure-Treated Post", unitPrice = 9.50, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "4x4x8' Pressure-Treated Post", unitPrice = 9.50, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "4x4x8' Pressure-Treated Post", unitPrice = 9.50, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "4x4x8' Pressure-Treated Post", unitPrice = 9.50, sourceDoc = SEEDED),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "4x4 Wood Post Cap", unitPrice = 2.25, sourceDoc = SEEDED),
            item(MaterialCategory.GATE, MaterialRole.GATE_FRAME_KIT, t, "Wood Gate Frame Kit, Steel-Reinforced (up to 4'W)", unitPrice = 65.00, coversFt = 4f, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Heavy-Duty T-Hinge Pair", unit = "PAIR", unitPrice = 14.00, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Wood Gate Latch", unitPrice = 9.00, sourceDoc = SEEDED)
        )
    }

    private fun chainLinkItems(): List<MaterialItem> {
        val t = FenceType.CHAIN_LINK
        return listOf(
            item(MaterialCategory.FABRIC, MaterialRole.CHAIN_FABRIC, t, "Galvanized Chain Link Fabric, 4' (per LF)", unit = "LF", unitPrice = 3.10, coversFt = 4f, sourceDoc = SEEDED),
            item(MaterialCategory.FABRIC, MaterialRole.CHAIN_FABRIC, t, "Galvanized Chain Link Fabric, 6' (per LF)", unit = "LF", unitPrice = 4.35, coversFt = 6f, sourceDoc = SEEDED),
            item(MaterialCategory.FABRIC, MaterialRole.CHAIN_FABRIC, t, "Galvanized Chain Link Fabric, 8' (per LF)", unit = "LF", unitPrice = 5.60, coversFt = 8f, sourceDoc = SEEDED),
            item(MaterialCategory.RAIL, MaterialRole.TOP_RAIL, t, "1-3/8\" Top Rail (per LF)", unit = "LF", unitPrice = 2.10, sourceDoc = SEEDED),
            item(MaterialCategory.MISC, MaterialRole.TENSION_WIRE, t, "7-Gauge Bottom Tension Wire (per LF)", unit = "LF", unitPrice = 0.55, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "1-5/8\" Galvanized Line Post, 8'", unitPrice = 11.50, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "2\" Galvanized Terminal Post, 8'", unitPrice = 19.75, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "2\" Galvanized Terminal Post, 8'", unitPrice = 19.75, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "2\" Galvanized Terminal Post, 8'", unitPrice = 19.75, sourceDoc = SEEDED),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "Line Post Cap", unitPrice = 1.10, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.TENSION_BAND, t, "Tension Band", unitPrice = 1.05, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.BRACE_BAND, t, "Brace Band", unitPrice = 1.35, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.RAIL_END, t, "Rail End Cup", unitPrice = 1.60, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.BARBED_WIRE_ARM, t, "3-Strand Barbed Wire Arm", unitPrice = 8.75, sourceDoc = SEEDED),
            item(MaterialCategory.FABRIC, MaterialRole.PRIVACY_SLAT, t, "Privacy Slats (per LF)", unit = "LF", unitPrice = 2.90, sourceDoc = SEEDED),
            item(MaterialCategory.GATE, MaterialRole.GATE_FRAME_KIT, t, "Chain Link Walk Gate Frame, 4'W, Galvanized", unitPrice = 85.00, coversFt = 4f, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Chain Link Gate Hinge Set", unit = "SET", unitPrice = 12.50, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Chain Link Fork Latch", unitPrice = 9.75, sourceDoc = SEEDED)
        )
    }

    private fun aluminumItems(): List<MaterialItem> {
        val t = FenceType.ALUMINUM
        return listOf(
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Aluminum Fence Panel 6'H x 6'W, Rackable, Black", unitPrice = 95.00, coversFt = 6f, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Aluminum Fence Panel 6'H x 8'W, Rackable, Black", unitPrice = 118.00, coversFt = 8f, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "3\" Aluminum Post, 6', Black", unitPrice = 22.00, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "3\" Aluminum Post, 6', Black", unitPrice = 22.00, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "3\" Aluminum Post, 6', Black", unitPrice = 22.00, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "3\" Aluminum Post, 6', Black", unitPrice = 22.00, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "Aluminum Post Cap, Flat, Black", unitPrice = 3.50, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.GATE, MaterialRole.GATE_PANEL, t, "Aluminum Walk Gate 6'H x 4'W, Black", unitPrice = 175.00, coversFt = 4f, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Aluminum Gate Hinge Set, Self-Closing", unit = "SET", unitPrice = 28.00, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Aluminum Gate Latch, Self-Latching", unitPrice = 22.00, sourceDoc = SEEDED),

            // Color variants (placeholder -- correct once you have real supplier pricing per color)
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Aluminum Fence Panel 6'H x 6'W, Rackable, White", unitPrice = 99.00, coversFt = 6f, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Aluminum Fence Panel 6'H x 6'W, Rackable, Bronze", unitPrice = 99.00, coversFt = 6f, colorOrFinish = "Bronze", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "3\" Aluminum Post, 6', White", unitPrice = 23.00, colorOrFinish = "White", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "3\" Aluminum Post, 6', Bronze", unitPrice = 23.00, colorOrFinish = "Bronze", sourceDoc = SEEDED)
        )
    }

    private fun ornamentalIronItems(): List<MaterialItem> {
        val t = FenceType.ORNAMENTAL_IRON
        return listOf(
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Ornamental Steel Panel 4'H x 6'W, Black", unitPrice = 135.00, coversFt = 6f, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Ornamental Steel Panel 4'H x 8'W, Black", unitPrice = 165.00, coversFt = 8f, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Ornamental Steel Panel 6'H x 6'W, Black", unitPrice = 175.00, coversFt = 6f, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "4\"x4\" Steel Post, 6', Black", unitPrice = 32.00, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "4\"x4\" Steel Post, 6', Black", unitPrice = 32.00, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "4\"x4\" Steel Post, 6', Black", unitPrice = 32.00, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "4\"x4\" Steel Post, 6', Black", unitPrice = 32.00, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "Ornamental Post Cap, Black", unitPrice = 6.00, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.GATE, MaterialRole.GATE_PANEL, t, "Ornamental Steel Walk Gate 4'H x 4'W, Black", unitPrice = 210.00, coversFt = 4f, colorOrFinish = "Black", sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Heavy Iron Gate Hinge Set", unit = "SET", unitPrice = 24.00, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Self-Latching Iron Gate Latch", unitPrice = 19.00, sourceDoc = SEEDED)
        )
    }

    private fun splitRailItems(): List<MaterialItem> {
        val t = FenceType.SPLIT_RAIL
        return listOf(
            item(MaterialCategory.RAIL, MaterialRole.WOOD_RAIL, t, "8' Round Wood Split Rail", unitPrice = 9.50, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "5\" Round Wood Post, 7'", unitPrice = 14.00, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "5\" Round Wood Post, 7'", unitPrice = 14.00, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "5\" Round Wood Post, 7'", unitPrice = 14.00, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "5\" Round Wood Post, 7'", unitPrice = 14.00, sourceDoc = SEEDED),
            item(MaterialCategory.GATE, MaterialRole.GATE_FRAME_KIT, t, "Split-Rail Gate Frame Kit, 10'W", unitPrice = 95.00, coversFt = 10f, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Split-Rail Gate Hinge Set", unit = "SET", unitPrice = 12.00, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Split-Rail Gate Latch", unitPrice = 7.00, sourceDoc = SEEDED)
        )
    }

    private fun compositeItems(): List<MaterialItem> {
        val t = FenceType.COMPOSITE
        return listOf(
            item(MaterialCategory.PICKET, MaterialRole.WOOD_PICKET, t, "6' Composite Privacy Board", unitPrice = 9.75, sourceDoc = SEEDED),
            item(MaterialCategory.RAIL, MaterialRole.WOOD_RAIL, t, "Composite Rail, 8'", unitPrice = 16.00, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "4x4 Composite Post w/ Aluminum Insert, 8'", unitPrice = 28.00, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "4x4 Composite Post w/ Aluminum Insert, 8'", unitPrice = 28.00, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "4x4 Composite Post w/ Aluminum Insert, 8'", unitPrice = 28.00, sourceDoc = SEEDED),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "4x4 Composite Post w/ Aluminum Insert, 8'", unitPrice = 28.00, sourceDoc = SEEDED),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "Composite Post Cap", unitPrice = 5.00, sourceDoc = SEEDED),
            item(MaterialCategory.GATE, MaterialRole.GATE_FRAME_KIT, t, "Composite Gate Frame Kit (up to 4'W)", unitPrice = 145.00, coversFt = 4f, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Composite Gate Hinge Set", unit = "SET", unitPrice = 18.00, sourceDoc = SEEDED),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Composite Gate Latch", unitPrice = 14.00, sourceDoc = SEEDED)
        )
    }
}

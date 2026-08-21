package com.fenceestimator.app.data

// Neither string names a supplier or an invoice. The seed ships to every new
// company, and the old value carried the founding company's supplier and its
// invoice numbers into strangers' databases -- a real business's paperwork is
// not part of the product. The distinction that matters survives: quoted
// prices came off genuine supplier documents, placeholders are typical market
// rates that must be checked before anyone quotes off them.
private const val REAL = "From a real supplier quote"
private const val PLACEHOLDER = "Placeholder — verify with your supplier"

/**
 * Starting catalog. VINYL prices are pulled from the user's real FloriFence
 * documents (Invoice 36499, 10/16/2025, and the newer Estimate 17407,
 * 08/11/2026 -- the newer price wins where an item appears in both).
 * WOOD, CHAIN_LINK, and ALUMINUM prices are placeholders at typical Tampa-
 * market rates, clearly flagged, meant to be corrected once real supplier
 * pricing is available.
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
        item(MaterialCategory.CONCRETE, MaterialRole.CONCRETE_BAG, FenceType.UNIVERSAL, "Concrete Mix 60lb Bag", unitPrice = 4.75, sourceDoc = REAL),
        item(MaterialCategory.MISC, MaterialRole.HOLE_PLUG, FenceType.UNIVERSAL, "5/8\" Hole Plug, White", unitPrice = 0.15, colorOrFinish = "White", sourceDoc = REAL)
    )

    private fun vinylItems(): List<MaterialItem> {
        val t = FenceType.VINYL
        return listOf(
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Panel T&G Vinyl Privacy 6'H x 6'W - White", unitPrice = 52.35, taxable = false, coversFt = 6f, colorOrFinish = "White", sourceDoc = REAL),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Panel T&G Vinyl Privacy 6'H x 8'W - White", unitPrice = 71.40, taxable = true, coversFt = 8f, colorOrFinish = "White", sourceDoc = REAL),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "5\"x5\" Co-Ex Line Post, White", unitPrice = 16.56, colorOrFinish = "White", sourceDoc = REAL),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "5\"x5\" Co-Ex End Post, White", unitPrice = 16.56, colorOrFinish = "White", sourceDoc = REAL),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "5\"x5\" Co-Ex Corner Post, White", unitPrice = 16.56, colorOrFinish = "White", sourceDoc = REAL),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "5\"x5\" Co-Ex Gate Post, White", unitPrice = 16.56, colorOrFinish = "White", sourceDoc = REAL),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "5\" External Pyramid PVC Post Cap, White", unitPrice = 0.74, colorOrFinish = "White", sourceDoc = REAL),
            item(MaterialCategory.GATE, MaterialRole.GATE_PANEL, t, "Regular PVC Gate 6'H x 5'W, White", unitPrice = 145.05, taxable = false, coversFt = 5f, colorOrFinish = "White", sourceDoc = REAL),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Self-Closing Hinge Set (box, 12 pairs)", unit = "BOX", unitPrice = 32.25, colorOrFinish = "White", sourceDoc = REAL),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Two-Way Latch (box of 20)", unit = "BOX", unitPrice = 25.87, colorOrFinish = "Black", sourceDoc = REAL),
            item(MaterialCategory.HARDWARE, MaterialRole.HANDLE, t, "7\" SS Gate Handle (box of 50)", unit = "BOX", unitPrice = 5.00, colorOrFinish = "Black", sourceDoc = REAL),
            item(MaterialCategory.HARDWARE, MaterialRole.BRACE, t, "Gate Support Brace, 8'", unitPrice = 6.50, colorOrFinish = "White", sourceDoc = REAL),
            item(MaterialCategory.HARDWARE, MaterialRole.STIFFENER, t, "5\" Econo Stiffener x 8'(H)", unitPrice = 52.75, sourceDoc = REAL),
            item(MaterialCategory.TRIM, MaterialRole.TRIM, t, "7/8 x 1-1/2 x 62 1/4 Trim U-Channel, White", unitPrice = 2.00, colorOrFinish = "White", sourceDoc = REAL),

            // Color variants (placeholder -- correct once you have real supplier pricing per color)
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Panel T&G Vinyl Privacy 6'H x 6'W - Tan", unitPrice = 54.50, taxable = false, coversFt = 6f, colorOrFinish = "Tan", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Panel T&G Vinyl Privacy 6'H x 6'W - Gray", unitPrice = 54.50, taxable = false, coversFt = 6f, colorOrFinish = "Gray", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Panel T&G Vinyl Privacy 6'H x 8'W - Tan", unitPrice = 73.90, taxable = true, coversFt = 8f, colorOrFinish = "Tan", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "5\"x5\" Co-Ex Line Post, Tan", unitPrice = 17.25, colorOrFinish = "Tan", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "5\"x5\" Co-Ex Line Post, Gray", unitPrice = 17.25, colorOrFinish = "Gray", sourceDoc = PLACEHOLDER)
        )
    }

    private fun woodItems(): List<MaterialItem> {
        val t = FenceType.WOOD
        return listOf(
            item(MaterialCategory.PICKET, MaterialRole.WOOD_PICKET, t, "6' Dog-Ear Wood Picket, Pressure-Treated Pine", unitPrice = 3.25, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.RAIL, MaterialRole.WOOD_RAIL, t, "2x4x8' Pressure-Treated Rail", unitPrice = 6.50, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "4x4x8' Pressure-Treated Post", unitPrice = 9.50, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "4x4x8' Pressure-Treated Post", unitPrice = 9.50, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "4x4x8' Pressure-Treated Post", unitPrice = 9.50, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "4x4x8' Pressure-Treated Post", unitPrice = 9.50, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "4x4 Wood Post Cap", unitPrice = 2.25, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.GATE, MaterialRole.GATE_FRAME_KIT, t, "Wood Gate Frame Kit, Steel-Reinforced (up to 4'W)", unitPrice = 65.00, coversFt = 4f, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Heavy-Duty T-Hinge Pair", unit = "PAIR", unitPrice = 14.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Wood Gate Latch", unitPrice = 9.00, sourceDoc = PLACEHOLDER)
        )
    }

    private fun chainLinkItems(): List<MaterialItem> {
        val t = FenceType.CHAIN_LINK
        return listOf(
            item(MaterialCategory.FABRIC, MaterialRole.CHAIN_FABRIC, t, "Galvanized Chain Link Fabric, 4' (per LF)", unit = "LF", unitPrice = 3.10, coversFt = 4f, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.FABRIC, MaterialRole.CHAIN_FABRIC, t, "Galvanized Chain Link Fabric, 6' (per LF)", unit = "LF", unitPrice = 4.35, coversFt = 6f, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.FABRIC, MaterialRole.CHAIN_FABRIC, t, "Galvanized Chain Link Fabric, 8' (per LF)", unit = "LF", unitPrice = 5.60, coversFt = 8f, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.RAIL, MaterialRole.TOP_RAIL, t, "1-3/8\" Top Rail (per LF)", unit = "LF", unitPrice = 2.10, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.MISC, MaterialRole.TENSION_WIRE, t, "7-Gauge Bottom Tension Wire (per LF)", unit = "LF", unitPrice = 0.55, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "1-5/8\" Galvanized Line Post, 8'", unitPrice = 11.50, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "2\" Galvanized Terminal Post, 8'", unitPrice = 19.75, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "2\" Galvanized Terminal Post, 8'", unitPrice = 19.75, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "2\" Galvanized Terminal Post, 8'", unitPrice = 19.75, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "Line Post Cap", unitPrice = 1.10, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.TENSION_BAND, t, "Tension Band", unitPrice = 1.05, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.BRACE_BAND, t, "Brace Band", unitPrice = 1.35, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.RAIL_END, t, "Rail End Cup", unitPrice = 1.60, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.BARBED_WIRE_ARM, t, "3-Strand Barbed Wire Arm", unitPrice = 8.75, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.FABRIC, MaterialRole.PRIVACY_SLAT, t, "Privacy Slats (per LF)", unit = "LF", unitPrice = 2.90, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.GATE, MaterialRole.GATE_FRAME_KIT, t, "Chain Link Walk Gate Frame, 4'W, Galvanized", unitPrice = 85.00, coversFt = 4f, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Chain Link Gate Hinge Set", unit = "SET", unitPrice = 12.50, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Chain Link Fork Latch", unitPrice = 9.75, sourceDoc = PLACEHOLDER)
        )
    }

    private fun aluminumItems(): List<MaterialItem> {
        val t = FenceType.ALUMINUM
        return listOf(
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Aluminum Fence Panel 6'H x 6'W, Rackable, Black", unitPrice = 95.00, coversFt = 6f, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Aluminum Fence Panel 6'H x 8'W, Rackable, Black", unitPrice = 118.00, coversFt = 8f, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "3\" Aluminum Post, 6', Black", unitPrice = 22.00, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "3\" Aluminum Post, 6', Black", unitPrice = 22.00, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "3\" Aluminum Post, 6', Black", unitPrice = 22.00, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "3\" Aluminum Post, 6', Black", unitPrice = 22.00, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "Aluminum Post Cap, Flat, Black", unitPrice = 3.50, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.GATE, MaterialRole.GATE_PANEL, t, "Aluminum Walk Gate 6'H x 4'W, Black", unitPrice = 175.00, coversFt = 4f, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Aluminum Gate Hinge Set, Self-Closing", unit = "SET", unitPrice = 28.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Aluminum Gate Latch, Self-Latching", unitPrice = 22.00, sourceDoc = PLACEHOLDER),

            // Color variants (placeholder -- correct once you have real supplier pricing per color)
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Aluminum Fence Panel 6'H x 6'W, Rackable, White", unitPrice = 99.00, coversFt = 6f, colorOrFinish = "White", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Aluminum Fence Panel 6'H x 6'W, Rackable, Bronze", unitPrice = 99.00, coversFt = 6f, colorOrFinish = "Bronze", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "3\" Aluminum Post, 6', White", unitPrice = 23.00, colorOrFinish = "White", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "3\" Aluminum Post, 6', Bronze", unitPrice = 23.00, colorOrFinish = "Bronze", sourceDoc = PLACEHOLDER)
        )
    }

    private fun ornamentalIronItems(): List<MaterialItem> {
        val t = FenceType.ORNAMENTAL_IRON
        return listOf(
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Ornamental Steel Panel 4'H x 6'W, Black", unitPrice = 135.00, coversFt = 6f, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Ornamental Steel Panel 4'H x 8'W, Black", unitPrice = 165.00, coversFt = 8f, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.PANEL, MaterialRole.PANEL, t, "Ornamental Steel Panel 6'H x 6'W, Black", unitPrice = 175.00, coversFt = 6f, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "4\"x4\" Steel Post, 6', Black", unitPrice = 32.00, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "4\"x4\" Steel Post, 6', Black", unitPrice = 32.00, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "4\"x4\" Steel Post, 6', Black", unitPrice = 32.00, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "4\"x4\" Steel Post, 6', Black", unitPrice = 32.00, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "Ornamental Post Cap, Black", unitPrice = 6.00, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.GATE, MaterialRole.GATE_PANEL, t, "Ornamental Steel Walk Gate 4'H x 4'W, Black", unitPrice = 210.00, coversFt = 4f, colorOrFinish = "Black", sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Heavy Iron Gate Hinge Set", unit = "SET", unitPrice = 24.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Self-Latching Iron Gate Latch", unitPrice = 19.00, sourceDoc = PLACEHOLDER)
        )
    }

    private fun splitRailItems(): List<MaterialItem> {
        val t = FenceType.SPLIT_RAIL
        return listOf(
            item(MaterialCategory.RAIL, MaterialRole.WOOD_RAIL, t, "8' Round Wood Split Rail", unitPrice = 9.50, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "5\" Round Wood Post, 7'", unitPrice = 14.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "5\" Round Wood Post, 7'", unitPrice = 14.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "5\" Round Wood Post, 7'", unitPrice = 14.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "5\" Round Wood Post, 7'", unitPrice = 14.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.GATE, MaterialRole.GATE_FRAME_KIT, t, "Split-Rail Gate Frame Kit, 10'W", unitPrice = 95.00, coversFt = 10f, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Split-Rail Gate Hinge Set", unit = "SET", unitPrice = 12.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Split-Rail Gate Latch", unitPrice = 7.00, sourceDoc = PLACEHOLDER)
        )
    }

    private fun compositeItems(): List<MaterialItem> {
        val t = FenceType.COMPOSITE
        return listOf(
            item(MaterialCategory.PICKET, MaterialRole.WOOD_PICKET, t, "6' Composite Privacy Board", unitPrice = 9.75, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.RAIL, MaterialRole.WOOD_RAIL, t, "Composite Rail, 8'", unitPrice = 16.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.LINE_POST, t, "4x4 Composite Post w/ Aluminum Insert, 8'", unitPrice = 28.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.END_POST, t, "4x4 Composite Post w/ Aluminum Insert, 8'", unitPrice = 28.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.CORNER_POST, t, "4x4 Composite Post w/ Aluminum Insert, 8'", unitPrice = 28.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.POST, MaterialRole.GATE_POST, t, "4x4 Composite Post w/ Aluminum Insert, 8'", unitPrice = 28.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.CAP, MaterialRole.POST_CAP, t, "Composite Post Cap", unitPrice = 5.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.GATE, MaterialRole.GATE_FRAME_KIT, t, "Composite Gate Frame Kit (up to 4'W)", unitPrice = 145.00, coversFt = 4f, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.HINGE_SET, t, "Composite Gate Hinge Set", unit = "SET", unitPrice = 18.00, sourceDoc = PLACEHOLDER),
            item(MaterialCategory.HARDWARE, MaterialRole.LATCH, t, "Composite Gate Latch", unitPrice = 14.00, sourceDoc = PLACEHOLDER)
        )
    }
}

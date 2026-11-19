package com.fenceestimator.app.ui.runs

import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.MaterialRole

/**
 * The colours a company can actually build a fence in, and what each one
 * cannot cover.
 *
 * The owner, 17 Nov 2026: "I also want to add the color of the fence like
 * Vinyl tan ... Maybe for all the fences on there, I also want to see the
 * prices."
 *
 * ------------------------------------------------------------------
 * WHY THIS IS NOT JUST A LIST OF COLOURS
 * ------------------------------------------------------------------
 * A colour is not a property of a fence in this app -- it is a property of
 * CATALOG ROWS, and a company stocks different colours for different parts.
 * MEASURED on the owner's live vinyl catalog, 18 Nov 2026: he has Tan in
 * END_POST, GATE_POST, LINE_POST, PANEL, GATE_PANEL and POST_CAP, and no Tan
 * at all in CORNER_POST, TRIM, BRACE, HINGE_SET, LATCH or HANDLE.
 *
 * The engines price a role they cannot match in the wanted colour off whatever
 * colour is cheapest instead -- usually White -- and since 2026.11.18 they SAY
 * so (BuiltItems.colorFallbacks). That warning arrives on the estimate, which
 * is after the choosing. This is the same fact moved to the moment it is
 * useful: the point where somebody picks Tan.
 *
 * ------------------------------------------------------------------
 * WHAT "MISSING" MEANS HERE, precisely
 * ------------------------------------------------------------------
 * A role counts against a colour only when COLOUR IS A REAL CHOICE for that
 * role -- that is, when the company stocks at least one row of the role, for
 * this fence type, that names any colour at all. Concrete bags and other rows
 * with a blank colour are not "missing in Tan"; they have no colour, and
 * flagging them would be noise that teaches people to ignore the warning.
 *
 * Nothing here is filtered by whether a part is VISIBLE. A stiffener lives
 * inside a post and arguably does not matter in the wrong colour, but that is
 * a judgement about fencing, not about data, and inventing it would hide real
 * misses behind a guess. The roles are listed plainly and the person reading
 * decides.
 *
 * ------------------------------------------------------------------
 * THE PRICE SHOWN
 * ------------------------------------------------------------------
 * [Option.panelPrice] is the cheapest PANEL row in that colour, which is the
 * part that dominates the cost of a fence and the only one comparable BETWEEN
 * colours. It is null when the colour has no panel at all, which is itself
 * worth seeing -- a colour you cannot buy a panel in is not a colour you can
 * build in. It is deliberately not a total: a total would depend on the
 * takeoff, which does not exist yet at the moment of choosing, and a made-up
 * one would be a number somebody could quote.
 */
object RunColourOptions {

    data class Option(
        /** Exactly as stored on the rows, because that is what the engines compare against. */
        val colour: String,
        /** Cheapest PANEL row in this colour, or null when the colour has no panel. */
        val panelPrice: Double?,
        /** Roles where colour is a real choice and this colour has no row. */
        val missingRoles: List<MaterialRole>,
        /** Roles where colour is a real choice and this colour does have one. */
        val coveredRoles: List<MaterialRole>
    ) {
        /** True when this colour can dress every part the company stocks in colours. */
        val coversEverything: Boolean get() = missingRoles.isEmpty()
    }

    /**
     * Every colour this company can build [type] in, commonest first.
     *
     * Ordered by how much of the fence the colour covers, then by panel price,
     * then by name, so the colour that can actually dress the whole fence
     * leads and ties do not reorder themselves between readings.
     */
    fun forFenceType(catalog: List<MaterialItem>, type: FenceType): List<Option> {
        val rows = catalog.filter { it.isActive && it.fenceType == type }
        if (rows.isEmpty()) return emptyList()

        // Roles where colour is a real choice: at least one row of the role
        // names a colour. A role stocked only in blank-colour rows is not a
        // role any colour can be missing.
        val colourfulRoles = rows
            .filter { it.colorOrFinish.isNotBlank() }
            .map { it.role }
            .toSet()

        val colours = rows
            .map { it.colorOrFinish.trim() }
            .filter { it.isNotBlank() }
            // Case-insensitively distinct, keeping the first spelling seen, because
            // "Tan" and "tan" are the same paint and the engines already compare
            // ignoring case. Two entries would offer the same choice twice.
            .distinctBy { it.lowercase() }

        return colours.map { colour ->
            val inColour = rows.filter { it.colorOrFinish.equals(colour, ignoreCase = true) }
            val covered = inColour.map { it.role }.toSet()
            Option(
                colour = colour,
                panelPrice = inColour
                    .filter { it.role == MaterialRole.PANEL && it.unitPrice > 0.0 }
                    .minOfOrNull { it.unitPrice },
                missingRoles = (colourfulRoles - covered).sortedBy { it.name },
                coveredRoles = (colourfulRoles intersect covered).sortedBy { it.name }
            )
        }.sortedWith(
            compareByDescending<Option> { it.coveredRoles.size }
                .thenBy { it.panelPrice ?: Double.MAX_VALUE }
                .thenBy { it.colour.lowercase() }
        )
    }

    /**
     * The option matching a colour already typed on the run, or null.
     *
     * Case-insensitive, and trims, because the colour on a run is free text
     * that people type -- "tan " and "Tan" have both reached production rows.
     * A null answer means the typed colour is not one this catalog stocks at
     * all, which the screen says plainly rather than silently showing nothing.
     */
    fun match(options: List<Option>, typed: String): Option? {
        val t = typed.trim()
        if (t.isEmpty()) return null
        return options.firstOrNull { it.colour.equals(t, ignoreCase = true) }
    }
}

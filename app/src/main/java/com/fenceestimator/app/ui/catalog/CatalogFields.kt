package com.fenceestimator.app.ui.catalog

import com.fenceestimator.app.data.Manufacturer
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.MaterialRole
import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale

// The decisions the catalog screen makes about a row, kept apart from the Compose
// code so they are plain functions of their arguments: no state, no resources, no
// clock. CatalogScreen.kt draws them; this file decides them.

/**
 * Which size boxes the editor shows for a role.
 *
 * Two different numbers live on a catalog row and confusing them misprices a job:
 *
 *  - [MaterialItem.coversFt] is the WIDTH of a PANEL or GATE_PANEL and the HEIGHT of
 *    CHAIN_FABRIC.
 *  - [MaterialItem.heightFt] is the HEIGHT of a PANEL or GATE_PANEL, and is read for
 *    nothing else.
 *
 * Both engines read heightFt for those two roles and no other
 * (EstimateEngine.buildLineItems here, line-items.ts on the server), so those are the
 * only two roles that get a height box. A height typed on a post or a hinge set would
 * be saved and never used, which is a field that looks like it works and does not.
 */
internal enum class SizeFields {
    /** PANEL, GATE_PANEL: a width box (coversFt) and a height box (heightFt). */
    WIDTH_AND_HEIGHT,

    /** CHAIN_FABRIC: ONE box, the fabric height, which is coversFt. There is no second height box. */
    FABRIC_HEIGHT,

    /** Every other role: the engine reads neither number, so the box that was always there stays as it was. */
    OTHER
}

internal fun sizeFieldsFor(role: MaterialRole): SizeFields = when (role) {
    MaterialRole.PANEL, MaterialRole.GATE_PANEL -> SizeFields.WIDTH_AND_HEIGHT
    MaterialRole.CHAIN_FABRIC -> SizeFields.FABRIC_HEIGHT
    else -> SizeFields.OTHER
}

/**
 * The tallest height a catalog row may claim, in feet. It is here to catch a height
 * typed in the wrong unit: 72 for a 6 ft panel would save and then never equal any
 * run's panel height, so the row would quietly never be chosen by height.
 */
internal const val MAX_HEIGHT_FT = 20f

/** What was typed in the height box. */
internal sealed class HeightEntry {
    /** Nothing typed. The row does not say how tall it is. This is NEVER zero. */
    object Blank : HeightEntry()

    /** A real height, in feet. */
    class Feet(val feet: Float) : HeightEntry()

    /** Something typed that is not a height in feet. */
    object NotAHeight : HeightEntry()
}

/**
 * Reads the height box. Blank is checked FIRST and stays blank: it must not fall
 * through to a number parse and come out as 0, because a row holding 0 would claim to
 * be a zero-foot fence rather than a row that does not say. A comma is accepted as the
 * decimal mark, as everywhere else in the app.
 */
internal fun parseHeightEntry(text: String): HeightEntry {
    val cleaned = text.trim().replace(',', '.')
    if (cleaned.isEmpty()) return HeightEntry.Blank
    val feet = cleaned.toFloatOrNull() ?: return HeightEntry.NotAHeight
    if (feet.isNaN() || feet.isInfinite() || feet <= 0f || feet > MAX_HEIGHT_FT) return HeightEntry.NotAHeight
    return HeightEntry.Feet(feet)
}

/** Why a save is refused over the height box. */
internal enum class HeightProblem {
    /** Typed, but not a height in feet. */
    NOT_A_HEIGHT,

    /**
     * Emptied on a row that already has a height.
     *
     * A cleared height does not reliably reach the cloud: the sync leaves a null out of
     * the push (the shared Json is explicitNulls = false), so the cloud keeps the old
     * number, and the next pull puts it back on this phone. Saving the blank would look
     * like it worked and then undo itself. So it is refused here, and the number has to
     * be changed to the right one instead.
     */
    CANNOT_BE_CLEARED
}

/**
 * What stops a save over the height box, or null when nothing does.
 *
 * Only a role that shows the box is checked: for every other role the box is not on
 * screen and whatever it holds is not saved (see [heightToSave]).
 */
internal fun heightProblem(role: MaterialRole, typed: String, saved: Float?): HeightProblem? {
    if (sizeFieldsFor(role) != SizeFields.WIDTH_AND_HEIGHT) return null
    return when (parseHeightEntry(typed)) {
        is HeightEntry.NotAHeight -> HeightProblem.NOT_A_HEIGHT
        is HeightEntry.Blank -> if (saved != null) HeightProblem.CANNOT_BE_CLEARED else null
        is HeightEntry.Feet -> null
    }
}

/**
 * The heightFt to store.
 *
 * A typed height when the box is on screen; otherwise, and for a blank box on a row that
 * had none, whatever the row already said. A hidden box never changes a height, and a
 * blank never becomes a number.
 */
internal fun heightToSave(role: MaterialRole, typed: String, saved: Float?): Float? {
    if (sizeFieldsFor(role) != SizeFields.WIDTH_AND_HEIGHT) return saved
    val entry = parseHeightEntry(typed)
    return if (entry is HeightEntry.Feet) entry.feet else saved
}

/** 6.0 reads "6" and 4.5 reads "4.5", the way a person would type them. */
internal fun feetText(value: Float): String =
    if (value % 1f == 0f) value.toInt().toString() else value.toString()

/** The size a list row says about itself, as text pieces. */
internal class RowSize(
    val width: String?,
    val height: String?,
    /** A PANEL or GATE_PANEL row that does not say how tall it is. */
    val heightMissing: Boolean,
    /** CHAIN_FABRIC only: coversFt, which is the fabric's height. */
    val fabricHeight: String?
)

internal fun rowSizeOf(item: MaterialItem): RowSize? = when (sizeFieldsFor(item.role)) {
    SizeFields.WIDTH_AND_HEIGHT -> RowSize(
        width = item.coversFt?.let { feetText(it) },
        height = item.heightFt?.let { feetText(it) },
        heightMissing = item.heightFt == null,
        fabricHeight = null
    )
    SizeFields.FABRIC_HEIGHT -> item.coversFt?.let { RowSize(null, null, false, feetText(it)) }
    SizeFields.OTHER -> null
}

/**
 * The supplier this phone holds for a row, or null.
 *
 * Null means THIS PHONE has none recorded: it reads [MaterialItem.manufacturerId], the
 * local link. A catalog row that arrives from the cloud does not bring its supplier
 * with it (CloudMaterialItem has no manufacturer_sync_id), so a row the office gave a
 * supplier has none here until the sync carries that link.
 */
internal fun supplierOf(item: MaterialItem, manufacturers: List<Manufacturer>): Manufacturer? =
    manufacturers.firstOrNull { it.id == item.manufacturerId }

private val exactMoney = DecimalFormat("\$#,##0.00###", DecimalFormatSymbols(Locale.US))

/** True when the price carries digits below a cent, such as 54.99875. */
internal fun hasSubCentDigits(price: Double): Boolean {
    if (price.isNaN() || price.isInfinite()) return false
    val cents = price * 100.0
    return Math.abs(cents - Math.rint(cents)) > 1e-6
}

/**
 * The price as the list shows it.
 *
 * The usual two-place money text, EXCEPT when the stored price has digits below a cent:
 * then the exact figure, up to five places. A supplier who quotes 54.99875 would
 * otherwise read "$55.00" on the list while the estimate multiplies 54.99875, and a
 * price on screen that is not the price in the engine is how a quote ends up a few
 * cents off an invoice. [standard] is the app's normal money formatter.
 */
internal fun listPriceText(price: Double, standard: (Double) -> String): String {
    if (!hasSubCentDigits(price)) return standard(price)
    return synchronized(exactMoney) { exactMoney.format(price) }
}

package com.fenceestimator.app.ui.components

object TemplateFiller {
    fun fillOrderTemplate(
        template: String,
        customerName: String,
        address: String,
        lineItems: String,
        total: String,
        businessName: String
    ): String = template
        .replace("{customerName}", customerName)
        .replace("{address}", address)
        .replace("{lineItems}", lineItems)
        .replace("{total}", total)
        .replace("{businessName}", businessName)

    fun fillHoaTemplate(
        template: String,
        address: String,
        fenceType: String,
        height: String,
        material: String,
        businessName: String,
        phone: String
    ): String = template
        .replace("{address}", address)
        .replace("{fenceType}", fenceType)
        .replace("{height}", height)
        .replace("{material}", material)
        .replace("{businessName}", businessName)
        .replace("{phone}", phone)

    /**
     * A measurement as a letter writes it: 6, not 6.0, and 4.5 kept as 4.5.
     *
     * A letter to an association saying "6.0 ft" reads as machine output, and
     * the one place this app has ever printed a raw Float at a person was this
     * template.
     */
    fun feetWord(feet: Float): String = when {
        !feet.isFinite() || feet <= 0f -> ""
        kotlin.math.abs(feet - Math.round(feet)) < 0.05f -> Math.round(feet).toString()
        else -> String.format(java.util.Locale.US, "%.1f", feet)
    }

    /**
     * Several values as one phrase: "6 ft", "4 ft and 6 ft", "4 ft, 5 ft and 6 ft".
     *
     * [and] comes from the caller so it comes from the locale. A hardcoded
     * " and " in a Spanish or French letter is the kind of thing a customer
     * notices and the author never does.
     */
    fun phrase(parts: List<String>, and: String): String {
        val kept = parts.filter { it.isNotBlank() }.distinct()
        return when (kept.size) {
            0 -> ""
            1 -> kept[0]
            2 -> kept[0] + " " + and + " " + kept[1]
            else -> kept.dropLast(1).joinToString(", ") + " " + and + " " + kept.last()
        }
    }

    /**
     * EVERY height on this job, not the first side's.
     *
     * Teardown runs are left out: the association is being asked to approve
     * the fence going IN, and the old one coming out has no approved height to
     * state. Sorted, so the same job always produces the same sentence
     * whatever order the sides came back in.
     */
    fun heightPhrase(
        heightsFt: List<Float>,
        and: String,
        unit: String,
    ): String = phrase(
        heightsFt.filter { it.isFinite() && it > 0f }.distinct().sorted()
            .map { feetWord(it) + " " + unit },
        and,
    )

    fun fillReviewTemplate(
        template: String,
        customerName: String,
        businessName: String
    ): String = template
        .replace("{customerName}", customerName)
        .replace("{businessName}", businessName)
}

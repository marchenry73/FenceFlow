package com.fenceestimator.app.ui.crew

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Crew must never see the customer's money: no contract total, no job
 * margin, no catalog/list price. `CrewFencePlanScreen.kt` says it in a
 * comment ("Prices are absent by design; the crew's own pay lives on the
 * job screen") -- this test makes that a build-time guarantee instead of a
 * comment nobody re-checks after the next edit.
 *
 * Scope: this scans only the `.kt` files under `ui/crew`, the screens a crew member actually
 * opens. It does not scan office screens (`ui/jobs`, `ui/reports`, etc.),
 * which show money on purpose.
 */
class CrewNoMoneyTest {

    private fun crewDir(): File {
        val bases = listOf(
            File("src/main/java/com/fenceestimator/app/ui/crew"),
            File("app/src/main/java/com/fenceestimator/app/ui/crew")
        )
        return bases.firstOrNull { it.isDirectory }
            ?: error("could not locate ui/crew from ${File(".").absolutePath}")
    }

    // Case-insensitive, word-ish boundary so "Category" or "operate" don't
    // false-positive on "rate", but "hourlyRate" or "pay.amount" do match.
    private val moneyish = Regex(
        "(?i)\\b(price|total|amount|rate|cost|margin)\\b|catalog(Item)?\\.(price|cost)"
    )

    // Every allowed match, with why it's allowed. Each entry is a substring
    // that, when found on an offending line, clears that line. Keep this
    // list short and specific -- it is the one place a real leak could hide
    // behind a bogus "that's fine" comment.
    private val allowedSubstrings = listOf(
        "pay.amount",           // the crew member's OWN pay, not job/customer money
        "pay.projectedAmount",
        "pay.effectiveHourly",
        "pay.hoursAwaitingApproval",
        "pay.rateIsUnset",
        "pay.splitAmong",
        "pay.payType",
        "pay.explain",
        "hourlyRate",           // the crew member's own clock-in rate
        "claimedCost",          // labor cost of one shift, shown only on the
                                 // manager-only TimeApprovalScreen, never on
                                 // CrewJobScreen/CrewFencePlanScreen
        "correctedHours",
        "totalHours",           // hours worked, not a dollar figure
        "totalLinearFeet",      // fence length, not money
        "totalDays",            // day count in a multi-day job plan
        "dayPlan.totalDays",
        "isFinalDay",
        "// ",                  // comments explaining the design (like this file's own header)
        "*",                    // kdoc/comment lines
    )

    @Test
    fun `crew screens never show job or catalog money`() {
        val offenders = mutableListOf<String>()
        crewDir().listFiles { f -> f.extension == "kt" }?.sortedBy { it.name }?.forEach { file ->
            file.readLines().forEachIndexed { idx, line ->
                val trimmed = line.trim()
                // Comments and KDoc explain WHY money is absent here; they are
                // prose, not something a crew member can ever see on screen.
                val isComment = trimmed.startsWith("//") || trimmed.startsWith("*") ||
                    trimmed.startsWith("/*")
                if (!isComment && moneyish.containsMatchIn(trimmed) &&
                    allowedSubstrings.none { trimmed.contains(it) }
                ) {
                    offenders += "${file.name}:${idx + 1}: $trimmed"
                }
            }
        }
        assertTrue(
            "Money-ish usage found in crew UI outside the allowed (own-pay) list:\n" +
                offenders.joinToString("\n"),
            offenders.isEmpty()
        )
    }
}

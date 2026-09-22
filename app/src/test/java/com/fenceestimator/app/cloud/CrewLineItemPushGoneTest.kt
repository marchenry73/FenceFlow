package com.fenceestimator.app.cloud

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A crew phone sends no line items at all.
 *
 * The admin page on 2026-09-21 showed a crew phone on 1.512 failing
 * "rpc/crew_push_line_items". That door wrote quantity and description from a
 * catalog with every price scrubbed to zero, so a crew phone and the owner's
 * overwrote each other's takeoff on every sync; the push was removed (see the
 * "line items" step in EntitySync.pushAll) and with it the failure. This keeps
 * it removed: no code calls the RPC, and the step answers nothing for a phone
 * that may not see money.
 */
class CrewLineItemPushGoneTest {

    private val mainJava = listOf(File("src/main/java"), File("app/src/main/java")).first { it.isDirectory }

    @Test
    fun `nothing in the app calls crew_push_line_items`() {
        val callers = mainJava.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .filter { Regex("""rpc\(\s*"crew_push_line_items"""").containsMatchIn(it.readText()) }
            .map { it.name }.toList()
        assertTrue("still called from $callers", callers.isEmpty())
    }

    @Test
    fun `the line item step sends nothing unless money is allowed`() {
        val src = File(mainJava, "com/fenceestimator/app/cloud/EntitySync.kt").readText()
        val step = src.substringAfter("step(\"line items\") {").substringBefore("step(\"expenses\")")
        assertTrue(step, Regex("""MoneyScope\.DENIED\s*->\s*0\b""").containsMatchIn(step))
        assertTrue(step, Regex("""MoneyScope\.UNKNOWN\s*->\s*0\b""").containsMatchIn(step))
        assertFalse(step, step.contains("\"crew_push_line_items\""))
    }
}

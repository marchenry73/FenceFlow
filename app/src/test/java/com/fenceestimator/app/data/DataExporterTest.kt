package com.fenceestimator.app.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The export is the one file a contractor takes to their accountant, their
 * lawyer, or their next app. It has to be both correct and safe to open.
 */
class DataExporterTest {

    // ---- formula injection ----
    //
    // Every value in the export was typed by somebody: a customer name, a job
    // note, an expense description. Spreadsheets execute a cell that starts
    // with = + - or @, so an unescaped export turns the contractor's own file
    // into an attack on them when they open it.

    @Test
    fun `a formula is defused, not executed`() {
        assertEquals("'=1+1", DataExporter.escape("=1+1"))
    }

    @Test
    fun `the nasty one is defused`() {
        // The real-world shape: a link that runs when the sheet is opened.
        //
        // Both defences apply, in this order: the apostrophe goes on first, then
        // the whole thing is CSV-quoted because it contains commas and quotes.
        // So the field is quote-wrapped and the apostrophe sits inside -- which
        // is what we want, because after the spreadsheet parses the CSV the cell
        // contains `'=HYPERLINK(...)` and the leading apostrophe makes it text.
        val payload = """=HYPERLINK("http://evil.example","Click")"""
        assertEquals(
            """"'=HYPERLINK(""http://evil.example"",""Click"")"""",
            DataExporter.escape(payload)
        )
    }

    @Test
    fun `all four dangerous leads are defused`() {
        for (lead in listOf("=", "+", "-", "@")) {
            assertEquals("'${lead}cmd", DataExporter.escape("${lead}cmd"))
        }
    }

    @Test
    fun `a negative number in a text field is defused too`() {
        // Slightly annoying for a value that really is negative, but money
        // columns are formatted separately and never reach this path as text
        // a person typed. Safety wins over tidiness here.
        assertEquals("'-50 credit", DataExporter.escape("-50 credit"))
    }

    @Test
    fun `ordinary text is left completely alone`() {
        assertEquals("Smith", DataExporter.escape("Smith"))
        assertEquals("6ft cedar privacy", DataExporter.escape("6ft cedar privacy"))
    }

    // ---- ordinary CSV correctness ----

    @Test
    fun `a comma forces quoting`() {
        assertEquals("\"Smith, John\"", DataExporter.escape("Smith, John"))
    }

    @Test
    fun `a quote is doubled inside quotes`() {
        assertEquals("\"6\"\" gap\"", DataExporter.escape("6\" gap"))
    }

    @Test
    fun `a newline inside a note does not break the row`() {
        // Job notes are multi-line often enough that getting this wrong would
        // shift every following column by one.
        assertEquals("\"line one\nline two\"", DataExporter.escape("line one\nline two"))
    }

    @Test
    fun `a carriage return is quoted as well`() {
        assertEquals("\"a\rb\"", DataExporter.escape("a\rb"))
    }

    @Test
    fun `empty stays empty`() {
        assertEquals("", DataExporter.escape(""))
    }
}

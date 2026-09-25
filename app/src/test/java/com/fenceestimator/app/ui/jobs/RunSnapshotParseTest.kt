package com.fenceestimator.app.ui.jobs

import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateMarker
import com.fenceestimator.app.geometry.GateMounting
import com.fenceestimator.app.geometry.GateSwing
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reading one withdrawal's stored snapshot back, and writing it onto a run
 * ([parseRunSnapshot], [RunSnapshot.appliedTo]).
 *
 * This is the only part of a drawing restore that can be exercised without a
 * phone, and it is where a restore goes wrong quietly. The server hands over a
 * bar-separated string; a reader that takes one field for another, or invents a
 * figure for a field the server left empty, or restores a shape it does not
 * actually understand, writes a run onto the job that the customer never
 * approved -- and the screen still says it worked, because whether the approval
 * comes back is decided in the cloud on a later sync, long after anybody is
 * looking at it.
 *
 * The snapshot the server writes today has six fields: the two encoded
 * strings, the closed-loop flag, the typed footage, the typed corner count and
 * the teardown flag, in that order. Rows written before it was widened hold
 * only the first three and still have to be readable. Those two shapes are the
 * whole contract -- anything else is refused rather than guessed at.
 *
 * None of this decides whether the approval returns. The database decides that,
 * from the takeoff fingerprint, after the write lands. What these tests protect
 * is the only thing the phone controls: that the run put back is the run that
 * came off, field for field.
 */
class RunSnapshotParseTest {

    /** A drawn outline and one gate, in the app's own encoding. */
    private val points = "10:10,10:120,90:120"
    private val gates = "40:10:4:LINE:IN"

    /** The server's six fields, so each test can vary one and leave the rest alone. */
    private fun sixPart(
        feet: String,
        corners: String,
        teardown: String,
        closed: String = "1"
    ) = points + "|" + gates + "|" + closed + "|" + feet + "|" + corners + "|" + teardown

    /**
     * A run that already looks like the snapshot's geometry, with nothing typed
     * on it -- the state a restore is usually returning a run to.
     */
    private fun runAsDrawn() = FenceRun(
        jobId = 7L,
        label = "Back yard",
        pointsEncoded = points,
        gatesEncoded = gates,
        closedLoop = true,
        manualLinearFeet = null,
        manualCornerCount = 0,
        isTeardown = false
    )

    // ---------------------------------------------------------------- six parts

    @Test
    fun `a six-part snapshot carries every column the fingerprint is taken on`() {
        val snap = parseRunSnapshot(sixPart(feet = "137.5", corners = "3", teardown = "1"))
        assertNotNull(snap)
        assertEquals(points, snap!!.drawing.pointsEncoded)
        assertEquals(gates, snap.drawing.gatesEncoded)
        assertTrue(snap.drawing.closedLoop)
        val typed = snap.typed
        assertNotNull("a six-part row records the typed takeoff", typed)
        assertEquals(137.5f, typed!!.manualLinearFeet)
        assertEquals(3, typed.manualCornerCount)
        assertTrue(typed.isTeardown)
    }

    @Test
    fun `a whole-number footage written by the database still reads as a figure`() {
        // The column is a double, so the server may write either 137.5 or a
        // bare 80. Refusing the bare form would take the restore away from
        // every run whose typed footage happens to be a round number.
        val typed = parseRunSnapshot(sixPart(feet = "80", corners = "4", teardown = "0"))!!.typed
        assertEquals(80f, typed!!.manualLinearFeet)
    }

    @Test
    fun `restoring writes the drawing and the typed takeoff, and nothing else on the run`() {
        // Asserted as a whole row rather than field by field: a restore that
        // also carried, say, the run's panel width or its label back would be
        // undoing edits nobody asked to undo, and only comparing the entire
        // run catches that.
        val run = runAsDrawn().copy(
            pointsEncoded = "0:0,50:0",
            gatesEncoded = "",
            closedLoop = false,
            manualLinearFeet = 42f,
            manualCornerCount = 1,
            isTeardown = false,
            panelWidthFt = 8f,
            label = "Back yard"
        )
        val snap = parseRunSnapshot(sixPart(feet = "137.5", corners = "3", teardown = "1"))!!
        val expected = run.copy(
            pointsEncoded = points,
            gatesEncoded = gates,
            closedLoop = true,
            manualLinearFeet = 137.5f,
            manualCornerCount = 3,
            isTeardown = true
        )
        assertEquals(expected, snap.appliedTo(run))
    }

    // ------------------------------------------------- empty is not zero

    @Test
    fun `an empty typed footage comes back as no figure, not as a figure of zero`() {
        // The server writes an empty field where the column was null, and the
        // app's own column is nullable for the same reason: a run whose length
        // is measured off the drawing is a different run from one somebody
        // typed a zero into. Read empty as 0 and the run comes back claiming a
        // typed measurement that was never taken -- the estimate screen then
        // shows a 0 in the typed-footage box, and the restore's own note on the
        // job feed announces typed footage going back to 0 ft.
        val typed = parseRunSnapshot(sixPart(feet = "", corners = "", teardown = "0"))!!.typed
        assertNotNull("an empty field is still a recorded field", typed)
        assertNull("no typed footage was recorded, so none is restored", typed!!.manualLinearFeet)
    }

    @Test
    fun `putting an untyped run back the way it was writes nothing at all`() {
        // The restore compares the run it would write against the run on disk
        // and skips the write when they match, because every write moves the
        // run's clock and the later clock wins a sync conflict -- so a pointless
        // write makes this phone's copy beat an office change that has not come
        // down yet. That comparison only comes out equal if an empty footage
        // field survives as null: a 0 here would make the run look changed and
        // provoke exactly that write.
        val run = runAsDrawn()
        val snap = parseRunSnapshot(sixPart(feet = "", corners = "", teardown = "0"))!!
        assertEquals(run, snap.appliedTo(run))
    }

    /**
     * Planted failure. If the parser ever reads an empty footage field as zero,
     * these two snapshots become the same object and this test fails -- which is
     * how a passing run of this class proves it could still fail.
     */
    @Test
    fun `an empty typed footage and a typed zero are not the same snapshot`() {
        val nothingTyped = parseRunSnapshot(sixPart(feet = "", corners = "", teardown = "0"))!!
        val zeroTyped = parseRunSnapshot(sixPart(feet = "0", corners = "0", teardown = "0"))!!
        assertNotEquals(nothingTyped, zeroTyped)
        assertNull(nothingTyped.typed!!.manualLinearFeet)
        assertEquals(0f, zeroTyped.typed!!.manualLinearFeet)
        // And the difference is a write: restoring the one onto a run with
        // nothing typed changes nothing, restoring the other changes the run.
        val run = runAsDrawn()
        assertEquals(run, nothingTyped.appliedTo(run))
        assertNotEquals(run, zeroTyped.appliedTo(run))
    }

    @Test
    fun `an empty corner count can only come back as nought, and that is safe`() {
        // Unlike the footage, the app's corner-count column is a plain integer
        // with no "nothing typed" value, so this one field genuinely cannot be
        // restored as absent. It does no harm: the corner count is read only
        // alongside a typed footage figure, so a nought here cannot turn a run
        // with nothing typed into one with something typed. Stated as a test so
        // the limit is on the record rather than assumed.
        val typed = parseRunSnapshot(sixPart(feet = "", corners = "", teardown = "0"))!!.typed
        assertEquals(0, typed!!.manualCornerCount)
    }

    // ------------------------------------------------- rows written before today

    @Test
    fun `a row written before the snapshot was widened restores the outline only`() {
        val snap = parseRunSnapshot(points + "|" + gates + "|1")
        assertNotNull("three parts is the old shape and must still be readable", snap)
        assertNull("nothing but the outline was ever recorded", snap!!.typed)
    }

    @Test
    fun `an outline-only restore leaves typed footage and the teardown flag alone`() {
        // It has no idea what they were. Writing a guess would be worse than
        // the weaker restore: the row on screen says only the outline was kept,
        // and this is what makes that true.
        val run = runAsDrawn().copy(
            pointsEncoded = "0:0,50:0",
            manualLinearFeet = 80f,
            manualCornerCount = 4,
            isTeardown = true
        )
        val snap = parseRunSnapshot(points + "|" + gates + "|1")!!
        val restored = snap.appliedTo(run)
        assertEquals(points, restored.pointsEncoded)
        assertEquals(gates, restored.gatesEncoded)
        assertTrue(restored.closedLoop)
        assertEquals(80f, restored.manualLinearFeet)
        assertEquals(4, restored.manualCornerCount)
        assertTrue(restored.isTeardown)
    }

    // ------------------------------------------------- an empty drawing is a drawing

    @Test
    fun `a snapshot of an empty but unfinished drawing is valid and clears the run`() {
        // A run that had nothing drawn on it yet is a real state to go back to,
        // so an empty geometry must not be mistaken for an unreadable row --
        // refusing it would take the restore away from exactly the withdrawal
        // caused by somebody drawing a fence where there had been none.
        val snap = parseRunSnapshot("||0|||0")
        assertNotNull(snap)
        assertEquals("", snap!!.drawing.pointsEncoded)
        assertEquals("", snap.drawing.gatesEncoded)
        assertFalse(snap.drawing.closedLoop)
        val restored = snap.appliedTo(runAsDrawn())
        assertEquals("", restored.pointsEncoded)
        assertEquals("", restored.gatesEncoded)
        assertFalse(restored.closedLoop)
    }

    @Test
    fun `an empty drawing recorded in the old three-part shape is valid too`() {
        val snap = parseRunSnapshot("||0")
        assertNotNull(snap)
        assertEquals("", snap!!.drawing.pointsEncoded)
        assertNull(snap.typed)
    }

    // ------------------------------------------------- everything else is refused

    @Test
    fun `a two-part snapshot is refused`() {
        // Three and six are the only shapes the server writes. Guessing at any
        // other would put a gate list into the point column and write it to the
        // job; the screen offers no way back for a row it cannot read instead.
        assertNull(parseRunSnapshot(points + "|" + gates))
    }

    @Test
    fun `a seven-part snapshot is refused`() {
        assertNull(parseRunSnapshot(sixPart(feet = "80", corners = "4", teardown = "0") + "|1"))
    }

    @Test
    fun `an empty snapshot is refused`() {
        // An empty column reads as one empty field, not as a drawing.
        assertNull(parseRunSnapshot(""))
    }

    @Test
    fun `a snapshot with no separators at all is refused`() {
        assertNull(parseRunSnapshot(points))
    }

    @Test
    fun `a flag the server would not have written is refused`() {
        // The server writes these two as 1 or 0. Anything else did not come
        // from it, and reading an unknown word as false would silently open a
        // closed loop -- which changes the footage, and the price with it.
        assertNull(parseRunSnapshot(sixPart(feet = "80", corners = "4", teardown = "0", closed = "true")))
        assertNull(parseRunSnapshot(sixPart(feet = "80", corners = "4", teardown = "yes")))
        assertNull(parseRunSnapshot(points + "|" + gates + "|X"))
    }

    @Test
    fun `a figure that will not parse is refused rather than half restored`() {
        // Half a restore is worse than none: the outline goes back, the typed
        // takeoff does not, and the run is now a mixture that was never
        // approved or quoted.
        assertNull(parseRunSnapshot(sixPart(feet = "eighty", corners = "4", teardown = "0")))
        assertNull(parseRunSnapshot(sixPart(feet = "80", corners = "4.5", teardown = "0")))
    }

    // ------------------------------------------------- why splitting on a bar is exact

    @Test
    fun `the app's own encoding never contains the bar the snapshot is split on`() {
        // The server joins the run's own stored strings with bars. That is only
        // unambiguous while neither string can contain one, so the encoders are
        // asked here: if a future field in a point or a gate ever used a bar,
        // every snapshot taken afterwards would split into the wrong number of
        // fields and every restore would be refused.
        val encodedPoints = FenceCodec.encodePoints(
            listOf(FencePoint(10f, 10f), FencePoint(10f, 120f), FencePoint(90f, 120f))
        )
        val encodedGates = FenceCodec.encodeGates(
            listOf(
                GateMarker(40f, 10f, 4f, GateMounting.LINE, GateSwing.IN),
                GateMarker(60f, 120f, 12f, GateMounting.LINE_TO_WALL, GateSwing.BOTH)
            )
        )
        assertFalse("points must not contain a bar: " + encodedPoints, encodedPoints.contains("|"))
        assertFalse("gates must not contain a bar: " + encodedGates, encodedGates.contains("|"))
        // And a snapshot built from them reads back as the same two strings.
        val snap = parseRunSnapshot(encodedPoints + "|" + encodedGates + "|0|||0")
        assertNotNull(snap)
        assertEquals(encodedPoints, snap!!.drawing.pointsEncoded)
        assertEquals(encodedGates, snap.drawing.gatesEncoded)
    }
}

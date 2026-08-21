package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Which way a gate opens has to survive being saved.
 *
 * Gates are stored as one packed string, and every gate already drawn was
 * written before swing existed. Refusing to read those, or dropping the field
 * silently, would lose the answer on every job already quoted.
 */
class GateSwingTest {

    @Test
    fun `swing survives a round trip`() {
        val gates = listOf(
            GateMarker(10f, 20f, 5f, GateMounting.LINE, GateSwing.OUT),
            GateMarker(30f, 40f, 16f, GateMounting.WALL, GateSwing.BOTH)
        )
        val read = FenceCodec.decodeGates(FenceCodec.encodeGates(gates))

        assertEquals(2, read.size)
        assertEquals(GateSwing.OUT, read[0].swing)
        assertEquals(GateSwing.BOTH, read[1].swing)
        assertEquals(GateMounting.WALL, read[1].mounting)
        assertEquals(16f, read[1].widthFt, 0.001f)
    }

    @Test
    fun `a gate saved before swing existed reads as inward`() {
        // The four-part form, written when mounting was the newest field.
        val old = "10.0:20.0:5.0:LINE"
        val read = FenceCodec.decodeGates(old)
        assertEquals(1, read.size)
        assertEquals(GateSwing.IN, read[0].swing)
        assertEquals(GateMounting.LINE, read[0].mounting)
    }

    @Test
    fun `the oldest three-part gates still read`() {
        // Written before mounting existed either. These are on real jobs.
        val ancient = "10.0:20.0:5.0"
        val read = FenceCodec.decodeGates(ancient)
        assertEquals(1, read.size)
        assertEquals(5f, read[0].widthFt, 0.001f)
        assertEquals(GateMounting.LINE, read[0].mounting)
        assertEquals(GateSwing.IN, read[0].swing)
    }

    @Test
    fun `an unreadable swing falls back rather than dropping the gate`() {
        // A value from a newer version, or a corrupted string. Losing the gate
        // entirely would be worse than losing which way it opens.
        val read = FenceCodec.decodeGates("10.0:20.0:5.0:LINE:SIDEWAYS")
        assertEquals(1, read.size)
        assertEquals(GateSwing.IN, read[0].swing)
    }
}

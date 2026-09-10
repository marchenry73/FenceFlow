package com.fenceestimator.app.estimate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The ordering behind the crew screen's one forward tap and smaller back tap.
 *
 * Getting an end wrong here is exactly the button doing nothing, or doing the
 * wrong thing, when a crew member taps it in a yard -- so every boundary
 * (not started, and DONE) gets its own case rather than trusting the middle
 * of the list to generalize.
 */
class ProductionStageTest {

    @Test
    fun `not started moves forward to materials`() {
        assertEquals("MATERIALS", ProductionStage.next(null))
    }

    @Test
    fun `forward walks the pipeline in order`() {
        assertEquals("DIG", ProductionStage.next("MATERIALS"))
        assertEquals("SET", ProductionStage.next("DIG"))
        assertEquals("BUILD", ProductionStage.next("SET"))
        assertEquals("PUNCH", ProductionStage.next("BUILD"))
        assertEquals("DONE", ProductionStage.next("PUNCH"))
    }

    @Test
    fun `done has nowhere further forward`() {
        assertNull(ProductionStage.next("DONE"))
    }

    @Test
    fun `back walks the pipeline in reverse`() {
        assertEquals("PUNCH", ProductionStage.previous("DONE"))
        assertEquals("BUILD", ProductionStage.previous("PUNCH"))
        assertEquals("SET", ProductionStage.previous("BUILD"))
        assertEquals("DIG", ProductionStage.previous("SET"))
        assertEquals("MATERIALS", ProductionStage.previous("DIG"))
    }

    @Test
    fun `materials has nowhere further back`() {
        assertNull(ProductionStage.previous("MATERIALS"))
    }

    @Test
    fun `not started has nowhere back either`() {
        assertNull(ProductionStage.previous(null))
    }

    @Test
    fun `an unrecognized stage name goes nowhere rather than guessing`() {
        assertNull(ProductionStage.next("BOGUS"))
        assertNull(ProductionStage.previous("BOGUS"))
    }
}

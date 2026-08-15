package com.fenceestimator.app.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The adopt-or-ignore rule from DraftTextField / DraftNumberField, pulled out
 * so it can be exercised without a device.
 *
 * This bug has now shown up three separate times -- a pricing tier rewriting a
 * rate, the covers-materials button setting a deposit, and the Request Payment
 * button filling in a link -- each time as "it saved but the box still shows
 * the old value". The rule itself is four lines; what it needs is proof it
 * adopts outside changes without fighting someone typing.
 */
private class DraftField<T>(initial: T) {
    var text: T = initial; private set
    private var lastPushed: T = initial
    private var focused = false

    fun focus() { focused = true }
    fun blur() { focused = false }

    /** The user typed. Typing implies the field has focus. */
    fun type(value: T) {
        focused = true
        text = value
        lastPushed = value
    }

    /** A new value arrived from upstream -- sync, a button, a pricing tier. */
    fun upstream(value: T) {
        if (!focused && value != lastPushed) {
            text = value
            lastPushed = value
        }
    }
}

class DraftFieldLogicTest {

    @Test
    fun `a button filling in a value shows up on screen`() {
        val field = DraftField("")
        field.upstream("https://buy.stripe.com/abc123")
        assertEquals("https://buy.stripe.com/abc123", field.text)
    }

    @Test
    fun `the echo of the user's own edit does not disturb them`() {
        val field = DraftField("")
        field.type("14 Oak")
        // The write lands and the flow re-emits what was just typed.
        field.upstream("14 Oak")
        assertEquals("14 Oak", field.text)
    }

    @Test
    fun `a stale echo arriving mid-type does not rewind the field`() {
        val field = DraftField("")
        field.type("1")
        field.type("14")
        field.type("14 Oak St")
        // A late echo of an earlier keystroke must not clobber what's there.
        field.upstream("14")
        assertEquals("14 Oak St", field.text)
    }

    @Test
    fun `a genuine outside change wins once the user has moved on`() {
        val field = DraftField(0f)
        field.type(20f)
        field.blur()
        // Covers-materials button sets it to 510.
        field.upstream(510f)
        assertEquals(510f, field.text)
    }

    @Test
    fun `an outside change never lands while the box is being typed in`() {
        val field = DraftField(0f)
        field.type(20f)
        field.upstream(510f)
        assertEquals("must not change under the user's fingers", 20f, field.text)
        // ...but it takes effect the moment they leave the box.
        field.blur()
        field.upstream(510f)
        assertEquals(510f, field.text)
    }

    @Test
    fun `numbers compare by value, so trailing decimals do not thrash`() {
        val field = DraftField(1.5f)
        field.type(1.5f)
        field.blur()
        field.upstream(1.50f)
        assertEquals(1.5f, field.text)
    }

    @Test
    fun `a pricing tier rewriting a rate reaches the screen`() {
        val field = DraftField(0f)
        field.upstream(12.5f)
        assertEquals(12.5f, field.text)
    }
}

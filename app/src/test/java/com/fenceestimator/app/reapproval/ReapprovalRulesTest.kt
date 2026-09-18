package com.fenceestimator.app.reapproval

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReapprovalRulesTest {

    @Test
    fun `null reapprovalRequiredAt does not need reapproval`() {
        assertFalse(needsReapproval(null))
    }

    @Test
    fun `set reapprovalRequiredAt needs reapproval`() {
        assertTrue(needsReapproval(1_700_000_000_000L))
    }

    @Test
    fun `warn before editing an approved job with no outstanding reapproval`() {
        assertTrue(shouldWarnBeforeEditingDrawing(quoteApprovedAt = 1L, reapprovalRequiredAt = null))
    }

    @Test
    fun `never approved job needs no warning`() {
        assertFalse(shouldWarnBeforeEditingDrawing(quoteApprovedAt = null, reapprovalRequiredAt = null))
    }

    // Planted-failure case: a job that already needs reapproval must not warn
    // again -- there is no live approval left for a second edit to withdraw.
    // If shouldWarnBeforeEditingDrawing ever drops the reapprovalRequiredAt
    // check, this starts failing.
    @Test
    fun `job already needing reapproval does not warn again`() {
        assertFalse(shouldWarnBeforeEditingDrawing(quoteApprovedAt = 1L, reapprovalRequiredAt = 2L))
    }
}

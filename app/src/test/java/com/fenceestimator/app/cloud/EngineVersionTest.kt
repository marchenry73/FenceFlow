package com.fenceestimator.app.cloud

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The office engine version is compared as numbers, not as a string. */
class EngineVersionTest {
    @Test fun `two-digit patch sorts after one-digit`() {
        assertTrue(engineVersionIsNewer("2026.09.10", "2026.09.9"))
        assertFalse(engineVersionIsNewer("2026.09.9", "2026.09.10"))
    }
    @Test fun `equal is not newer`() {
        assertFalse(engineVersionIsNewer("2026.09.1", "2026.09.1"))
    }
    @Test fun `missing components count as zero and junk does not throw`() {
        assertTrue(engineVersionIsNewer("2026.10", "2026.09.1"))
        assertFalse(engineVersionIsNewer("", "2026.09.1"))
        assertFalse(engineVersionIsNewer("garbage", "2026.09.1"))
    }
}

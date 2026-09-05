package com.fenceestimator.app.estimate.parity

import com.fenceestimator.app.estimate.EstimateEngine
import kotlinx.serialization.decodeFromString
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * Replays ONE fixture that was written from a real job's cloud rows by the
 * server engine (scripts/real-parity.ts) and asserts this engine reproduces
 * it exactly.
 *
 * The committed fixtures prove the two engines agree on invented cases. This
 * is for the day the office and a phone disagree about a customer's job:
 * export the rows, price them on the server, point this test at the file,
 * and the first divergent stage says whether the engines differ (a bug) or
 * the phone priced with different data (not a bug). Off unless
 * FENCEFLOW_REAL_FIXTURE names a file, so the ordinary suite never depends
 * on customer rows, and the file is never committed.
 */
class RealRowsParityCheck {

    @Test
    fun `the real rows replay exactly`() {
        val path = System.getenv("FENCEFLOW_REAL_FIXTURE").orEmpty()
        assumeTrue("FENCEFLOW_REAL_FIXTURE not set; nothing to replay", path.isNotBlank())
        val file = File(path)
        assumeTrue("no such fixture: $path", file.isFile)

        val fixture = ParityJson.decodeFromString<ParityFixture>(file.readText())
        if (fixture.engine.version != EstimateEngine.PRICING_ENGINE_VERSION) {
            fail("${fixture.case}: fixture engine ${fixture.engine.version} != ${EstimateEngine.PRICING_ENGINE_VERSION}")
        }
        val actual = PricingRunner.price(fixture.input)
        val divergence = ParityFixtureCheck.firstDivergence(fixture.expected, actual)
        if (divergence != null) {
            fail(
                "${fixture.case}: the phone engine does not reproduce the server on these rows.\n" +
                    "first divergent stage = $divergence\n" +
                    "server grand_total=${fixture.expected.totals.grandTotal} phone grand_total=${actual.totals.grandTotal}"
            )
        }
        println("${fixture.case}: phone == server, grand_total=${actual.totals.grandTotal}")
    }
}

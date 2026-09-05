package com.fenceestimator.app.estimate.parity

import com.fenceestimator.app.estimate.EstimateEngine
import kotlinx.serialization.encodeToString
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * Writes the golden fixtures -- but only when asked.
 *
 * Set FENCEFLOW_PARITY_OUT to a directory and run this test; without it the
 * test passes and writes nothing, so an ordinary test run never touches the
 * committed fixtures. Regenerating is a deliberate act that goes in the same
 * commit as the engine change that made it necessary.
 *
 *   FENCEFLOW_PARITY_OUT=$(pwd)/fixtures/pricing ./gradlew testDebugUnitTest --tests "*ParityFixtureWriter*"
 */
class ParityFixtureWriter {

    @Test
    fun writeFixturesWhenAsked() {
        val requested = System.getenv("FENCEFLOW_PARITY_OUT")
        if (requested.isNullOrBlank()) {
            println("ParityFixtureWriter: FENCEFLOW_PARITY_OUT is not set; nothing written.")
            return
        }
        val dir = File(windowsPath(requested)).absoluteFile
        dir.mkdirs()
        require(dir.isDirectory) { "FENCEFLOW_PARITY_OUT is not a directory: $dir" }

        // Whatever was there is the previous set. A case that was removed must
        // not linger as a stale file the check would then replay.
        dir.listFiles { f -> f.isFile && f.name.endsWith(".json") }?.forEach { it.delete() }

        val cases = ParityCases.all()
        val generatedAt = Instant.now().toString()
        cases.forEach { case ->
            val expected = PricingRunner.price(case.input)
            // The engine has no clock, no randomness and no set iteration in
            // it; a second run must agree with the first or the fixture is
            // worthless as a pin.
            assertEquals("case ${case.id} did not price the same way twice", expected, PricingRunner.price(case.input))
            val fixture = ParityFixture(
                schema = 1,
                engine = FixtureEngine(EstimateEngine.PRICING_ENGINE_VERSION, generatedAt),
                case = case.id,
                note = case.note,
                input = case.input,
                expected = expected
            )
            File(dir, "${case.id}.json").writeText(ParityJson.encodeToString(fixture) + "\n", Charsets.UTF_8)
        }
        val manifest = ParityManifest(EstimateEngine.PRICING_ENGINE_VERSION, generatedAt, cases.size)
        File(dir, "manifest.json").writeText(ParityJson.encodeToString(manifest) + "\n", Charsets.UTF_8)
        println("ParityFixtureWriter: wrote ${cases.size} fixtures and manifest.json to $dir")
    }

    /**
     * Git Bash hands `$(pwd)` over as /c/Users/..., which the JVM would read
     * as C:\c\Users\... Turn that spelling back into a Windows path; anything
     * else passes through untouched.
     */
    private fun windowsPath(raw: String): String {
        val m = Regex("^/([A-Za-z])/(.*)$").find(raw) ?: return raw
        return "${m.groupValues[1].uppercase()}:/${m.groupValues[2]}"
    }
}

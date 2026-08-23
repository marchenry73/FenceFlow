package com.fenceestimator.app

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every string resource must survive String.format.
 *
 * A merge script once turned an escaped %% into %%% across eleven strings,
 * and the first place it crashed was the update dialog -- so the phones that
 * needed the fixed build were the ones that could no longer download it.
 * Nothing in the build checks resource format validity; this does.
 */
class StringResourceSanityTest {

    private fun resourceFiles(): List<File> {
        // Unit tests usually run with the module as the working directory;
        // fall back to the repo layout when run from the root.
        val bases = listOf(File("src/main/res"), File("app/src/main/res"))
        val res = bases.firstOrNull { it.isDirectory }
            ?: error("could not locate src/main/res from ${File(".").absolutePath}")
        return listOf("values", "values-es", "values-fr").map { File(res, "$it/strings.xml") }
    }

    private fun strings(file: File): List<Pair<String, String>> =
        Regex("<string name=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</string>")
            .findAll(file.readText())
            .map { it.groupValues[1] to it.groupValues[2] }
            .toList()

    private val positional = Regex("%\\d+\\$[sdf]")

    @Test
    fun `no string carries a tripled percent`() {
        val offenders = resourceFiles().flatMap { f ->
            strings(f).filter { (_, body) -> body.contains("%%%") }
                .map { (name, _) -> "${f.parentFile.name}/$name" }
        }
        assertTrue("tripled %% in: $offenders", offenders.isEmpty())
    }

    @Test
    fun `formatted strings never end in a bare percent`() {
        val offenders = resourceFiles().flatMap { f ->
            strings(f).filter { (_, body) ->
                positional.containsMatchIn(body) &&
                    // Strip valid escapes and placeholders; any % left is bare.
                    body.replace("%%", "").replace(positional, "").contains("%")
            }.map { (name, _) -> "${f.parentFile.name}/$name" }
        }
        assertTrue("bare % in formatted strings: $offenders", offenders.isEmpty())
    }

    @Test
    fun `unformatted strings do not carry escaped percents`() {
        // %% only means something to String.format; a string read without
        // args shows it literally as two characters.
        val offenders = resourceFiles().flatMap { f ->
            strings(f).filter { (_, body) ->
                !positional.containsMatchIn(body) && body.contains("%%")
            }.map { (name, _) -> "${f.parentFile.name}/$name" }
        }
        assertTrue("%% in no-arg strings (displays literally): $offenders", offenders.isEmpty())
    }

    @Test
    fun `every language carries the same keys`() {
        val files = resourceFiles()
        val en = strings(files[0]).map { it.first }.toSet() - "app_name"
        for (f in files.drop(1)) {
            val lang = strings(f).map { it.first }.toSet()
            val missing = en - lang
            assertTrue("${f.parentFile.name} missing: $missing", missing.isEmpty())
        }
    }
}

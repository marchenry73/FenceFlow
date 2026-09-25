package com.fenceestimator.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
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
    fun `every language carries exactly the same keys`() {
        // Strict equality, both directions: values, values-es and values-fr
        // must have identical key sets. app_name is untranslated content
        // (translatable="false") but it still has to exist in all three, or
        // a lookup by key in the non-default locale throws at runtime.
        val files = resourceFiles()
        val base = strings(files[0]).map { it.first }.toSet()
        for (f in files.drop(1)) {
            val lang = strings(f).map { it.first }.toSet()
            val missing = base - lang
            val extra = lang - base
            assertTrue(
                "${f.parentFile.name} missing: $missing, extra: $extra",
                missing.isEmpty() && extra.isEmpty()
            )
        }
    }

    /**
     * The format arguments one string takes: each numbered placeholder exactly
     * as written, plus any un-numbered one.
     *
     * A set rather than a list, because a translation is free to reorder the
     * sentence or to use the same argument twice and neither breaks formatting.
     * What breaks it is an argument that is missing, one that moved to a
     * different number, or one whose conversion changed.
     *
     * Built from the same pattern the other checks here use, so the two cannot
     * come to disagree about what counts as a placeholder.
     */
    private fun formatArgs(body: String): Set<String> {
        val args = mutableSetOf<String>()
        positional.findAll(body).forEach { args += it.value }
        // Whatever is left once escaped percents and numbered placeholders are
        // gone. An un-numbered %s consumes an argument too, and it consumes
        // them in the order it meets them, so trading one form for the other
        // reorders the sentence's values instead of crashing.
        val rest = body.replace("%%", "").replace(positional, "")
        Regex("%[sdf]").findAll(rest).forEach { args += it.value }
        return args
    }

    @Test
    fun `every language takes the same format arguments`() {
        // A locale that drops a placeholder, renumbers one, or turns a %1$s
        // into a %1$d throws at format time -- in that language only, on a
        // customer's phone, at the moment the screen appears. Nothing in the
        // build compares them: lint checks a string against the call that
        // formats it, not the three translations against each other.
        //
        // A key that is missing from English is the key-parity check's business,
        // not this one's, so it is passed over here rather than reported twice.
        val files = resourceFiles()
        val english = strings(files[0]).toMap()
        val offenders = files.drop(1).flatMap { f ->
            strings(f).mapNotNull { (name, body) ->
                val want = formatArgs(english[name] ?: return@mapNotNull null)
                val got = formatArgs(body)
                if (want == got) null
                else f.parentFile.name + "/" + name + ": en " + want.sorted() + " vs " + got.sorted()
            }
        }
        assertTrue("format arguments differ between languages: " + offenders, offenders.isEmpty())
    }

    @Test
    fun `the argument comparison can tell a faithful translation from a broken one`() {
        // Positive control for the check above. A comparison blind to any of
        // these would report all three files clean while a locale was one
        // format call away from crashing -- which is how there came to be no
        // such check for as long as there wasn't one.
        val english = "%1\$s owes %2\$d"
        assertEquals("word order is a translator's business", formatArgs(english), formatArgs("%2\$d owed by %1\$s"))
        assertNotEquals("a dropped argument", formatArgs(english), formatArgs("%1\$s doit"))
        assertNotEquals("a renumbered argument", formatArgs(english), formatArgs("%2\$s doit %1\$d"))
        assertNotEquals("a retyped argument", formatArgs(english), formatArgs("%1\$s doit %2\$s"))
        assertNotEquals("an un-numbered argument", formatArgs(english), formatArgs("%s doit %d"))
        assertTrue("an escaped percent takes no argument", formatArgs("100%% sure").isEmpty())
    }
}

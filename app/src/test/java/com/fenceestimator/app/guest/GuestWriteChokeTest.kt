package com.fenceestimator.app.guest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * Proves the repository-wide guest write gate from three angles, because
 * none of the three alone would be trustworthy on its own:
 *
 * 1. [GuestWriteGuard.check] itself -- the real, unmodified class this wave
 *    ships -- run directly against plain booleans. That is deliberately ALL
 *    Repository.guardWrite hands off to (see GuestWriteGuard's own doc for
 *    why), so a real JUnit run of these first few tests genuinely exercises
 *    the exact code every gated write in Repository calls before it runs --
 *    unlike the source-text checks further down, which can only prove a call
 *    SITE exists, never that the function it calls behaves correctly.
 *
 * 2. Repository.kt's own source, read as text, for what #1 cannot see: that
 *    createJob, deleteJobLocallyOnly, saveLineItem and the shared
 *    deleteSynced choke point actually CALL guardWrite / key their bypass on
 *    GuestMarker the way this wave's report claims, and that GuestSeeder,
 *    GuestWipe and MainActivity's own source still has the shape that
 *    reasoning depends on. Same technique CrewSaveJobRefusalTest and
 *    PushChildTableIsolationTest already use in this codebase, for the same
 *    underlying reason stated plainly: **Repository cannot be constructed in
 *    this module's tests.** `app/src/test` has neither Robolectric nor the
 *    Room testing artifact on its classpath (see app/build.gradle's
 *    testImplementation list -- plain `junit:junit` only), so there is no
 *    Android SQLite underneath a JVM unit test here, `AppDatabase.getInstance`
 *    cannot produce a real database, and a test that pretended otherwise
 *    would either not compile or silently test nothing. Nothing in this file
 *    constructs a Repository or an AppDatabase; every assertion below is
 *    either pure-logic-on-the-real-guard or a read of real source text.
 *
 * 3. The whole app's source, read as text, for what #1 and #2 both take as a
 *    GIVEN and neither one checks: that [Repository.isGuestSession] -- the
 *    single value #1's `guestActive` stands in for and #2 assumes is wired
 *    -- is ever actually assigned anything other than its own `false`
 *    default. As of this wave it is not, anywhere, which makes every write
 *    #2 proves is gated a write that is gated in shape only: `guardWrite`
 *    runs, `check` runs, and `check` can never see `guestActive = true` in
 *    production because nothing ever sets it. `isGuestSession is declared
 *    but deliberately assigned nowhere in the app` below is that check. See
 *    [GuestWriteGuard]'s own class doc, STATUS section, for the full
 *    reasoning this test exists to pin.
 *
 * PROVING THESE TESTS HAVE TEETH. This wave's own rules forbid running
 * `./gradlew test` here -- two other tracks are mid-edit on Kotlin the build
 * would compile, and the gate compiles once, at the end, for everyone. So the
 * red/green proof below was taken OUTSIDE Gradle entirely, against the real
 * file:
 *
 *   1. GuestWriteGuard.kt copied verbatim to a scratch directory, alongside a
 *      tiny Harness.kt exercising the same four cases the first three @Test
 *      methods below assert (guest refused, signed-in succeeds with or
 *      without bypass, the named bypass gets through while guest-active).
 *   2. Built and run with the Kotlin compiler bundled inside Android Studio
 *      (plugins/Kotlin/kotlinc) and a plain `java` invocation -- touching no
 *      Gradle daemon, no app/build output, no file this wave owns.
 *   3. Green, all five checks, against the unmodified GuestWriteGuard.kt.
 *   4. The single line `if (guestActive && !bypass) throw Refused(operation)`
 *      was then commented out in that SCRATCH COPY ONLY, recompiled and rerun:
 *      `guest write is refused` (and the operation-name check nested in its
 *      catch block) went red, the other three stayed green, process exit
 *      code 1.
 *   5. The scratch copy was discarded without ever being used to replace
 *      anything; `diff` against the real, checked-in GuestWriteGuard.kt
 *      confirmed it was untouched throughout.
 *
 * That is real evidence that removing the guard turns this suite red, taken
 * against the actual shipped file -- just not taken through the test runner
 * these tests will eventually run under, because that runner was unavailable
 * this wave by the wave's own rule, not by choice.
 *
 * THE SAME PROOF, SEPARATELY, FOR ANGLE #3 -- because a check that can never
 * fail is worth nothing no matter how reasonable it looks (see
 * `isGuestSession is declared but deliberately assigned nowhere in the app`
 * below for the check itself):
 *
 *   1. Its exact scanning logic (strip `/* */` and `//` comments out of every
 *      `.kt` file under a root, then regex `isGuestSession\s*=(?!=)` -- an
 *      assignment, not the `: Boolean =` typed declaration and not `==` --
 *      over what is left) was pulled into a standalone Harness.kt with a
 *      `main` and compiled with the same bundled kotlinc as above.
 *   2. Run against the real `app/src/main/java` tree: PASS, zero hits --
 *      including past the two places this very wave's rewrite of
 *      GuestWriteGuard.kt's doc comment contains the literal text
 *      `isGuestSession =` (the STATUS section's prose and its Kotlin-shaped
 *      example line), which a cruder check would have mistaken for a real
 *      assignment. That near-miss is exactly why the comment-stripping step
 *      exists rather than a bare regex over raw source.
 *   3. A SCRATCH COPY of GuestWriteGuard.kt, Repository.kt and
 *      FenceEstimatorApp.kt (only), with one line added to the copy of the
 *      last file -- `repository.isGuestSession = it.isGuestDemo`, real code,
 *      inside its existing `session.state.collect { ... }` block, exactly
 *      the wiring STATUS describes as the one line that would arm this --
 *      was run through the same harness: FAIL, one hit, naming that exact
 *      file, line and text.
 *   4. The scratch copy was discarded without ever being used to replace
 *      anything; nothing under `app/` was touched by this proof.
 *
 * So the test below is known, today, to (a) pass against the real, current,
 * unarmed app and (b) turn red the moment the one line that arms this guard
 * is added anywhere the harness can see it -- not just in Repository.kt.
 */
class GuestWriteChokeTest {

    // ---- 1. GuestWriteGuard itself, real and unmodified ------------------

    @Test
    fun `a guest write with no bypass is refused`() {
        try {
            GuestWriteGuard.check("createJob", guestActive = true, bypass = false)
            fail("expected GuestWriteGuard.Refused")
        } catch (e: GuestWriteGuard.Refused) {
            assertEquals("createJob", e.operation)
        }
    }

    @Test
    fun `the same write succeeds for a signed-in user`() {
        // isGuestSession is DESIGNED to mirror GuestSession.isActive -- it
        // does not yet, nothing assigns it (see angle #3 below) -- but this
        // case holds either way: a signed-in real user is false for it by
        // construction once wired (GuestWipe's own doc is explicit that a
        // signed-in phone and an active guest demo never coexist), and today
        // it is false for literally everyone, signed in or not. guestActive
        // = false IS the signed-in case, bypass or not, regardless of wiring.
        GuestWriteGuard.check("createJob", guestActive = false, bypass = false)
        GuestWriteGuard.check("createJob", guestActive = false, bypass = true)
    }

    @Test
    fun `the seeder's and the wipe's named bypass gets through while guest-active`() {
        // The exact shape Repository.createJob and Repository.
        // deleteJobLocallyOnly rely on: bypass = true only when the row
        // already carries GuestMarker's own two markers.
        GuestWriteGuard.check("createJob", guestActive = true, bypass = true)
        GuestWriteGuard.check("deleteJobLocallyOnly", guestActive = true, bypass = true)
    }

    // ---- 2. Repository.kt's own source: the wiring the booleans above need ----

    private fun repositorySource(): String =
        File("src/main/java/com/fenceestimator/app/data/Repository.kt").readText()

    private fun windowAfter(source: String, marker: String, chars: Int, notFoundMessage: String): String {
        val start = source.indexOf(marker)
        assertTrue(notFoundMessage, start >= 0)
        return source.substring(start, minOf(start + chars, source.length))
    }

    @Test
    fun `createJob is gated and its bypass is keyed on GuestMarker, not a broad flag`() {
        val body = windowAfter(
            repositorySource(), "suspend fun createJob(job: Job): Long", 200,
            "Repository.createJob not found -- has it been renamed or moved?"
        )
        assertTrue("createJob no longer calls guardWrite", body.contains("guardWrite("))
        assertTrue(
            "createJob's bypass is no longer keyed on GuestMarker.isGuestSeeded -- a " +
                "broader bypass here would let a guest's OWN job creations through too, " +
                "which is exactly the write this whole wave exists to refuse",
            body.contains("bypass = GuestMarker.isGuestSeeded(job)")
        )
    }

    @Test
    fun `deleteJobLocallyOnly -- the wipe's own delete -- is gated with the same named bypass`() {
        val body = windowAfter(
            repositorySource(), "suspend fun deleteJobLocallyOnly(job: Job)", 200,
            "Repository.deleteJobLocallyOnly not found -- has it been renamed or moved?"
        )
        assertTrue("deleteJobLocallyOnly no longer calls guardWrite", body.contains("guardWrite("))
        assertTrue(
            "deleteJobLocallyOnly's bypass is no longer GuestMarker.isGuestSeeded -- " +
                "without it GuestWipe's own delete would be refused, because it runs " +
                "WHILE the guest flag is still set (see GuestWipe.clearDemo's own doc " +
                "for why the rows are deleted before the flag is cleared)",
            body.contains("bypass = GuestMarker.isGuestSeeded(job)")
        )
    }

    @Test
    fun `saveLineItem is gated with NO content-based bypass`() {
        val body = windowAfter(
            repositorySource(), "suspend fun saveLineItem(item: EstimateLineItem): Long", 200,
            "Repository.saveLineItem not found -- has it been renamed or moved?"
        )
        assertTrue("saveLineItem no longer calls guardWrite", body.contains("guardWrite("))
        assertTrue(
            "saveLineItem must not gain a job-marker bypass: an EstimateLineItem carries " +
                "no marker of its own, only a jobId, so keying a bypass on the PARENT job " +
                "being guest-seeded would also let a guest's own later 'add line item' tap " +
                "on one of the three sample jobs through -- see this wave's report",
            !body.contains("GuestMarker")
        )
    }

    @Test
    fun `the shared delete choke point behind eleven deletes is gated exactly once`() {
        val body = windowAfter(
            repositorySource(), "private suspend fun deleteSynced(", 320,
            "Repository.deleteSynced not found -- has the shared delete helper been removed?"
        )
        assertTrue("deleteSynced no longer calls guardWrite", body.contains("guardWrite("))
    }

    @Test
    fun `guardWrite actually covers a real fraction of the file's writes, not a token gesture`() {
        val calls = Regex("guardWrite\\(").findAll(repositorySource()).count()
        // 52 real call sites as of this wave (1 definition line excluded by
        // the regex matching the call, not the `fun` declaration -- this
        // counts invocations). Floored well below that so an unrelated
        // future edit does not make this flaky, but high enough that a
        // revert stripping most of the gating trips it.
        assertTrue(
            "only $calls guardWrite( call sites found in Repository.kt -- the gate may have been stripped back down",
            calls >= 40
        )
    }

    // ---- The seeder and the wipe, unmodified, still reach the gated methods ----

    @Test
    fun `GuestSeeder still writes through the gated createJob and saveLineItem`() {
        val source = File("src/main/java/com/fenceestimator/app/guest/GuestSeeder.kt").readText()
        assertTrue("GuestSeeder no longer calls repository.createJob(", source.contains("repository.createJob("))
        assertTrue("GuestSeeder no longer calls repository.saveLineItem(", source.contains("repository.saveLineItem("))
    }

    @Test
    fun `GuestWipe still deletes through the gated deleteJobLocallyOnly`() {
        val source = File("src/main/java/com/fenceestimator/app/guest/GuestWipe.kt").readText()
        assertTrue(
            "GuestWipe no longer calls repository.deleteJobLocallyOnly( -- its named " +
                "bypass in Repository would then be dead code protecting nothing",
            source.contains("repository.deleteJobLocallyOnly(")
        )
    }

    @Test
    fun `the seeder still runs before the guest flag is set -- why it needs no bypass at all`() {
        val source = File("src/main/java/com/fenceestimator/app/MainActivity.kt").readText()
        val seed = source.indexOf("GuestSeeder.seed(")
        val flag = source.indexOf("startGuestSession(")
        assertTrue("GuestSeeder.seed( no longer called from MainActivity", seed >= 0)
        assertTrue("startGuestSession( no longer called from MainActivity", flag >= 0)
        // NOTE ON WHAT THIS DOES AND DOES NOT PROVE, given
        // `isGuestSession is declared but deliberately assigned nowhere in
        // the app` below: `startGuestSession(` here is
        // `SettingsStore.startGuestSession`, a persisted profile flag --
        // not `Repository.isGuestSession`, which nothing in MainActivity
        // touches at all. So today `isGuestSession` reads false for the
        // whole seed pass regardless of this ordering, for the much blunter
        // reason that it reads false always. This ordering is what would
        // make the seeder's own inserts safe WITHOUT a bypass on the day
        // isGuestSession is actually wired to follow this same flag (see
        // GuestWriteGuard's STATUS section) -- a design-intent guarantee
        // worth pinning now, not a claim that the guard reads it today.
        assertTrue(
            "the seed call now runs AFTER the guest flag is set -- once isGuestSession is " +
                "actually wired (it is not today), Repository.createJob and " +
                "Repository.saveLineItem's docs both explain that this ordering is what " +
                "would keep it reading false for the whole seed pass; createJob's " +
                "GuestMarker bypass covers the seeder either way, but saveLineItem has " +
                "none, so if this ordering ever flips, saveLineItem must gain one before " +
                "both this line and isGuestSession's own wiring can be considered safe",
            seed < flag
        )
    }

    // ---- 3. Repository.isGuestSession itself: is it actually wired? ----------

    @Test
    fun `isGuestSession is declared but deliberately assigned nowhere in the app`() {
        // See this class's own doc, angle #3 and its proof section, for the
        // standalone kotlinc run that exercised this exact logic against the
        // real tree (PASS) and against a scratch copy with the one arming
        // line added to FenceEstimatorApp.kt (FAIL, catching it) before this
        // was ever trusted inside a JUnit method. And see
        // GuestWriteGuard's class doc, STATUS section, for why nothing here
        // should be "fixed" by adding that line without reading it first.
        //
        // An assignment is `isGuestSession` then optional whitespace then a
        // single `=` -- NOT `==` (a comparison) and NOT `: Boolean = false`
        // (the property's own declaration, which has a type annotation
        // between the name and the `=` and so never matches this pattern).
        // Comments are stripped first specifically because this file's own
        // GuestWriteGuard.kt rewrite quotes that declaration and shows the
        // one arming line as an EXAMPLE inside its class doc -- text a naive
        // scan of raw source would misread as the wiring this test exists to
        // prove absent.
        val assignment = Regex("""isGuestSession\s*=(?!=)""")
        val root = File("src/main/java")
        assertTrue(
            "app/src/main/java not found from the test's working directory -- has the " +
                "module layout changed under this test?",
            root.exists()
        )
        val hits = mutableListOf<String>()
        root.walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach { file ->
            val stripped = Regex("/\\*.*?\\*/", setOf(RegexOption.DOT_MATCHES_ALL))
                .replace(file.readText(), "")
                .lineSequence()
                .joinToString("\n") { line -> line.substringBefore("//") }
            stripped.lineSequence().forEachIndexed { i, line ->
                if (assignment.containsMatchIn(line)) hits += "${file.path}:${i + 1}: ${line.trim()}"
            }
        }
        assertTrue(
            "expected ZERO real assignments to isGuestSession anywhere under app/src/main/java " +
                "-- today this codebase declares it, reads it in Repository.guardWrite, and " +
                "assigns it NOWHERE, which is the entire reason GuestWriteGuard is wired but " +
                "inert (see its class doc's STATUS section). If this now finds one, that is " +
                "someone wiring it -- which is a deliberate, owner-level decision, not a bug " +
                "fix, and needs the silent-swallow-vs-crash question that STATUS section raises " +
                "for the view models answered FIRST. Found:\n" + hits.joinToString("\n"),
            hits.isEmpty()
        )
    }
}

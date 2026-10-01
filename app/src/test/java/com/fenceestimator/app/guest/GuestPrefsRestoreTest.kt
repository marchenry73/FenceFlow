package com.fenceestimator.app.guest

import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import com.fenceestimator.app.data.AppLanguage
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.SettingsStore
import com.fenceestimator.app.data.ThemeMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A guest demo must give back the theme and language it found.
 *
 * A visitor may change both while trying the product, and both are stored on the
 * handset -- not in the sample company the demo wipe deletes -- so before this
 * they stayed changed for good: somebody could leave the owner's phone in Spanish
 * or dark mode and it would stay that way.
 *
 * SettingsStore keeps the phone's original pair in the same write that starts the
 * countdown, and gives it back in the same write that ends it. A demo ends three
 * ways, each covered here by running the real body of the function it ends in on
 * a plain MutablePreferences (no phone needed, the same way DevicePrefsWriteTest
 * runs the personal-settings writer):
 *
 *   1. the countdown running out   -> GuestWipe.wipeIfDue      -> endGuestSession   -> endDemoPrefs
 *   2. a real sign-in mid-demo     -> GuestWipe.wipeOnSignIn   -> endGuestSession   -> endDemoPrefs
 *   3. a real sign-in mid-demo, the account-change wipe getting there first
 *                                  -> DataOwnership.wipeEverything -> clearAll      -> clearAllPrefs
 *
 * Paths 1 and 2 share endDemoPrefs; that GuestWipe really reaches it, and that the
 * three SettingsStore entry points really are these bodies, is the last section,
 * which reads the source the way GuestWriteChokeTest does. The same wiring is
 * checked statement by statement in tests/a25-prefs-guest-demo-restore.test.mjs.
 *
 * Key names are spelled out rather than borrowed, because SettingsStore's Keys
 * object is private -- and because renaming one forgets what is stored on every
 * phone, including a demo that is running across an update.
 */
class GuestPrefsRestoreTest {

    private val theme = stringPreferencesKey("theme_mode")
    private val language = stringPreferencesKey("language")
    private val autoLock = intPreferencesKey("auto_lock_minutes")
    private val biometric = booleanPreferencesKey("biometric_unlock")
    private val flag = longPreferencesKey("guest_session_started_at")
    private val updatedAt = longPreferencesKey("settings_updated_at")
    private val businessName = stringPreferencesKey("business_name")
    private val lastEmail = stringPreferencesKey("last_sign_in_email")
    private val copyTaken = booleanPreferencesKey("guest_demo_prev_taken")
    private val copyTheme = stringPreferencesKey("guest_demo_prev_theme_mode")
    private val copyLanguage = stringPreferencesKey("guest_demo_prev_language")

    private val copyKeys = setOf("guest_demo_prev_taken", "guest_demo_prev_theme_mode", "guest_demo_prev_language")

    private val t0 = 1_758_200_000_000L

    // ------------------------------------------------------------------ fixtures

    /** A phone somebody chose a theme and language on before ever using the demo. */
    private fun chosen(themeName: String? = "LIGHT", languageName: String? = "SPANISH"): MutablePreferences =
        mutablePreferencesOf().apply {
            themeName?.let { this[theme] = it }
            languageName?.let { this[language] = it }
        }

    /**
     * A phone that has real settings on it, so "nothing else moved" is a claim
     * about something. Company fields, the settings clock, the remembered
     * address, and the two device choices set to something the visitor's values
     * below are not.
     */
    private fun usedPhone(): MutablePreferences = chosen("LIGHT", "SPANISH").apply {
        this[businessName] = "Hernandez Fence Co"
        this[doublePreferencesKey("markup")] = 22.5
        this[doublePreferencesKey("tax_rate")] = 8.25
        this[stringPreferencesKey("order_template")] = "Hola, necesitamos los materiales..."
        this[booleanPreferencesKey("seen_tour")] = true
        this[stringPreferencesKey("square_token")] = "kept-as-typed"
        this[lastEmail] = "owner@example.com"
        this[updatedAt] = t0 - 86_400_000L
        this[autoLock] = 5
        this[biometric] = true
    }

    /** What a visitor does: picks dark and French. Auto-lock and fingerprint are held, as the personal screen holds them. */
    private fun visitorChanges(p: MutablePreferences) =
        SettingsStore.writeDevicePrefs(p, ThemeMode.DARK, AppLanguage.FRENCH, p[autoLock] ?: 0, p[biometric] ?: false)

    private fun begin(p: MutablePreferences, at: Long = t0) = SettingsStore.beginDemoPrefs(p, at)
    private fun end(p: MutablePreferences) = SettingsStore.endDemoPrefs(p)
    private fun wipe(p: MutablePreferences) = SettingsStore.clearAllPrefs(p)

    /** The app closing and reopening: nothing survives except what is in the preferences themselves. */
    private fun restart(p: MutablePreferences): MutablePreferences = p.toPreferences().toMutablePreferences()

    private fun snapshot(p: Preferences): Map<String, Any> = p.asMap().entries.associate { it.key.name to it.value }

    private fun changed(before: Map<String, Any>, after: Map<String, Any>): Set<String> =
        (before.keys + after.keys).filter { before[it] != after[it] }.toSet()

    /** The way SettingsStore.profile reads them, so a value that would read back wrong is caught. */
    private fun themeRead(p: Preferences): ThemeMode =
        runCatching { ThemeMode.valueOf(p[theme] ?: "") }.getOrDefault(ThemeMode.SYSTEM)

    private fun languageRead(p: Preferences): AppLanguage =
        runCatching { AppLanguage.valueOf(p[language] ?: "") }.getOrDefault(AppLanguage.ENGLISH)

    private fun copyIsThere(p: Preferences): Boolean = snapshot(p).keys.any { it in copyKeys }

    // ---------------------------------------------------- 1 and 2: endGuestSession

    // The round trip, written once and run against the real ender and against
    // broken ones below, so the checker itself is shown to be able to fail.
    private fun checkRoundTrip(endWith: (MutablePreferences) -> Unit) {
        val prefs = chosen("LIGHT", "SPANISH")
        begin(prefs)
        visitorChanges(prefs)

        // Control: the visitor's change really landed, so "back to the original"
        // below is not passing on a phone that never moved.
        assertEquals("DARK", prefs[theme])
        assertEquals("FRENCH", prefs[language])

        endWith(prefs)

        assertEquals("theme was not given back", "LIGHT", prefs[theme])
        assertEquals("language was not given back", "SPANISH", prefs[language])
        assertEquals(ThemeMode.LIGHT, themeRead(prefs))
        assertEquals(AppLanguage.SPANISH, languageRead(prefs))
        assertEquals("the countdown is still set", 0L, prefs[flag] ?: 0L)
        assertFalse("the copy is still there after being given back: ${snapshot(prefs).keys}", copyIsThere(prefs))

        // The copy is spent. Somebody now chooses for themselves, and a second
        // end -- the countdown and a sign-in can both end the same demo -- must
        // leave that alone.
        SettingsStore.writeDevicePrefs(prefs, ThemeMode.DARK, AppLanguage.FRENCH, 0, false)
        endWith(prefs)
        assertEquals("a second end put the old theme over a later choice", "DARK", prefs[theme])
        assertEquals("a second end put the old language over a later choice", "FRENCH", prefs[language])
    }

    @Test
    fun `the countdown ending gives back the original theme and language`() {
        checkRoundTrip { end(it) }
    }

    @Test
    fun `a sign-in ending the demo gives them back through the same write`() {
        // GuestWipe.wipeOnSignIn reaches endGuestSession exactly as wipeIfDue does,
        // so the store-level body is the same one. What differs is when it runs:
        // with a real account already signed in, on a phone whose settings the
        // sign-in has just been touching. Run it there.
        val prefs = usedPhone()
        begin(prefs)
        visitorChanges(prefs)
        // The sign-in pulls the company's settings down. That is a cloud-sourced
        // write of a profile read before the visitor's change landed.
        SettingsStore.writeProfile(
            prefs,
            BusinessProfile(businessName = "Hernandez Fence Co", defaultMarkupPercent = 31.0, updatedAt = t0),
            fromCloud = true
        )
        end(prefs)

        assertEquals("LIGHT", prefs[theme])
        assertEquals("SPANISH", prefs[language])
        // What the sign-in brought is the owner's, and is still there.
        assertEquals("Hernandez Fence Co", prefs[businessName])
        assertEquals(31.0, prefs[doublePreferencesKey("markup")]!!, 0.0)
        assertEquals(t0, prefs[updatedAt])
    }

    @Test
    fun `only the two choices, the countdown and the copy ever move`() {
        val prefs = usedPhone()
        val before = snapshot(prefs)
        begin(prefs)
        visitorChanges(prefs)
        end(prefs)
        // Every other key on the phone -- company fields, the settings clock, the
        // remembered address, auto-lock, fingerprint -- is exactly as it was. The
        // one difference from before the demo is that the countdown key now reads
        // zero instead of being absent.
        assertEquals(setOf("guest_session_started_at"), changed(before, snapshot(prefs)))
        assertEquals(0L, prefs[flag])
    }

    // --------------------------------------------- 3: the account-change wipe

    @Test
    fun `the account-change wipe gives them back too, and is otherwise a wipe`() {
        val prefs = usedPhone()
        begin(prefs)
        visitorChanges(prefs)
        wipe(prefs)

        assertEquals("LIGHT", prefs[theme])
        assertEquals("SPANISH", prefs[language])
        // Everything else was wiped, as before, except the remembered address.
        assertEquals(setOf("theme_mode", "language", "last_sign_in_email"), snapshot(prefs).keys)
        assertEquals("owner@example.com", prefs[lastEmail])
        assertFalse(copyIsThere(prefs))
        assertNull("the countdown survived the wipe", prefs[flag])
    }

    @Test
    fun `the account-change wipe with no demo running is exactly what it was`() {
        // Not a demo: no copy, no countdown. What clearAll did before the demo
        // knew about theme and language must be all it does.
        fun oldClearAll(prefs: MutablePreferences) {
            val kept = prefs[lastEmail]
            prefs.clear()
            kept?.let { prefs[lastEmail] = it }
        }

        val mine = usedPhone()
        val reference = usedPhone()
        wipe(mine)
        oldClearAll(reference)
        assertEquals(snapshot(reference), snapshot(mine))
        // ...which includes the theme and language being wiped with the rest.
        assertNull(mine[theme])
        assertNull(mine[language])
    }

    @Test
    fun `the wipe cannot revive an old copy after a demo has already ended`() {
        val prefs = chosen("LIGHT", "SPANISH")
        begin(prefs)
        visitorChanges(prefs)
        end(prefs)
        SettingsStore.writeDevicePrefs(prefs, ThemeMode.DARK, AppLanguage.FRENCH, 0, false)
        wipe(prefs)
        // An ordinary wipe: the person's later choice goes with everything else
        // rather than being replaced by the demo's stale copy.
        assertNull(prefs[theme])
        assertNull(prefs[language])
    }

    // ------------------------------------------------ no copy: do nothing at all

    @Test
    fun `with no copy the end of a demo leaves the theme and language alone`() {
        // A demo that began before this existed: the countdown key is set, the
        // visitor has picked dark and French, and nothing recorded the originals.
        // Writing "the defaults" here would overwrite a choice; there is no
        // honest value to write, so the answer is to write nothing.
        val prefs = mutablePreferencesOf().apply {
            this[flag] = t0
            this[theme] = "DARK"
            this[language] = "FRENCH"
        }
        end(prefs)
        assertEquals("DARK", prefs[theme])
        assertEquals("FRENCH", prefs[language])
        assertEquals(0L, prefs[flag])
        assertFalse(copyIsThere(prefs))
    }

    @Test
    fun `with no copy and nothing stored the end of a demo does not invent either key`() {
        val prefs = mutablePreferencesOf().apply { this[flag] = t0 }
        end(prefs)
        assertNull("a theme key appeared from nowhere", prefs[theme])
        assertNull("a language key appeared from nowhere", prefs[language])
    }

    @Test
    fun `ending a demo that was never started changes nothing but the countdown key`() {
        val prefs = usedPhone()
        val before = snapshot(prefs)
        end(prefs)
        assertEquals(setOf("guest_session_started_at"), changed(before, snapshot(prefs)))
        assertEquals("LIGHT", prefs[theme])
        assertEquals("SPANISH", prefs[language])
    }

    // --------------------------------------------------- taken at the start

    @Test
    fun `the copy exists the moment the countdown does, in the same write`() {
        val prefs = chosen("LIGHT", "SPANISH")
        begin(prefs)
        // Nothing can have changed yet, so this is the earliest moment there is,
        // and the flag that opens the demo is already in the same preferences.
        assertEquals(t0, prefs[flag])
        assertEquals(true, prefs[copyTaken])
        assertEquals("LIGHT", prefs[copyTheme])
        assertEquals("SPANISH", prefs[copyLanguage])
    }

    @Test
    fun `the copy survives the app being killed mid-demo`() {
        val prefs = restart(chosen("LIGHT", "SPANISH").also { begin(it) })
        // Everything the store knew was in the preferences; a process that
        // dies and comes back has only that.
        val afterRestart = restart(prefs.also { visitorChanges(it) })
        assertEquals("DARK", afterRestart[theme])
        end(afterRestart)
        assertEquals("LIGHT", afterRestart[theme])
        assertEquals("SPANISH", afterRestart[language])
    }

    @Test
    fun `a phone that had chosen nothing gets nothing back, not a written default`() {
        val prefs = mutablePreferencesOf()
        begin(prefs)
        visitorChanges(prefs)
        end(prefs)
        // Absent, not "SYSTEM"/"ENGLISH": the phone is exactly as it was.
        assertNull(prefs[theme])
        assertNull(prefs[language])
        assertEquals(ThemeMode.SYSTEM, themeRead(prefs))
        assertEquals(AppLanguage.ENGLISH, languageRead(prefs))
    }

    @Test
    fun `it keeps the stored text as it was, not a parsed version of it`() {
        // A value the profile reader cannot parse reads as English. The copy must
        // not tidy that into something else, or "give back what was there" is a lie.
        val prefs = chosen("LIGHT", "klingon")
        begin(prefs)
        visitorChanges(prefs)
        end(prefs)
        assertEquals("klingon", prefs[language])
        assertEquals("LIGHT", prefs[theme])
    }

    @Test
    fun `a second start while a demo is running does not copy the visitor's choices`() {
        val prefs = chosen("LIGHT", "SPANISH")
        begin(prefs, t0)
        visitorChanges(prefs)
        // A double tap, or a start called again after a relaunch. The clock moves;
        // the copy must stay the phone's, not the visitor's.
        begin(prefs, t0 + 5_000L)
        assertEquals(t0 + 5_000L, prefs[flag])
        assertEquals("LIGHT", prefs[copyTheme])
        assertEquals("SPANISH", prefs[copyLanguage])
        end(prefs)
        assertEquals("LIGHT", prefs[theme])
        assertEquals("SPANISH", prefs[language])
    }

    @Test
    fun `a demo after a finished demo copies afresh from where the phone is now`() {
        val prefs = chosen("LIGHT", "SPANISH")
        begin(prefs)
        visitorChanges(prefs)
        end(prefs)
        // Between the two the phone's owner settles on something else.
        SettingsStore.writeDevicePrefs(prefs, ThemeMode.SYSTEM, AppLanguage.ENGLISH, 0, false)
        begin(prefs, t0 + 1_000_000L)
        visitorChanges(prefs)
        end(prefs)
        assertEquals("SYSTEM", prefs[theme])
        assertEquals("ENGLISH", prefs[language])
    }

    @Test
    fun `a start with a zero clock is not a demo and leaves no copy behind`() {
        val prefs = chosen("LIGHT", "SPANISH")
        SettingsStore.beginDemoPrefs(prefs, 0L)
        assertFalse("a copy with no countdown to end it would never be spent", copyIsThere(prefs))
    }

    // ------------------------------------------------ every order, against a model

    /**
     * Every sequence of up to six operations from {start, visitor changes, end,
     * account wipe}, from a phone that has chosen and from one that has not, run
     * against a plain statement of what should happen:
     *
     *  - the copy is present exactly while the countdown is running;
     *  - theme and language are, at every step, whatever the model says: the
     *    phone's own until a demo starts, the visitor's during it, and -- however
     *    the demo ends -- the pair the phone had at the START of that demo;
     *  - an end with no demo running changes neither.
     *
     * This is the part that would notice an order-dependent bug (a second end
     * undoing a later choice, a second start copying the visitor) that the
     * hand-picked cases above happen not to try.
     */
    @Test
    fun `every order of start, change, end and wipe agrees with the model`() {
        val ops = listOf("start", "visitor", "end", "wipe")
        var sequences = 0
        for (initial in listOf("LIGHT" to "SPANISH", null to null)) {
            fun walk(prefix: List<String>) {
                applySequence(prefix, initial.first, initial.second)
                sequences++
                if (prefix.size < 6) for (op in ops) walk(prefix + op)
            }
            walk(emptyList())
        }
        assertTrue("expected thousands of sequences, ran $sequences", sequences > 8000)
    }

    private fun applySequence(sequence: List<String>, initialTheme: String?, initialLanguage: String?) {
        val prefs = chosen(initialTheme, initialLanguage)
        prefs[lastEmail] = "owner@example.com"

        var running = false
        var modelTheme = initialTheme
        var modelLanguage = initialLanguage
        var originalTheme: String? = null
        var originalLanguage: String? = null
        var modelFlag = 0L
        val trail = StringBuilder()

        sequence.forEachIndexed { step, op ->
            trail.append(op).append(' ')
            when (op) {
                "start" -> {
                    val at = t0 + step + 1
                    begin(prefs, at)
                    if (!running) {
                        running = true
                        originalTheme = modelTheme
                        originalLanguage = modelLanguage
                    }
                    modelFlag = at
                }
                "visitor" -> {
                    // A different pair each time, so two changes in a row are two changes.
                    val t = ThemeMode.values()[step % ThemeMode.values().size]
                    val l = AppLanguage.values()[step % AppLanguage.values().size]
                    SettingsStore.writeDevicePrefs(prefs, t, l, 0, false)
                    modelTheme = t.name
                    modelLanguage = l.name
                }
                "end" -> {
                    end(prefs)
                    if (running) {
                        modelTheme = originalTheme
                        modelLanguage = originalLanguage
                        running = false
                    }
                    modelFlag = 0L
                }
                "wipe" -> {
                    wipe(prefs)
                    if (running) {
                        modelTheme = originalTheme
                        modelLanguage = originalLanguage
                        running = false
                    } else {
                        modelTheme = null
                        modelLanguage = null
                    }
                    modelFlag = 0L
                }
            }
            val where = "after [$trail] from $initialTheme/$initialLanguage"
            assertEquals("theme $where", modelTheme, prefs[theme])
            assertEquals("language $where", modelLanguage, prefs[language])
            assertEquals("countdown $where", modelFlag, prefs[flag] ?: 0L)
            assertEquals("copy present iff a demo is running $where", running, copyIsThere(prefs))
            if (running) assertEquals("copy complete $where", true, prefs[copyTaken])
            assertEquals("remembered address $where", "owner@example.com", prefs[lastEmail])
        }
    }

    // --------------------------------------------- the whole-profile save

    @Test
    fun `saving a profile never writes the countdown, in either direction`() {
        val stale = BusinessProfile(businessName = "Hernandez Fence Co", guestSessionStartedAt = t0)

        // A pull that read the profile while a demo was running, writing after it ended.
        val ended = chosen("LIGHT", "SPANISH").also { begin(it); visitorChanges(it); end(it) }
        SettingsStore.writeProfile(ended, stale, fromCloud = true)
        SettingsStore.writeProfile(ended, stale, fromCloud = false)
        assertEquals("a stale profile brought a finished demo back", 0L, ended[flag])

        // ...and one that read it before a demo began, writing after.
        val running = chosen("LIGHT", "SPANISH").also { begin(it, t0) }
        SettingsStore.writeProfile(running, BusinessProfile(guestSessionStartedAt = 0L), fromCloud = true)
        SettingsStore.writeProfile(running, BusinessProfile(guestSessionStartedAt = 0L), fromCloud = false)
        assertEquals("a stale profile ended a running demo without giving anything back", t0, running[flag])
        assertEquals(true, running[copyTaken])
    }

    @Test
    fun `saving a profile never touches the copy`() {
        val prefs = chosen("LIGHT", "SPANISH").also { begin(it) }
        val before = snapshot(prefs).filterKeys { it in copyKeys }
        SettingsStore.writeProfile(prefs, BusinessProfile(themeMode = ThemeMode.DARK, language = AppLanguage.FRENCH), fromCloud = false)
        SettingsStore.writeProfile(prefs, BusinessProfile(), fromCloud = true)
        assertEquals(before, snapshot(prefs).filterKeys { it in copyKeys })
    }

    @Test
    fun `a save that came from the cloud leaves the four device choices alone`() {
        val prefs = usedPhone().also { visitorChanges(it) }
        val before = snapshot(prefs)
        // A profile carrying different values for all four, as a stale read would.
        val stale = BusinessProfile(
            themeMode = ThemeMode.SYSTEM, language = AppLanguage.ENGLISH,
            autoLockMinutes = 0, biometricUnlockEnabled = false
        )
        SettingsStore.writeProfile(prefs, stale, fromCloud = true)
        val touched = changed(before, snapshot(prefs))
        assertFalse("theme_mode" in touched)
        assertFalse("language" in touched)
        assertFalse("auto_lock_minutes" in touched)
        assertFalse("biometric_unlock" in touched)
    }

    // Control for the test above: a person's own save from the Settings screen
    // still writes all four, so that test is passing because of the cloud flag and
    // not because the writer stopped writing them.
    @Test
    fun `a save the person made still writes the four`() {
        val prefs = usedPhone()
        SettingsStore.writeProfile(
            prefs,
            BusinessProfile(
                themeMode = ThemeMode.DARK, language = AppLanguage.FRENCH,
                autoLockMinutes = 15, biometricUnlockEnabled = false
            ),
            fromCloud = false
        )
        assertEquals("DARK", prefs[theme])
        assertEquals("FRENCH", prefs[language])
        assertEquals(15, prefs.asMap()[autoLock])
        assertEquals(false, prefs[biometric])
    }

    // ------------------------------------------ the checker can fail (teeth)

    // PLANTED FAILURES for checkRoundTrip. Each of these is a plausible way to get
    // the fix wrong, and the same checks that pass the real ender must reject it.
    private fun assertRejected(why: String, broken: (MutablePreferences) -> Unit) {
        val rejected = try {
            checkRoundTrip(broken)
            false
        } catch (e: AssertionError) {
            true
        }
        assertTrue("checkRoundTrip accepted a broken ender: $why", rejected)
    }

    @Test
    fun `an ender that only clears the countdown is caught`() {
        assertRejected("never gives anything back") { it[flag] = 0L }
    }

    @Test
    fun `an ender that writes defaults instead of the originals is caught`() {
        assertRejected("writes SYSTEM and ENGLISH over the phone's own LIGHT and SPANISH") {
            it[theme] = ThemeMode.SYSTEM.name
            it[language] = AppLanguage.ENGLISH.name
            it[flag] = 0L
        }
    }

    @Test
    fun `an ender that leaves the copy behind is caught by the second end`() {
        // Gives back correctly, but never spends the copy -- so the second end
        // puts the old pair over a later choice.
        assertRejected("gives back but keeps the copy") { p ->
            p[flag] = 0L
            p[copyTaken]?.let {
                p[theme] = p[copyTheme] ?: ThemeMode.SYSTEM.name
                p[language] = p[copyLanguage] ?: AppLanguage.ENGLISH.name
            }
        }
    }

    // ------------------------------------------ the wiring, read from the source

    private fun source(path: String): String = File(path).readText()

    /** Line and block comments removed, so a sentence about a call is not mistaken for the call. */
    private fun code(text: String): String =
        text.replace(Regex("""/\*[\s\S]*?\*/"""), " ").replace(Regex("""//[^\n]*"""), " ")

    private fun body(text: String, signature: String): String {
        val start = text.indexOf(signature)
        assertTrue("$signature is gone or was renamed", start >= 0)
        val open = text.indexOf('{', start)
        var depth = 0
        var i = open
        while (i < text.length) {
            if (text[i] == '{') depth++ else if (text[i] == '}') { depth--; if (depth == 0) break }
            i++
        }
        return text.substring(start, i + 1)
    }

    private val storePath = "src/main/java/com/fenceestimator/app/data/SettingsStore.kt"
    private val wipePath = "src/main/java/com/fenceestimator/app/guest/GuestWipe.kt"

    @Test
    fun `the three store entry points are exactly the tested bodies`() {
        val store = code(source(storePath))
        // One edit each: the flag and the copy are written together or not at all.
        for ((signature, callee) in listOf(
            "suspend fun startGuestSession(" to "beginDemoPrefs(it, startedAtMillis)",
            "suspend fun endGuestSession(" to "endDemoPrefs(it)",
            "suspend fun clearAll(" to "clearAllPrefs(it)"
        )) {
            val b = body(store, signature)
            assertTrue("$signature no longer calls $callee", b.contains(callee))
            assertEquals("$signature must be a single dataStore edit", 1, Regex("""dataStore\.edit""").findAll(b).count())
        }
    }

    @Test
    fun `ending a demo still goes rows first, then the countdown and choices, then the stamp`() {
        val wipeSource = code(source(wipePath))
        val clearDemo = body(wipeSource, "private suspend fun clearDemo(")
        val rows = clearDemo.indexOf("repository.deleteJobLocallyOnly(")
        val ending = clearDemo.indexOf("settingsStore.endGuestSession()")
        val stamp = clearDemo.indexOf("dataOwnership.onGuestDemoEnded()")
        assertTrue("clearDemo no longer deletes the sample rows", rows >= 0)
        assertTrue("clearDemo no longer ends the countdown through endGuestSession", ending >= 0)
        assertTrue("clearDemo no longer clears the demo stamp", stamp >= 0)
        assertTrue("the countdown and the give-back must come after the rows", rows < ending)
        assertTrue("the stamp must come last", ending < stamp)
        // Both ways in reach it.
        assertTrue(body(wipeSource, "suspend fun wipeIfDue(").contains("clearDemo("))
        assertTrue(body(wipeSource, "suspend fun wipeOnSignIn(").contains("clearDemo("))
    }

    @Test
    fun `nothing but the wipe ends a demo and nothing but the welcome screen starts one`() {
        val main = File("src/main/java")
        val enders = mutableListOf<String>()
        val starters = mutableListOf<String>()
        main.walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach { f ->
            val c = code(f.readText())
            if (Regex("""\.endGuestSession\s*\(""").containsMatchIn(c)) enders += f.name
            if (Regex("""\.startGuestSession\s*\(""").containsMatchIn(c)) starters += f.name
        }
        assertEquals("another caller now ends a demo without going through the wipe: $enders", listOf("GuestWipe.kt"), enders)
        assertEquals("another caller now starts a demo: $starters", listOf("MainActivity.kt"), starters)
    }

    @Test
    fun `the fix left the theme and language editable during a demo, as chosen`() {
        // The demo may still change both -- the fix is that they come back, not that
        // they are locked. If this is ever reversed on purpose, this and the restore
        // are both worth a fresh look.
        val vm = code(source("src/main/java/com/fenceestimator/app/ui/settings/PersonalSettingsViewModel.kt"))
        val save = body(vm, "fun save(")
        assertTrue(save.contains("themeMode = prefs.themeMode"))
        assertTrue(save.contains("language = prefs.language"))
        assertNotEquals(-1, save.indexOf("if (guestActive) current.autoLockMinutes"))
    }

    @Test
    fun `every language the app speaks survives the round trip`() {
        // The copy holds enum NAMES, which is what the profile reader parses. A
        // tag ("fr") would parse as nothing and put the phone into English.
        for (l in AppLanguage.values()) {
            val prefs = chosen("LIGHT", l.name)
            begin(prefs)
            visitorChanges(prefs)
            end(prefs)
            assertEquals(l, languageRead(prefs))
        }
    }
}

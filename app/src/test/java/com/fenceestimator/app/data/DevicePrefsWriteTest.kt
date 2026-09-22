package com.fenceestimator.app.data

import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.doublePreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.mutablePreferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the personal Settings screen is allowed to write.
 *
 * Crew, and anyone else without "Change catalog and settings", save through
 * SettingsStore.saveDevicePrefs and never through the full save. That path is
 * defined by what it leaves alone: UPDATED_AT, which decides whether this
 * phone's company settings beat the cloud's copy, and every company key, which
 * the full save rewrites from whatever the screen happened to hold. These run
 * the real body of saveDevicePrefs (SettingsStore.writeDevicePrefs) on a plain
 * MutablePreferences, so none of it needs a phone.
 *
 * The key names are spelled out rather than borrowed, because SettingsStore's
 * Keys object is private -- and that is useful as well. Renaming a key does not
 * just fail a test, it forgets the choice stored on every phone, so changing
 * one of these names ought to mean stopping to think first.
 */
class DevicePrefsWriteTest {

    private val theme = stringPreferencesKey("theme_mode")
    private val language = stringPreferencesKey("language")
    private val autoLock = intPreferencesKey("auto_lock_minutes")
    private val biometric = booleanPreferencesKey("biometric_unlock")
    private val updatedAt = longPreferencesKey("settings_updated_at")
    private val businessName = stringPreferencesKey("business_name")

    private val deviceKeys = setOf("theme_mode", "language", "auto_lock_minutes", "biometric_unlock")

    private val stampedAt = 1_758_200_000_000L

    /**
     * A phone somebody has used: a real company's settings pulled down, the
     * stamp from the last owner-side save, the remembered sign-in address, and
     * the four device choices set to something OTHER than what the tests
     * write -- so a writer that did nothing could not pass for one that worked.
     */
    private fun usedPhone(): MutablePreferences = mutablePreferencesOf().apply {
        this[businessName] = "Hernandez Fence Co"
        this[doublePreferencesKey("markup")] = 22.5
        this[doublePreferencesKey("labor_rate")] = 14.0
        this[doublePreferencesKey("tax_rate")] = 8.25
        this[stringPreferencesKey("order_template")] = "Hola, necesitamos los materiales..."
        this[booleanPreferencesKey("prices_reviewed")] = true
        this[booleanPreferencesKey("seen_tour")] = true
        this[stringPreferencesKey("square_token")] = "kept-as-typed"
        this[stringPreferencesKey("last_sign_in_email")] = "crew@example.com"
        this[longPreferencesKey("guest_session_started_at")] = 0L
        this[updatedAt] = stampedAt
        this[theme] = "LIGHT"
        this[language] = "SPANISH"
        this[autoLock] = 0
        this[biometric] = false
    }

    private fun snapshot(p: Preferences): Map<String, Any> =
        p.asMap().entries.associate { it.key.name to it.value }

    private fun changed(before: Map<String, Any>, after: Map<String, Any>): Set<String> =
        (before.keys + after.keys).filter { before[it] != after[it] }.toSet()

    private fun writeDarkFrench(p: MutablePreferences) =
        SettingsStore.writeDevicePrefs(p, ThemeMode.DARK, AppLanguage.FRENCH, 5, true)

    // ------------------------------------------------------------ what it touches

    @Test
    fun `changes the four device keys and nothing else`() {
        val prefs = usedPhone()
        val before = snapshot(prefs)
        writeDarkFrench(prefs)
        assertEquals(deviceKeys, changed(before, snapshot(prefs)))
    }

    @Test
    fun `never moves the settings clock`() {
        val prefs = usedPhone()
        writeDarkFrench(prefs)
        assertEquals(stampedAt, prefs[updatedAt])
    }

    // The test above cannot see a key rewritten with the value it already had
    // -- which is exactly what the full save does to every company key. On an
    // empty phone any write at all shows up, whatever its value.
    @Test
    fun `on a fresh phone it adds the four and no clock`() {
        val prefs = mutablePreferencesOf()
        writeDarkFrench(prefs)
        assertEquals(deviceKeys, snapshot(prefs).keys)
        assertNull(prefs[updatedAt])
    }

    // PLANTED FAILURE for the two tests above: the trap itself. The full save
    // with stamp = true writes the clock, and the same diff must name it.
    @Test
    fun `a writer that also stamps the clock is caught`() {
        val prefs = usedPhone()
        val before = snapshot(prefs)
        writeDarkFrench(prefs)
        prefs[updatedAt] = stampedAt + 60_000L
        val diff = changed(before, snapshot(prefs))
        assertTrue("settings_updated_at" in diff)
        assertNotEquals(deviceKeys, diff)
    }

    // PLANTED FAILURE for the fresh-phone test, and proof that it is needed: a
    // writer that also rewrites a company key with its CURRENT value passes the
    // diff on a used phone and is only caught on an empty one.
    @Test
    fun `an unchanged company rewrite hides from the diff and shows on a fresh phone`() {
        val alsoRewritesName: (MutablePreferences) -> Unit = { p ->
            writeDarkFrench(p)
            p[businessName] = p[businessName] ?: ""
        }

        val used = usedPhone()
        val before = snapshot(used)
        alsoRewritesName(used)
        assertEquals(deviceKeys, changed(before, snapshot(used)))

        val fresh = mutablePreferencesOf()
        alsoRewritesName(fresh)
        assertNotEquals(deviceKeys, snapshot(fresh).keys)
        assertTrue("business_name" in snapshot(fresh).keys)
    }

    // ------------------------------------------------------ what it stores there

    @Test
    fun `stores what the profile reader reads back`() {
        val prefs = usedPhone()
        writeDarkFrench(prefs)
        // SettingsStore.profile reads these two with valueOf, so the stored text
        // has to be the enum NAME.
        assertEquals(ThemeMode.DARK, ThemeMode.valueOf(prefs[theme]!!))
        assertEquals(AppLanguage.FRENCH, AppLanguage.valueOf(prefs[language]!!))
        // A Long under an int key would read back as the wrong type and blow up
        // where the profile is built, far from here. Checked on the raw value.
        val lock: Any? = prefs.asMap()[autoLock]
        assertTrue("auto_lock_minutes must be stored as an Int, was ${lock?.javaClass}", lock is Int)
        assertEquals(5, lock)
        assertEquals(true, prefs[biometric])
    }

    // PLANTED FAILURE for the test above: the language's tag instead of its
    // name. Parsed the way SettingsStore.profile parses it, that is English --
    // a French speaker's phone quietly switching back, with no error anywhere.
    @Test
    fun `a tag stored instead of the name reads back as English`() {
        val prefs = usedPhone()
        prefs[language] = AppLanguage.FRENCH.tag
        val read = runCatching { AppLanguage.valueOf(prefs[language] ?: "") }
            .getOrDefault(AppLanguage.ENGLISH)
        assertEquals(AppLanguage.ENGLISH, read)
        assertNotEquals(AppLanguage.FRENCH, read)
    }

    @Test
    fun `every combination is written exactly as chosen`() {
        // Every value of every setting, so a writer that fixed one of them --
        // always SYSTEM, always English, always off -- cannot slip through on
        // the single case the other tests happen to use.
        for (t in ThemeMode.values()) for (l in AppLanguage.values()) {
            for (minutes in listOf(0, 1, 60)) for (bio in listOf(false, true)) {
                val prefs = usedPhone()
                SettingsStore.writeDevicePrefs(prefs, t, l, minutes, bio)
                val what = "$t/$l/$minutes/$bio"
                assertEquals(what, t.name, prefs[theme])
                assertEquals(what, l.name, prefs[language])
                assertEquals(what, minutes, prefs.asMap()[autoLock])
                assertEquals(what, bio, prefs[biometric])
                assertEquals(what, stampedAt, prefs[updatedAt])
            }
        }
    }

    @Test
    fun `the sign-in address and the Square token survive`() {
        // Both are device-only like the four, and both are things somebody
        // typed. Neither is the personal screen's to change.
        val prefs = usedPhone()
        writeDarkFrench(prefs)
        assertEquals("crew@example.com", prefs[stringPreferencesKey("last_sign_in_email")])
        assertEquals("kept-as-typed", prefs[stringPreferencesKey("square_token")])
        assertFalse(prefs.asMap().isEmpty())
    }
}

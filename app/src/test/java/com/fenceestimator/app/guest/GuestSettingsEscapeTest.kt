package com.fenceestimator.app.guest

import com.fenceestimator.app.data.AppLanguage
import com.fenceestimator.app.data.BusinessProfile
import com.fenceestimator.app.data.ThemeMode
import com.fenceestimator.app.data.guestEditableOver
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.reflect.full.memberProperties

/**
 * THE ONE GUEST WRITE THAT ESCAPED THE DEMO.
 *
 * Every other write a guest can reach lands in Room, where the demo wipe takes
 * it back. The settings profile lands in DataStore, which the wipe does not
 * touch and GuestWriteGuard does not cover -- so a business name, a labour rate
 * or a set of contract terms typed during a demo SURVIVED it, and
 * SettingsSync's null-coalescing merge would let a real company adopt it.
 *
 * [guestEditableOver] is the allow-list that closes it. These tests are about
 * the two things that make an allow-list worth having: that it really keeps the
 * company's values, and that a field added LATER is refused by default rather
 * than quietly writable until somebody remembers it.
 */
class GuestSettingsEscapeTest {

    /** What the company has saved. */
    private val stored = BusinessProfile(
        businessName = "Real Fencing Co",
        ownerName = "The Owner",
        phone = "555-0100",
        email = "office@real.example",
        licenseNumber = "LIC-1234",
        defaultTaxRatePercent = 7.0,
        defaultMarkupPercent = 15.0,
        defaultLaborRatePerFt = 9.5,
        defaultMinimumJobCharge = 250.0,
        defaultMinimumLaborCharge = 200.0,
        themeMode = ThemeMode.SYSTEM,
        language = AppLanguage.ENGLISH,
    )

    /** What a guest typed over the top of it. */
    private val guestEdit = stored.copy(
        businessName = "Guest's Fencing",
        ownerName = "Somebody Else",
        phone = "000",
        email = "guest@nowhere.example",
        licenseNumber = "MADE-UP",
        defaultTaxRatePercent = 0.0,
        defaultMarkupPercent = 99.0,
        defaultLaborRatePerFt = 1.0,
        defaultMinimumJobCharge = 0.0,
        defaultMinimumLaborCharge = 0.0,
        themeMode = ThemeMode.DARK,
        language = AppLanguage.SPANISH,
        squareAccessToken = "tok-from-this-phone",
        squareLocationId = "loc-from-this-phone",
    )

    @Test
    fun `a guest cannot change one single company field`() {
        val result = guestEdit.guestEditableOver(stored)
        assertEquals("Real Fencing Co", result.businessName)
        assertEquals("The Owner", result.ownerName)
        assertEquals("555-0100", result.phone)
        assertEquals("office@real.example", result.email)
        assertEquals("LIC-1234", result.licenseNumber)
        assertEquals(7.0, result.defaultTaxRatePercent, 0.0001)
        assertEquals(15.0, result.defaultMarkupPercent, 0.0001)
        assertEquals(9.5, result.defaultLaborRatePerFt, 0.0001)
        assertEquals(250.0, result.defaultMinimumJobCharge, 0.0001)
        assertEquals(200.0, result.defaultMinimumLaborCharge, 0.0001)
    }

    @Test
    fun `a guest CAN still change this phone's own things`() {
        // The other half, and the reason this is not a blanket refusal: a guest
        // who cannot switch the app to Spanish has been broken, not protected.
        val result = guestEdit.guestEditableOver(stored)
        assertEquals(ThemeMode.DARK, result.themeMode)
        assertEquals(AppLanguage.SPANISH, result.language)
        assertEquals("tok-from-this-phone", result.squareAccessToken)
        assertEquals("loc-from-this-phone", result.squareLocationId)
    }

    @Test
    fun `POSITIVE CONTROL -- without the rule those company fields really would change`() {
        // If BusinessProfile ever stopped carrying these, every assertion above
        // would pass by comparing nothing to nothing.
        assertNotEquals(stored.businessName, guestEdit.businessName)
        assertNotEquals(stored.defaultLaborRatePerFt, guestEdit.defaultLaborRatePerFt, 0.0001)
        assertNotEquals(stored.themeMode, guestEdit.themeMode)
        assertEquals(
            "the guest's own edit, unfiltered, IS the guest's values -- so the filter above did something",
            "Guest's Fencing", guestEdit.businessName
        )
    }

    @Test
    fun `a field nobody has thought about yet is refused, not allowed`() {
        // THE POINT OF AN ALLOW-LIST. This walks every property of
        // BusinessProfile and checks that the filtered result takes it from the
        // STORED profile, except for the four this phone owns. A field added
        // later is therefore refused until somebody deliberately adds it here --
        // the opposite of a deny-list, where it would be writable by a guest
        // from the moment it was declared until somebody remembered.
        val devicesOwn = setOf("themeMode", "language", "squareAccessToken", "squareLocationId")
        val result = guestEdit.guestEditableOver(stored)
        var checked = 0
        for (prop in BusinessProfile::class.memberProperties) {
            val fromStored = prop.get(stored)
            val fromGuest = prop.get(guestEdit)
            val fromResult = prop.get(result)
            if (fromStored == fromGuest) continue   // says nothing either way
            checked++
            if (prop.name in devicesOwn) {
                assertEquals("${prop.name} is this phone's and should follow the guest", fromGuest, fromResult)
            } else {
                assertEquals(
                    "${prop.name} is a COMPANY field and a guest's value reached the saved profile",
                    fromStored, fromResult
                )
            }
        }
        assertTrue(
            "the walk compared nothing -- the two fixtures must differ in several fields or this proves nothing",
            checked >= 10
        )
    }

    @Test
    fun `it is a filter, not an identity -- applying it twice changes nothing more`() {
        val once = guestEdit.guestEditableOver(stored)
        val twice = once.guestEditableOver(stored)
        assertEquals(once, twice)
    }

    @Test
    fun `a non-guest save is untouched -- the rule is only ever applied to a guest`() {
        // Said here because the branch that decides lives in SettingsViewModel
        // and cannot be run on a JVM: what CAN be pinned is that the function
        // itself does not quietly alter a normal save if it were ever applied
        // to one by mistake. Over its own stored values it is the identity.
        assertEquals(guestEdit, guestEdit.guestEditableOver(guestEdit))
    }
}

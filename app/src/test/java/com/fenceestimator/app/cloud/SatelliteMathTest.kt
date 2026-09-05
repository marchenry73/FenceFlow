package com.fenceestimator.app.cloud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins [SatelliteMath] (the phone's port of website/dashboard.html's
 * satWorld/satUnworld/satFeetPerPx/satLength) against the exact same figures
 * tests/satellite-measure.test.mjs checks on the JS side -- same latitude,
 * same longitude, same zoom, same independently-worked-out expected
 * distances. A scale factor that is quietly wrong here does not look wrong,
 * it looks like a fence, and the only way anyone finds out is when the
 * materials arrive short.
 *
 * If a change to SatelliteMath ever makes this fail while the JS test still
 * passes (or vice versa), the two have drifted apart and one of them is now
 * measuring the ground wrong.
 */
class SatelliteMathTest {

    /** Riverview, Florida -- where the first real measurements will happen. */
    private val lat = 27.78
    private val lon = -82.34
    private val z = 20
    private val ftPerM = 3.280839895
    private val mPerDeg = 40075016.686 / 360.0 // spherical earth, one degree at the equator

    private fun ll(lat: Double, lon: Double) = SatelliteMath.LatLon(lat, lon)

    /** Asserts [got] is within [tolPct] percent of [want]. Mirrors the JS test's own `near`. */
    private fun assertNear(label: String, got: Double, want: Double, tolPct: Double) {
        val off = Math.abs(got - want) / want * 100.0
        assertTrue(
            "$label: got $got want $want (off by ${"%.4f".format(off)}%%)",
            off <= tolPct
        )
    }

    @Test
    fun `east-west 0001 deg`() {
        val d = 0.001
        val expectM = mPerDeg * Math.cos(lat * Math.PI / 180.0) * d
        val pts = listOf(ll(lat, lon), ll(lat, lon + d))
        assertNear("east-west 0.001 deg", SatelliteMath.length(pts, false, lat, z), expectM * ftPerM, 0.5)
    }

    @Test
    fun `north-south 0001 deg -- mercator stretch must match feetPerPx`() {
        val d = 0.001
        val expectM = mPerDeg * d
        val pts = listOf(ll(lat, lon), ll(lat + d, lon))
        assertNear("north-south 0.001 deg", SatelliteMath.length(pts, false, lat, z), expectM * ftPerM, 0.5)
    }

    @Test
    fun `a 100 ft run measures 100 ft`() {
        val ft = 100.0
        val degLon = ft / ftPerM / (mPerDeg * Math.cos(lat * Math.PI / 180.0))
        val pts = listOf(ll(lat, lon), ll(lat, lon + degLon))
        assertNear("100 ft run", SatelliteMath.length(pts, false, lat, z), 100.0, 0.5)
    }

    @Test
    fun `four sides of a square, open and closed`() {
        val side = 80.0
        val degLon = side / ftPerM / (mPerDeg * Math.cos(lat * Math.PI / 180.0))
        val degLat = side / ftPerM / mPerDeg
        val sq = listOf(
            ll(lat, lon),
            ll(lat, lon + degLon),
            ll(lat + degLat, lon + degLon),
            ll(lat + degLat, lon)
        )
        assertNear("three sides open", SatelliteMath.length(sq, false, lat, z), side * 3, 0.5)
        assertNear("four sides closed", SatelliteMath.length(sq, true, lat, z), side * 4, 0.5)
    }

    @Test
    fun `zoom must not change the length of a fence`() {
        val pts = listOf(ll(lat, lon), ll(lat + 0.0004, lon + 0.0006))
        val at20 = SatelliteMath.length(pts, false, lat, 20)
        val at18 = SatelliteMath.length(pts, false, lat, 18)
        val at16 = SatelliteMath.length(pts, false, lat, 16)
        assertNear("zoom 18 agrees with 20", at18, at20, 0.001)
        assertNear("zoom 16 agrees with 20", at16, at20, 0.001)
    }

    @Test
    fun `projecting there and back lands where it started`() {
        val w = SatelliteMath.world(lat, lon, z)
        val back = SatelliteMath.unworld(w.x, w.y, z)
        assertNear("round trip latitude", back.lat, lat, 0.0001)
        assertNear("round trip longitude", Math.abs(back.lon), Math.abs(lon), 0.0001)
    }

    @Test
    fun `what gets written to the fence run -- 20 survey px per foot, origin at the first corner`() {
        val side = 80.0
        val pxPerFt = 20.0
        val degLon = side / ftPerM / (mPerDeg * Math.cos(lat * Math.PI / 180.0))
        val pts = listOf(ll(lat, lon), ll(lat, lon + degLon))
        val f = SatelliteMath.feetPerPx(lat, z)
        val o = SatelliteMath.world(pts[0].lat, pts[0].lon, z)
        val enc = pts.map { p ->
            val w = SatelliteMath.world(p.lat, p.lon, z)
            doubleArrayOf((w.x - o.x) * f * pxPerFt, (w.y - o.y) * f * pxPerFt)
        }
        assertEquals(0.0, Math.round(enc[0][0]).toDouble(), 0.0)
        assertEquals(0.0, Math.round(enc[0][1]).toDouble(), 0.0)
        assertNear("80 ft becomes 1600 survey pixels", enc[1][0], side * pxPerFt, 0.5)
        assertTrue("does not drift sideways: ${enc[1][1]}", Math.abs(enc[1][1]) < 1.0)
    }

    @Test
    fun `guards -- no points or one point measures nothing`() {
        assertEquals(0.0, SatelliteMath.length(emptyList(), false, lat, z), 0.0)
        assertEquals(0.0, SatelliteMath.length(listOf(ll(lat, lon)), false, lat, z), 0.0)
    }
}

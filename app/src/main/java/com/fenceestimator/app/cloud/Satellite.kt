package com.fenceestimator.app.cloud

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import com.fenceestimator.app.BuildConfig
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpRequestTimeoutException
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.request.get
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.net.URLEncoder

/*
 * The office can trace a fence over satellite imagery on the dashboard
 * (website/dashboard.html); the phone could not. This is the phone's half of
 * that feature: the same Web Mercator arithmetic the dashboard uses (ported
 * byte for byte, see SatelliteMath below), and the plumbing to fetch imagery
 * through the same keyless proxy (supabase/functions/quote-map) the office
 * calls.
 *
 * Kept as its own file rather than folded into an existing one because
 * nothing else in cloud/ talks to quote-map, and because SatelliteMath is
 * pinned by a unit test (SatelliteMathTest) that has to import exactly this
 * object -- mixing it into a file with unrelated responsibilities would make
 * that import mean less.
 */

/**
 * Web Mercator, the projection every slippy map (and the satellite tiles
 * quote-map proxies) is drawn in.
 *
 * Ported byte for byte from `satWorld` / `satUnworld` / `satFeetPerPx` /
 * `satLength` in website/dashboard.html -- same constants, same operation
 * order, same Double precision -- because a scale factor that is quietly
 * wrong here does not look wrong, it looks like a fence, and the only way
 * anyone finds out is when the materials arrive short. tests/satellite-
 * measure.test.mjs pins the JS side; SatelliteMathTest.kt (test/java/.../
 * cloud/SatelliteMathTest.kt) feeds this Kotlin port the same inputs and
 * checks the same numbers, so the two can never quietly drift apart.
 *
 * Every fence the app measures -- from a photo, from the no-photo grid, or
 * now from satellite imagery -- is stored in survey pixels at a fixed pixels-
 * per-foot calibration (SurveyViewModel.PIXELS_PER_FOOT_GRID = 20). This
 * object is only ever used to place satellite imagery correctly inside that
 * same survey-pixel space and to convert a freshly-tapped screen point back
 * into it -- never to re-derive a length directly, so there is exactly one
 * ruler for the app to disagree with itself over.
 */
object SatelliteMath {
    /** A Web Mercator pixel coordinate at a given zoom -- not latitude/longitude. */
    data class WorldPoint(val x: Double, val y: Double)
    data class LatLon(val lat: Double, val lon: Double)

    /** lat/lon -> Web Mercator pixel coordinates at zoom [z]. Mirrors satWorld(). */
    fun world(lat: Double, lon: Double, z: Int): WorldPoint {
        val n = 256.0 * Math.pow(2.0, z.toDouble())
        val x = (lon + 180.0) / 360.0 * n
        val la = lat * Math.PI / 180.0
        val y = (1.0 - Math.log(Math.tan(la) + 1.0 / Math.cos(la)) / Math.PI) / 2.0 * n
        return WorldPoint(x, y)
    }

    /** The inverse of [world]. Mirrors satUnworld(). */
    fun unworld(x: Double, y: Double, z: Int): LatLon {
        val n = 256.0 * Math.pow(2.0, z.toDouble())
        val lon = x / n * 360.0 - 180.0
        val t = Math.PI - 2.0 * Math.PI * y / n
        val lat = 180.0 / Math.PI * Math.atan(0.5 * (Math.exp(t) - Math.exp(-t)))
        return LatLon(lat, lon)
    }

    /**
     * Feet covered by one Web Mercator pixel, at this zoom and this far from
     * the equator. 156543.034 is the metres a pixel spans at the equator at
     * zoom 0. Mirrors satFeetPerPx().
     */
    fun feetPerPx(lat: Double, z: Int): Double =
        156543.03392804097 * Math.cos(lat * Math.PI / 180.0) / Math.pow(2.0, z.toDouble()) * 3.280839895

    /**
     * The length of a traced line, in feet, using the same projection the
     * imagery is drawn in -- so what is measured is what gets saved. Mirrors
     * satLength().
     */
    fun length(pts: List<LatLon>, loop: Boolean, lat: Double, z: Int): Double {
        if (pts.size < 2) return 0.0
        val f = feetPerPx(lat, z)
        val list = if (loop) pts + pts[0] else pts
        var total = 0.0
        for (i in 1 until list.size) {
            val a = world(list[i - 1].lat, list[i - 1].lon, z)
            val b = world(list[i].lat, list[i].lon, z)
            total += Math.hypot(b.x - a.x, b.y - a.y) * f
        }
        return total
    }
}

/**
 * Fetches the two things quote-map serves -- geocoding and imagery tiles --
 * and caches the tiles in memory. Both endpoints are keyless and public (see
 * quote-map's own header comment and its `verify_jwt = false` entry in
 * supabase/config.toml), exactly as the dashboard calls them with a bare
 * `fetch`/`<img src>` and no Authorization header, so this does the same.
 */
object Satellite {
    private val json = Json { ignoreUnknownKeys = true }

    /** Tiles this large a fence job could ever plausibly need at once. Well
     *  under the memory a few dozen decoded 256x256 JPEGs actually cost. */
    private const val TILE_CACHE_SIZE = 160

    private val tileCache = object : LruCache<String, Bitmap>(TILE_CACHE_SIZE) {}

    /**
     * Coalesces concurrent requests for the same tile. A pinch-zoom gesture
     * asks for the same handful of tiles many times a second as the visible
     * range is recomputed frame to frame; without this each of those asks
     * fired its own download of a tile whose first download hadn't even
     * finished yet.
     */
    private val inFlightLock = Mutex()
    private val inFlight = HashMap<String, Deferred<Bitmap?>>()
    private val fetchScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun tileKey(z: Int, x: Int, y: Int) = "$z/$x/$y"

    private val client: HttpClient by lazy {
        HttpClient(CIO) {
            install(HttpTimeout) {
                requestTimeoutMillis = 20_000
                connectTimeoutMillis = 10_000
                socketTimeoutMillis = 20_000
            }
        }
    }

    /** A tile already sitting in memory, if any -- never touches the network. */
    fun cachedTile(z: Int, x: Int, y: Int): Bitmap? = tileCache.get(tileKey(z, x, y))

    /**
     * Fetches one 256x256 imagery tile through quote-map's `action=tile`,
     * caching it in memory so panning back over the same ground never
     * re-downloads it. Returns null on any failure (offline, no imagery,
     * decode failure) -- callers fall back to drawing the grid, exactly as
     * the spec for this feature requires.
     */
    suspend fun fetchTile(z: Int, x: Int, y: Int): Bitmap? {
        cachedTile(z, x, y)?.let { return it }
        if (!SupabaseModule.isConfigured) return null
        val key = tileKey(z, x, y)

        val deferred = inFlightLock.withLock {
            inFlight.getOrPut(key) {
                fetchScope.async { downloadTile(z, x, y, key) }
            }
        }
        return try {
            deferred.await()
        } finally {
            inFlightLock.withLock {
                // Only the entry that is still THIS deferred is ours to
                // remove -- a slow download that finishes after a newer
                // request already replaced it must not clear the newer one.
                if (inFlight[key] === deferred) inFlight.remove(key)
            }
        }
    }

    private suspend fun downloadTile(z: Int, x: Int, y: Int, key: String): Bitmap? =
        withContext(Dispatchers.IO) {
            try {
                val url = "${BuildConfig.SUPABASE_URL}/functions/v1/quote-map?action=tile&z=$z&y=$y&x=$x"
                val response = client.get(url)
                if (!response.status.isSuccess()) return@withContext null
                val bytes: ByteArray = response.body()
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@withContext null
                tileCache.put(key, bitmap)
                bitmap
            } catch (e: Exception) {
                null
            }
        }

    sealed interface GeocodeResult {
        data class Ok(val lat: Double, val lon: Double, val matched: String) : GeocodeResult
        data class Failed(val reason: String) : GeocodeResult
    }

    @Serializable
    private data class GeocodeResponse(
        val lat: Double? = null,
        val lon: Double? = null,
        val matched: String = "",
        val error: String? = null
    )

    /**
     * Places an address, through the same Census-then-Esri fallback chain
     * quote-map's `action=geocode` uses. Called once per job: the result is
     * meant to be stored on the job (Job.siteLat/siteLon) so this is never
     * asked again for a property that hasn't moved.
     */
    suspend fun geocode(address: String): GeocodeResult = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) {
            return@withContext GeocodeResult.Failed("Cloud isn't set up on this build.")
        }
        val trimmed = address.trim()
        if (trimmed.length < 8) {
            return@withContext GeocodeResult.Failed("This job has no address yet, so there is nowhere to look.")
        }
        try {
            val url = "${BuildConfig.SUPABASE_URL}/functions/v1/quote-map?action=geocode&address=" +
                URLEncoder.encode(trimmed, "UTF-8")
            val response = client.get(url)
            val text = response.bodyAsText()
            val parsed = runCatching { json.decodeFromString(GeocodeResponse.serializer(), text) }.getOrNull()
            when {
                parsed?.lat != null && parsed.lon != null -> GeocodeResult.Ok(parsed.lat, parsed.lon, parsed.matched)
                parsed?.error != null -> GeocodeResult.Failed(parsed.error)
                else -> GeocodeResult.Failed("Could not place that address. It usually needs the city and ZIP.")
            }
        } catch (e: HttpRequestTimeoutException) {
            GeocodeResult.Failed("Timed out looking up that address.")
        } catch (e: Exception) {
            GeocodeResult.Failed("Could not check that address just now.")
        }
    }
}

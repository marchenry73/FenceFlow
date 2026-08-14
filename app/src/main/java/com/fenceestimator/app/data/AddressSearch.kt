package com.fenceestimator.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Free address search via OpenStreetMap's Nominatim API -- no API key or
 * billing account needed. Less polished than Google Places, but works with
 * no setup. Respects Nominatim's usage policy: identifying User-Agent, and
 * callers are expected to debounce (no more than ~1 request/second).
 */
object AddressSearch {
    suspend fun search(query: String): List<String> = withContext(Dispatchers.IO) {
        if (query.trim().length < 4) return@withContext emptyList()
        try {
            val encoded = URLEncoder.encode(query, "UTF-8")
            val url = URL("https://nominatim.openstreetmap.org/search?q=$encoded&format=json&addressdetails=0&limit=5")
            val connection = url.openConnection() as HttpURLConnection
            connection.setRequestProperty("User-Agent", "FenceEstimatorApp/1.0 (contractor estimating app)")
            connection.connectTimeout = 5000
            connection.readTimeout = 5000
            val text = connection.inputStream.bufferedReader().use { it.readText() }
            connection.disconnect()
            val array = JSONArray(text)
            (0 until array.length()).mapNotNull { i ->
                array.getJSONObject(i).optString("display_name").takeIf { it.isNotBlank() }
            }
        } catch (e: Exception) {
            emptyList()
        }
    }
}

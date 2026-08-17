package com.fenceestimator.app.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Address lookup that is actually accurate for US street addresses, with no
 * API key and no billing account.
 *
 * The old version asked Nominatim alone, which is built for finding places
 * rather than verifying addresses. Type a real house number and it would
 * happily return the street, the neighbourhood, or nothing -- which for
 * quoting a fence is the difference between the right yard and the one next
 * door.
 *
 * Two free sources, asked at the same time and merged:
 *
 *  - **US Census Geocoder** is the authoritative one. It is the government's
 *    own TIGER address data, it normalises what you type into a real mailing
 *    address, and it is free with no key and no quota to sign up for. It only
 *    answers complete-looking US addresses, so it is not a type-ahead -- but
 *    when it answers, it is right, so its results are put first.
 *  - **Photon** is the type-ahead. It is OpenStreetMap data served by an engine
 *    built for prefix search, so it produces useful suggestions from half an
 *    address while you are still typing. Free, no key.
 *
 * Nominatim stays as a last resort for the cases neither covers.
 *
 * Everything is best-effort: a source that fails or times out contributes
 * nothing rather than failing the search, because a slow lookup must never stop
 * someone typing an address in by hand.
 */
object AddressSearch {

    private const val USER_AGENT = "FenceFlow/1.0 (fencing contractor estimating app)"
    private const val TIMEOUT_MS = 6000

    suspend fun search(query: String): List<String> {
        val trimmed = query.trim()
        if (trimmed.length < 4) return emptyList()

        return coroutineScope {
            // Asked together rather than in sequence. Run one after the other and
            // the slower one's timeout is added to the faster one's wait, which
            // is exactly when someone gives up and types it themselves.
            val census = async(Dispatchers.IO) {
                if (looksLikeStreetAddress(trimmed)) runCatching { censusSearch(trimmed) }.getOrDefault(emptyList())
                else emptyList()
            }
            val photon = async(Dispatchers.IO) { runCatching { photonSearch(trimmed) }.getOrDefault(emptyList()) }

            val merged = (census.await() + photon.await()).distinctBy { it.lowercase().replace(",", "") }

            // Only reach for Nominatim when the good sources came back empty.
            if (merged.isNotEmpty()) merged.take(8)
            else runCatching { nominatimSearch(trimmed) }.getOrDefault(emptyList())
        }
    }

    /**
     * Whether this is worth asking the Census about.
     *
     * It only matches complete addresses, so sending it "oak" wastes a request
     * and a second of someone's time. A leading house number is the cheap
     * signal that they are typing a real address rather than searching.
     */
    private fun looksLikeStreetAddress(query: String): Boolean =
        Regex("^\\s*\\d+\\s+\\S+").containsMatchIn(query)

    /** The government's own address file. Free, no key, and normalises what it returns. */
    private fun censusSearch(query: String): List<String> {
        val url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
            "?address=${enc(query)}&benchmark=Public_AR_Current&format=json"
        val body = fetch(url) ?: return emptyList()
        val matches = JSONObject(body)
            .optJSONObject("result")
            ?.optJSONArray("addressMatches")
            ?: return emptyList()
        return (0 until matches.length()).mapNotNull { i ->
            matches.optJSONObject(i)?.optString("matchedAddress")?.takeIf { it.isNotBlank() }
        }
    }

    /** OSM data through a search engine built for typing, so half an address still helps. */
    private fun photonSearch(query: String): List<String> {
        val url = "https://photon.komoot.io/api/?q=${enc(query)}&limit=8&lang=en"
        val body = fetch(url) ?: return emptyList()
        val features = JSONObject(body).optJSONArray("features") ?: return emptyList()
        return (0 until features.length()).mapNotNull { i ->
            val props = features.optJSONObject(i)?.optJSONObject("properties") ?: return@mapNotNull null
            // US only. A fencing crew is not driving to a same-named street in
            // another country, and those matches crowd out the real one.
            if (props.optString("countrycode").uppercase() !in setOf("US", "")) return@mapNotNull null
            formatPhoton(props)
        }.filter { it.isNotBlank() }
    }

    /**
     * Builds the one-line address a person would write on an envelope.
     *
     * Photon returns the pieces separately, and its own `name` is often just
     * the street or the business, so assembling it here is what produces
     * "1425 Oak St, Tampa, FL 33604" rather than "Oak St".
     */
    private fun formatPhoton(props: JSONObject): String {
        val houseNumber = props.optString("housenumber")
        val street = props.optString("street").ifBlank { props.optString("name") }
        val city = props.optString("city")
            .ifBlank { props.optString("town") }
            .ifBlank { props.optString("village") }
            .ifBlank { props.optString("county") }
        // Photon spells the state out ("Florida"); the Census abbreviates it
        // ("FL"). Suggestions from the two sources sit in the same list, so
        // they are made to match -- otherwise the same address appears twice
        // in two different styles and looks like two different places.
        val state = STATE_ABBREVIATIONS[props.optString("state")] ?: props.optString("state")
        val postcode = props.optString("postcode")

        val line1 = listOf(houseNumber, street).filter { it.isNotBlank() }.joinToString(" ")
        return listOf(line1, city, listOf(state, postcode).filter { it.isNotBlank() }.joinToString(" "))
            .filter { it.isNotBlank() }
            .joinToString(", ")
    }

    /** Last resort, and biased to the US so it stops offering streets abroad. */
    private fun nominatimSearch(query: String): List<String> {
        val url = "https://nominatim.openstreetmap.org/search" +
            "?q=${enc(query)}&format=json&addressdetails=0&countrycodes=us&limit=5"
        val body = fetch(url) ?: return emptyList()
        val array = JSONArray(body)
        return (0 until array.length()).mapNotNull { i ->
            array.getJSONObject(i).optString("display_name").takeIf { it.isNotBlank() }
                // Nominatim tacks the country on the end of everything.
                ?.removeSuffix(", United States")
        }
    }

    private val STATE_ABBREVIATIONS = mapOf(
        "Alabama" to "AL", "Alaska" to "AK", "Arizona" to "AZ", "Arkansas" to "AR",
        "California" to "CA", "Colorado" to "CO", "Connecticut" to "CT", "Delaware" to "DE",
        "District of Columbia" to "DC", "Florida" to "FL", "Georgia" to "GA", "Hawaii" to "HI",
        "Idaho" to "ID", "Illinois" to "IL", "Indiana" to "IN", "Iowa" to "IA",
        "Kansas" to "KS", "Kentucky" to "KY", "Louisiana" to "LA", "Maine" to "ME",
        "Maryland" to "MD", "Massachusetts" to "MA", "Michigan" to "MI", "Minnesota" to "MN",
        "Mississippi" to "MS", "Missouri" to "MO", "Montana" to "MT", "Nebraska" to "NE",
        "Nevada" to "NV", "New Hampshire" to "NH", "New Jersey" to "NJ", "New Mexico" to "NM",
        "New York" to "NY", "North Carolina" to "NC", "North Dakota" to "ND", "Ohio" to "OH",
        "Oklahoma" to "OK", "Oregon" to "OR", "Pennsylvania" to "PA", "Rhode Island" to "RI",
        "South Carolina" to "SC", "South Dakota" to "SD", "Tennessee" to "TN", "Texas" to "TX",
        "Utah" to "UT", "Vermont" to "VT", "Virginia" to "VA", "Washington" to "WA",
        "West Virginia" to "WV", "Wisconsin" to "WI", "Wyoming" to "WY", "Puerto Rico" to "PR"
    )

    private fun enc(value: String): String = URLEncoder.encode(value, "UTF-8")

    /** Returns null on any failure. A lookup that cannot answer must not throw. */
    private fun fetch(url: String): String? {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(url).openConnection() as HttpURLConnection).apply {
                setRequestProperty("User-Agent", USER_AGENT)
                setRequestProperty("Accept", "application/json")
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
            }
            if (connection.responseCode !in 200..299) return null
            connection.inputStream.bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            null
        } finally {
            runCatching { connection?.disconnect() }
        }
    }

    /**
     * Confirms a typed address against the Census file and returns it in
     * standard form, or null if it cannot be matched.
     *
     * Worth calling before a job goes out the door: "1425 oak st tampa"
     * becomes "1425 OAK ST, TAMPA, FL, 33604", which is what should appear on
     * the estimate, the contract and the crew's directions.
     */
    suspend fun verify(address: String): String? = withContext(Dispatchers.IO) {
        if (address.isBlank()) return@withContext null
        runCatching { censusSearch(address).firstOrNull() }.getOrNull()
    }
}

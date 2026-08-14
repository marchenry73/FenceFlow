package com.fenceestimator.app.payments

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlin.math.roundToLong

/**
 * Creates Square payment links straight from the app.
 *
 * The app never touches the money: it asks Square to bill the customer, and
 * Square handles the card, PCI compliance, and the deposit into the
 * contractor's own bank account. That keeps FenceFlow well clear of being a
 * money transmitter, which would require licensing.
 *
 * The access token belongs to the contractor and is stored on their own
 * device, so each business bills into its own Square account.
 */
object SquarePayments {

    private const val BASE = "https://connect.squareup.com/v2"
    // Pinned so a future Square release can't silently change response shapes.
    private const val API_VERSION = "2025-01-23"

    data class PaymentLink(val url: String, val orderId: String?)

    /** Square needs a location id; almost every account has exactly one. */
    suspend fun firstLocationId(token: String): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val body = get("$BASE/locations", token)
            val locations = JSONObject(body).optJSONArray("locations")
                ?: error("No locations on this Square account")
            if (locations.length() == 0) error("No locations on this Square account")
            locations.getJSONObject(0).getString("id")
        }
    }

    /**
     * Creates a hosted checkout link for [amount] dollars. Square wants the
     * amount in whole cents, so it's rounded rather than truncated -- a
     * silent penny loss on every invoice would be a real bug.
     */
    suspend fun createPaymentLink(
        token: String,
        locationId: String,
        amount: Double,
        description: String,
        buyerEmail: String? = null
    ): Result<PaymentLink> = withContext(Dispatchers.IO) {
        runCatching {
            require(amount > 0.0) { "Amount must be greater than zero" }
            val cents = (amount * 100).roundToLong()

            val payload = JSONObject().apply {
                put("idempotency_key", UUID.randomUUID().toString())
                put("quick_pay", JSONObject().apply {
                    put("name", description.take(255))
                    put("location_id", locationId)
                    put("price_money", JSONObject().apply {
                        put("amount", cents)
                        put("currency", "USD")
                    })
                })
                buyerEmail?.takeIf { it.isNotBlank() }?.let {
                    put("pre_populated_data", JSONObject().put("buyer_email", it))
                }
            }

            val response = post("$BASE/online-checkout/payment-links", token, payload.toString())
            val link = JSONObject(response).getJSONObject("payment_link")
            PaymentLink(url = link.getString("url"), orderId = link.optString("order_id").ifBlank { null })
        }
    }

    /** Checks whether the order behind a payment link has been paid. */
    suspend fun isOrderPaid(token: String, orderId: String): Result<Boolean> = withContext(Dispatchers.IO) {
        runCatching {
            val body = get("$BASE/orders/$orderId", token)
            val state = JSONObject(body).getJSONObject("order").optString("state")
            state == "COMPLETED"
        }
    }

    private fun get(url: String, token: String): String = request(url, token, method = "GET", body = null)

    private fun post(url: String, token: String, body: String): String =
        request(url, token, method = "POST", body = body)

    private fun request(url: String, token: String, method: String, body: String?): String {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            setRequestProperty("Authorization", "Bearer $token")
            setRequestProperty("Square-Version", API_VERSION)
            setRequestProperty("Content-Type", "application/json")
            connectTimeout = 15_000
            readTimeout = 15_000
            if (body != null) doOutput = true
        }
        try {
            body?.let { connection.outputStream.use { out -> out.write(it.toByteArray()) } }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            if (code !in 200..299) throw IllegalStateException(squareError(text, code))
            return text
        } finally {
            connection.disconnect()
        }
    }

    /** Square returns structured errors; surface the human-readable detail rather than a bare status code. */
    private fun squareError(body: String, code: Int): String {
        val detail = runCatching {
            JSONObject(body).optJSONArray("errors")?.optJSONObject(0)?.optString("detail")
        }.getOrNull()
        return when {
            !detail.isNullOrBlank() -> detail
            code == 401 -> "Square rejected the access token. Check it in Settings."
            else -> "Square request failed ($code)"
        }
    }
}

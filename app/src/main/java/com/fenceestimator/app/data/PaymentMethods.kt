package com.fenceestimator.app.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put

/**
 * How customers can pay this company: Cash App, Zelle, wire, cash -- the phone
 * half of the panel the office already carries.
 *
 * ONE STORE, AND IT IS THE OFFICE'S.  The office writes
 * `company_settings.settings -> 'payment_methods'` through save_company_settings()
 * (website/dashboard.html, paymentMethodsFromForm / savePaymentMethods). The phone
 * writes THE SAME key, in THE SAME shape, through THE SAME RPC. There is no phone
 * table, no column on `companies`, and no second copy to reconcile -- the mistake
 * that put business name, phone and licence in two places on this project is not
 * repeated here. The contract and the reasoning are in
 * supabase_a38_company_payment_methods.sql.
 *
 *     payment_methods = { "cash_app": { "on": true, "tag": "Tag" },   // no $ stored
 *                         "zelle":    { "on": true, "to":  "..." },
 *                         "wire":     { "on": true, "details": "..." },
 *                         "cash":     { "on": true } }
 *
 * WRITTEN WHOLE, ALWAYS. save_company_settings() merges with `||`, which is
 * SHALLOW: a partial `payment_methods` object replaces the key outright and so
 * erases the methods it left out. Both surfaces therefore send all four methods
 * every time. [toStoredJson] cannot produce a partial object.
 *
 * THE RECEIVING LIMIT LIVES IN ITS OWN KEY, ON PURPOSE.  He asked to "show the
 * limit of what needs to be done" -- what a personal Zelle or Cash App will
 * actually take in one go. That is a different fact from the handle, and it goes
 * in a SIBLING key, `payment_limits`:
 *
 *     payment_limits = { "cash_app": "", "zelle": "", "wire": "" }
 *
 * Not inside `payment_methods`, and this is the whole reason: the office writes
 * that key whole from a form that has no limit box, so a limit stored inside it
 * would be silently deleted the next time he pressed Save in the office. A
 * sibling key survives, because `||` only replaces the keys actually sent.
 *
 * NO LIMIT IS INVENTED. Blank is the default and blank shows nothing. The number
 * is HIS to type, it is about HER bank rather than his account, and nothing here
 * supplies, suggests or rounds one.
 */

// ---------------------------------------------------------------- the values --

/**
 * What the owner typed, before it is judged. Field for field the office form
 * (dashboard.html readPayMethodsForm) so the two can be compared directly.
 */
data class PaymentMethodsForm(
    val cashAppOn: Boolean = false,
    val cashAppTag: String = "",
    val cashAppLimit: String = "",
    val zelleOn: Boolean = false,
    val zelleTo: String = "",
    val zelleLimit: String = "",
    val wireOn: Boolean = false,
    val wireDetails: String = "",
    val wireLimit: String = "",
    val cashOn: Boolean = false
)

/**
 * The four methods in one fixed shape, whatever was stored (or nothing at all).
 * The Kotlin twin of dashboard.html's canonPaymentMethods.
 */
data class PaymentMethods(
    val cashAppOn: Boolean = false,
    val cashAppTag: String = "",
    val zelleOn: Boolean = false,
    val zelleTo: String = "",
    val wireOn: Boolean = false,
    val wireDetails: String = "",
    val cashOn: Boolean = false
)

/** The per-method receiving limit, exactly as typed and normalised, or blank. */
data class PaymentLimits(
    val cashApp: String = "",
    val zelle: String = "",
    val wire: String = ""
)

/**
 * What a customer would be shown, built by the same rules as quote-view's
 * `publicPaymentMethods`: a method appears only when it is switched ON **and**
 * filled in, a `$` is put back on a Cash App tag, and anything off, empty,
 * malformed or over-long comes out blank.
 *
 * This is what the phone shows him in the confirm step, so that what he approves
 * is what the customer reads -- not what he typed into the boxes.
 */
data class PublicPaymentMethods(
    val cashApp: String = "",
    val zelle: String = "",
    val wire: String = "",
    val cash: Boolean = false
) {
    /** True when nothing at all would reach a customer, so no panel is drawn. */
    val isEmpty: Boolean get() = cashApp.isEmpty() && zelle.isEmpty() && wire.isEmpty() && !cash
}

/**
 * This phone's working copy of the two cloud keys, plus the two facts that
 * decide whether the panel may be edited at all.
 *
 * [loaded] false means no server read has ever succeeded here. It is NOT
 * "nothing is set up": the panel must stay read-only, because a Save from a
 * blank form would be queued and later sent over real details.
 *
 * [pending] true means a save landed on this phone and not on the server. It is
 * shown in words and it survives a restart -- an unsent payment detail that
 * disappeared quietly is the failure C19 names.
 */
data class PaymentMethodsCache(
    val methodsJson: String = "",
    val limitsJson: String = "",
    val loaded: Boolean = false,
    val pending: Boolean = false
)

/** Why a form was refused. [which] names the method for the on-but-empty case. */
data class PaymentMethodsRejection(val reason: PaymentMethodsError, val which: PaymentOption? = null)

enum class PaymentMethodsError { CASH_APP_BAD, ZELLE_BAD, ZELLE_LONG, WIRE_LONG, ON_BUT_EMPTY, LIMIT_BAD }

/**
 * Which ways he TELLS A CUSTOMER she can pay him -- the four he fills in on the
 * settings panel and the quote page shows.
 *
 * NOT [PaymentMethod] in Entities.kt, which is a different thing with a
 * confusingly similar name: that one records how money ACTUALLY ARRIVED on a
 * payment ledger row (CARD, CASH, CHECK, BANK_TRANSFER, OTHER). This was
 * declared as PaymentMethod too until 2026-10-02 and would not compile --
 * same name, same `data` package. Renamed rather than merged, because merging
 * them is worse than the clash: it would put CARD and CHECK into the list of
 * channels he offers and has never configured, and put CASH_APP and ZELLE into
 * the ledger enum that no migration and no office report knows about.
 */
enum class PaymentOption { CASH_APP, ZELLE, WIRE, CASH }

// ------------------------------------------------------------- the rules ------

object PaymentMethodRules {

    /**
     * Invisible and direction-changing characters. They arrive when a handle is
     * pasted out of a text message; they make a $cashtag fail to match with
     * nothing on screen to explain why, and a right-to-left override can make an
     * address read differently from what it actually is. Character for character
     * the office's PAY_INVISIBLE and quote-view's INVISIBLE_CHARS.
     */
    val INVISIBLE =
        Regex("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u00AD\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2069\\uFEFF]")

    /** The office's PAY_TAG and quote-view's CASH_APP_TAG, unchanged. */
    val CASH_APP_TAG = Regex("^[A-Za-z0-9_.\\-]{1,30}$")

    /**
     * The OFFICE's limits (120 / 1000), deliberately not quote-view's (200 /
     * 1500). The phone has to refuse exactly what the office refuses: a value
     * the phone accepted but the office would not is a value he could never
     * save again from his desk, and he would find that out by being told his
     * own stored details are too long.
     */
    const val MAX_ZELLE_CHARS = 120
    const val MAX_WIRE_CHARS = 1000

    /** quote-view's own ceilings, for the record. Nothing here may exceed them. */
    const val SERVER_MAX_ZELLE_CHARS = 200
    const val SERVER_MAX_WIRE_CHARS = 1500

    private fun strip(s: String): String = INVISIBLE.replace(s, "")

    /**
     * What was typed -> what to store, or the reason it was refused. Pure.
     *
     * Operation for operation the office's `paymentMethodsFromForm`, including
     * the order of the checks, so that a value either surface accepts is a value
     * both accept.
     *
     * NOTHING IS CUT SHORT. An over-long Zelle address or wire block is REFUSED
     * with a message, never truncated: half a bank account number is a payment
     * sent nowhere.
     */
    fun fromForm(form: PaymentMethodsForm): Result<Pair<PaymentMethods, PaymentLimits>> {
        val tag = strip(form.cashAppTag).trim().trimStart('$')
        val to = strip(form.zelleTo).replace(Regex("\\s+"), " ").trim()
        val wire = strip(form.wireDetails)
            .replace(Regex("\\r\\n?"), "\n")
            .split("\n").joinToString("\n") { it.trim() }
            .trim()

        if (tag.isNotEmpty() && !CASH_APP_TAG.matches(tag)) return reject(PaymentMethodsError.CASH_APP_BAD)
        if (to.length > MAX_ZELLE_CHARS) return reject(PaymentMethodsError.ZELLE_LONG)
        if (to.isNotEmpty() && !looksLikeZelleTarget(to)) return reject(PaymentMethodsError.ZELLE_BAD)
        if (wire.length > MAX_WIRE_CHARS) return reject(PaymentMethodsError.WIRE_LONG)
        if (form.cashAppOn && tag.isEmpty()) return reject(PaymentMethodsError.ON_BUT_EMPTY, PaymentOption.CASH_APP)
        if (form.zelleOn && to.isEmpty()) return reject(PaymentMethodsError.ON_BUT_EMPTY, PaymentOption.ZELLE)
        if (form.wireOn && wire.isEmpty()) return reject(PaymentMethodsError.ON_BUT_EMPTY, PaymentOption.WIRE)

        val cashAppLimit = normaliseLimit(form.cashAppLimit) ?: return reject(PaymentMethodsError.LIMIT_BAD, PaymentOption.CASH_APP)
        val zelleLimit = normaliseLimit(form.zelleLimit) ?: return reject(PaymentMethodsError.LIMIT_BAD, PaymentOption.ZELLE)
        val wireLimit = normaliseLimit(form.wireLimit) ?: return reject(PaymentMethodsError.LIMIT_BAD, PaymentOption.WIRE)

        return Result.success(
            PaymentMethods(
                cashAppOn = form.cashAppOn, cashAppTag = tag,
                zelleOn = form.zelleOn, zelleTo = to,
                wireOn = form.wireOn, wireDetails = wire,
                cashOn = form.cashOn
            ) to PaymentLimits(cashApp = cashAppLimit, zelle = zelleLimit, wire = wireLimit)
        )
    }

    private fun reject(reason: PaymentMethodsError, which: PaymentOption? = null) =
        Result.failure<Pair<PaymentMethods, PaymentLimits>>(
            PaymentMethodsRefused(PaymentMethodsRejection(reason, which))
        )

    /**
     * Does this look like a Zelle target at all?
     *
     * The office's test, unchanged: an email-ish string, or ten digits or more.
     * It is NOT classified as phone or email and it is NOT verified -- no check
     * can prove a handle belongs to him, and pretending otherwise would be the
     * dangerous part. It only catches "zelle me", which would otherwise be
     * printed on a customer's quote as the way to pay.
     *
     * ASCII digits only, and that is the office's test rather than a narrower
     * one of mine. `Char.isDigit()` is `Character.isDigit`, which is true for
     * the whole Unicode Nd category -- Arabic-Indic ٠١٢٣٤٥٦٧٨٩ and fullwidth
     * ０１２３４５６７８９ both count as ten digits to it. The office's
     * `to.replace(/\D/g, '')` has no `u` flag, so `\D` there is `[^0-9]` and
     * both of those strings are refused at the desk. Counting them here would
     * have let the phone store a Zelle target he could never save again from
     * the office -- and he would find that out by being told his own stored
     * details are invalid. quote-view applies no digit test at all, so the
     * value would have reached a customer in the meantime.
     */
    fun looksLikeZelleTarget(to: String): Boolean =
        Regex("[^\\s@]+@[^\\s@]+\\.[^\\s@]+").containsMatchIn(to) || to.count { it in '0'..'9' } >= 10

    /**
     * A receiving limit, normalised, or null when what was typed is not a
     * positive amount of money.
     *
     * Blank stays blank: that is the default and it means "say nothing about a
     * limit". No number is supplied here, ever -- see the file header.
     *
     * `$`, commas and spaces are accepted because that is how a person writes
     * money, and the result is stored as plain digits so a reader can compare it
     * with a deposit without parsing currency.
     */
    fun normaliseLimit(raw: String): String? {
        val cleaned = strip(raw).replace(",", "").replace("$", "").trim()
        if (cleaned.isEmpty()) return ""
        if (!Regex("^\\d+(\\.\\d{1,2})?$").matches(cleaned)) return null
        val value = cleaned.toDoubleOrNull() ?: return null
        if (value <= 0.0) return null
        // Keep cents only when he typed cents; "2500" must not become "2500.00".
        return if (cleaned.contains('.')) cleaned.trimEnd('0').trimEnd('.') else cleaned
    }

    /** The limit as a number for comparing against a deposit, or null when blank. */
    fun limitAmount(normalised: String): Double? =
        normalised.takeIf { it.isNotEmpty() }?.toDoubleOrNull()

    /**
     * The four methods out of whatever was stored. The Kotlin twin of
     * dashboard.html's canonPaymentMethods: a missing key, a null, a string
     * where an object belongs and an array all read as "nothing set".
     *
     * `on` must be exactly true, never merely truthy -- the same test quote-view
     * applies before anything reaches a customer.
     */
    fun canon(stored: JsonElement?): PaymentMethods {
        val m = stored as? JsonObject ?: return PaymentMethods()
        fun part(key: String): JsonObject = m[key] as? JsonObject ?: JsonObject(emptyMap())
        /**
         * `on` must be a REAL boolean true, never merely something that reads
         * as true -- the same test quote-view applies (`m.on === true`) before
         * anything reaches a customer.
         *
         * `booleanOrNull` alone was not that test: for the JSON *string*
         * `"true"` it answers true, because it parses the content. So a blob
         * holding `{"on": "true"}` would have switched a method ON on the phone
         * while the customer's page -- which demands the strict boolean --
         * showed nothing. Two surfaces disagreeing about whether a payment
         * method is live is exactly the class of defect being hunted this week.
         * `!isString` is what makes it the server's test.
         */
        fun on(key: String): Boolean =
            (part(key)["on"] as? JsonPrimitive)?.let { !it.isString && it.booleanOrNull == true } == true
        fun text(key: String, field: String): String =
            (part(key)[field] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: ""
        return PaymentMethods(
            cashAppOn = on("cash_app"), cashAppTag = text("cash_app", "tag"),
            zelleOn = on("zelle"), zelleTo = text("zelle", "to"),
            wireOn = on("wire"), wireDetails = text("wire", "details"),
            cashOn = on("cash")
        )
    }

    /** The limits out of whatever was stored in the sibling key. */
    fun canonLimits(stored: JsonElement?): PaymentLimits {
        val m = stored as? JsonObject ?: return PaymentLimits()
        fun text(key: String): String =
            (m[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
                ?.let { normaliseLimit(it) ?: "" } ?: ""
        return PaymentLimits(cashApp = text("cash_app"), zelle = text("zelle"), wire = text("wire"))
    }

    /**
     * The whole `payment_methods` object to store. All four methods, every time
     * -- see the file header on `||` being shallow.
     */
    fun toStoredJson(methods: PaymentMethods): JsonObject = buildJsonObject {
        put("cash_app", buildJsonObject { put("on", methods.cashAppOn); put("tag", methods.cashAppTag) })
        put("zelle", buildJsonObject { put("on", methods.zelleOn); put("to", methods.zelleTo) })
        put("wire", buildJsonObject { put("on", methods.wireOn); put("details", methods.wireDetails) })
        put("cash", buildJsonObject { put("on", methods.cashOn) })
    }

    /** The whole `payment_limits` object to store. Blank is stored as blank. */
    fun limitsToStoredJson(limits: PaymentLimits): JsonObject = buildJsonObject {
        put("cash_app", limits.cashApp)
        put("zelle", limits.zelle)
        put("wire", limits.wire)
    }

    /**
     * What the customer would actually read, by quote-view's rules.
     *
     * This is the confirm step's text. He is shown THIS, not the boxes, because
     * what the boxes hold and what the customer gets are not the same thing: a
     * switched-off method with a tag still in it shows nothing, and a Cash App
     * tag gains its `$`.
     */
    fun publicView(methods: PaymentMethods): PublicPaymentMethods {
        val out = PublicPaymentMethods(
            // Plain concatenation, not a "$$it" template. On Kotlin 2.0 that
            // happens to mean a literal $ followed by the value, but 2.1
            // gives `$$` to multi-dollar interpolation, so it is a silent
            // trap waiting for a toolchain bump -- and this is the character
            // that tells a customer which Cash App account to pay.
            cashApp = methods.cashAppTag.let { strip(it).trim().trimStart('$') }
                .takeIf { methods.cashAppOn && CASH_APP_TAG.matches(it) }
                ?.let { "$" + it } ?: "",
            zelle = methods.zelleTo.let { strip(it).replace(Regex("\\s+"), " ").trim() }
                .takeIf { methods.zelleOn && it.isNotEmpty() && it.length <= SERVER_MAX_ZELLE_CHARS } ?: "",
            wire = tidyWire(methods.wireDetails)
                .takeIf { methods.wireOn && it.isNotEmpty() && it.length <= SERVER_MAX_WIRE_CHARS } ?: "",
            cash = methods.cashOn
        )
        return out
    }

    /** quote-view's wire tidy: line endings, stray spaces, runs of blank lines. */
    private fun tidyWire(details: String): String {
        val lines = strip(details).replace(Regex("\\r\\n?"), "\n").split("\n").map { it.trim() }.toMutableList()
        while (lines.isNotEmpty() && lines.first().isEmpty()) lines.removeAt(0)
        while (lines.isNotEmpty() && lines.last().isEmpty()) lines.removeAt(lines.size - 1)
        return lines.joinToString("\n").replace(Regex("\\n{3,}"), "\n\n")
    }

    /** Which methods a customer would be shown: on AND filled in. */
    fun liveMethods(methods: PaymentMethods): List<PaymentOption> {
        val view = publicView(methods)
        return buildList {
            if (view.cashApp.isNotEmpty()) add(PaymentOption.CASH_APP)
            if (view.zelle.isNotEmpty()) add(PaymentOption.ZELLE)
            if (view.wire.isNotEmpty()) add(PaymentOption.WIRE)
            if (view.cash) add(PaymentOption.CASH)
        }
    }

    /**
     * Is this the same thing, stored? Compares the canonical objects, the way
     * the office's samePaymentMethods does, so a read-back can be judged
     * without caring how the server spelled the JSON.
     */
    fun same(a: JsonElement?, b: JsonElement?): Boolean = canon(a) == canon(b)

    fun sameLimits(a: JsonElement?, b: JsonElement?): Boolean = canonLimits(a) == canonLimits(b)

    /** The form to fill a screen with from what is stored. */
    fun toForm(methods: PaymentMethods, limits: PaymentLimits) = PaymentMethodsForm(
        cashAppOn = methods.cashAppOn,
        cashAppTag = if (methods.cashAppTag.isEmpty()) "" else "$" + methods.cashAppTag,
        cashAppLimit = limits.cashApp,
        zelleOn = methods.zelleOn,
        zelleTo = methods.zelleTo,
        zelleLimit = limits.zelle,
        wireOn = methods.wireOn,
        wireDetails = methods.wireDetails,
        wireLimit = limits.wire,
        cashOn = methods.cashOn
    )

    /** Lenient reader for the copy this phone keeps for working offline. */
    private val json = Json { ignoreUnknownKeys = true }

    fun parseOrNull(raw: String?): JsonElement? =
        raw?.takeIf { it.isNotBlank() }?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() }
}

/** Carries a [PaymentMethodsRejection] out of [PaymentMethodRules.fromForm]. */
class PaymentMethodsRefused(val rejection: PaymentMethodsRejection) : Exception(rejection.reason.name)

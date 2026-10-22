package com.fenceestimator.app.cloud

import io.github.jan.supabase.exceptions.RestException

/**
 * WHAT A PERSON IS SHOWN WHEN A CALL FAILS -- AND WHAT THEY ARE NEVER SHOWN.
 *
 * postgrest-kt 3.0.2 builds a RestException's message out of the whole
 * request: the reason, then the URL, then every header -- `Authorization=
 * [Bearer eyJ...]` among them. Anything that printed `error.message` printed
 * a live access token on the screen, an hour's worth of this person's access,
 * in a place that gets photographed and sent to whoever is helping.
 *
 * The crash REPORT path has been redacted since the same hazard was found in
 * app_errors (CrashReporter.redact). The SCREEN path was not, and on
 * 2026-10-22 the Admin console showed the whole thing: a permission failure
 * on mail_platform_settings, followed by the token, in red, on the phone.
 *
 * ONE FUNCTION, not a rule to remember at eighteen call sites. Every place
 * that turns a failure into words a person reads comes through here, so a new
 * screen is redacted by default rather than by whoever wrote it having read
 * this comment.
 *
 * It does three things, in order:
 *
 *   1. PREFERS THE SERVER'S OWN SENTENCE. A RestException carries the
 *      reason in `error` and `description`, separate from the request dump.
 *      That is the half worth showing -- "permission denied for table
 *      mail_platform_settings" -- and it is the half that was buried.
 *   2. CUTS THE REQUEST DUMP. Whatever is left is truncated at the first
 *      `URL:` or `Headers:`. Everything after those is plumbing, and the
 *      token lives there.
 *   3. REDACTS ANYWAY. Belt and braces, through CrashReporter.redact -- the
 *      SAME redaction the report path uses, called rather than copied, so the
 *      two cannot drift apart. If a future client puts the token somewhere
 *      step 2 does not cut, step 3 still takes it out.
 *
 * It never returns an empty string: a blank red line tells a person their
 * action failed and nothing else, which is worse than the fallback sentence
 * the caller wrote for exactly this case.
 */
fun shownError(error: Throwable?, fallback: String): String {
    if (error == null) return fallback

    // The server's own words, when there are any. listOfNotNull + filter,
    // because RestException leaves both of these empty on some statuses and
    // "null null" is not a sentence.
    val rest = generateSequence(error) { it.cause }.filterIsInstance<RestException>().firstOrNull()
    val fromServer = rest
        ?.let { listOfNotNull(it.error, it.description) }
        ?.map { it.trim() }
        ?.filter { it.isNotEmpty() }
        ?.distinct()
        ?.joinToString(" -- ")
        .orEmpty()

    val raw = if (fromServer.isNotEmpty()) fromServer else (error.message ?: "")
    val cut = REQUEST_DUMP.split(raw).first().trim().trimEnd(',', ';')
    val safe = CrashReporter.redact(cut).take(MAX_SHOWN).trim()
    return if (safe.isEmpty()) fallback else safe
}

/**
 * Where the reason stops and the request begins. Both labels are produced by
 * the client, not by the server, so neither can appear inside a genuine
 * message -- and if one ever did, losing the tail of a sentence is the
 * cheaper mistake by a wide margin.
 */
private val REQUEST_DUMP = Regex("""\s*(URL:|Headers:)""", RegexOption.IGNORE_CASE)

/**
 * Long enough for any sentence the database raises, short enough that a
 * surprise wall of text cannot push a dialog's buttons off the screen.
 */
private const val MAX_SHOWN = 300

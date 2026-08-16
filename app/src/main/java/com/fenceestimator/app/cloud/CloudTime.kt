package com.fenceestimator.app.cloud

import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * Parses the timestamps Postgres actually sends us.
 *
 * This was a real, silent data-loss bug, and it is worth spelling out because
 * nothing about it looked wrong.
 *
 * The app wrote timestamps with [Instant.toString], which ends in `Z`:
 *
 *     2026-08-16T04:05:06.631Z
 *
 * Postgres stores that in a `timestamptz` and hands it back with a numeric
 * offset instead:
 *
 *     2026-08-16T04:05:06.631429+00:00
 *
 * `Instant.parse` is `DateTimeFormatter.ISO_INSTANT`, and on the java.time that
 * ships inside Android it insists on the literal `Z` -- a numeric offset throws.
 * (The JDK lifted that restriction in 12; Android's copy predates it, and this
 * app has no core library desugaring, so the device runs the strict version.)
 *
 * Every call site wrapped the parse in `runCatching { }.getOrNull()`, so the
 * throw never surfaced. It just quietly became "no timestamp":
 *
 *  - a job's cloud `updated_at` read as epoch 0, so the phone believed every
 *    cloud row was older than anything local. Nothing was ever pulled down --
 *    the app pushed forever and listened never.
 *  - a `scheduled_date` came back null, so a job scheduled on one phone showed
 *    as unscheduled on the next one.
 *
 * Fixed by accepting the formats Postgres genuinely emits rather than the one
 * format we happened to write. Offset-bearing first, then `Z`, then a bare
 * timestamp (which PostgREST returns for plain `timestamp` columns), which is
 * read as UTC because that is what the server stores.
 */
object CloudTime {

    private val BARE = DateTimeFormatter.ofPattern("yyyy-MM-dd[' ']['T']HH:mm:ss[.SSSSSS][.SSS]")

    /**
     * Epoch millis, or null if the text is genuinely not a timestamp.
     *
     * Callers still have to handle null, but it now means "the server sent no
     * date", not "the server sent a date we couldn't be bothered to read".
     */
    fun parseMillis(text: String?): Long? {
        val raw = text?.trim()?.takeIf { it.isNotEmpty() } ?: return null

        // Postgres uses a space between date and time; ISO wants a T.
        val iso = if (raw.length > 10 && raw[10] == ' ') raw.replaceRange(10, 11, "T") else raw

        // "+00" is a legal Postgres offset and not a legal ISO one.
        val padded = if (Regex("[+-]\\d{2}$").containsMatchIn(iso)) "$iso:00" else iso

        runCatching {
            OffsetDateTime.parse(padded, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant().toEpochMilli()
        }.getOrNull()?.let { return it }

        runCatching { Instant.parse(padded).toEpochMilli() }
            .getOrNull()?.let { return it }

        // No zone at all: the server keeps UTC, so read it as UTC rather than
        // as the phone's local time, which would shift it by hours.
        runCatching { LocalDateTime.parse(padded, BARE).toInstant(ZoneOffset.UTC).toEpochMilli() }
            .getOrNull()?.let { return it }

        return runCatching { LocalDateTime.parse(padded).toInstant(ZoneOffset.UTC).toEpochMilli() }
            .getOrNull()
    }

    /** The text form we send up. Always `Z`, which Postgres accepts on the way in. */
    fun format(millis: Long): String = Instant.ofEpochMilli(millis).toString()
}

package com.fenceestimator.app.cloud

import android.content.Context
import android.os.Build
import com.fenceestimator.app.BuildConfig
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter

@Serializable
internal data class CloudError(
    @SerialName("company_id") val companyId: String? = null,
    val email: String = "",
    @SerialName("version_code") val versionCode: Int = 0,
    @SerialName("version_name") val versionName: String = "",
    val android: String = "",
    val fatal: Boolean = true,
    @SerialName("where_at") val whereAt: String = "",
    val message: String = "",
    val stack: String = "",
    /**
     * Field 9 of the pending record: when it happened on the phone. Never
     * sent as a column -- app_errors has none, and an unknown column fails
     * the whole insert -- only folded into [stack] on upload.
     */
    @kotlinx.serialization.Transient val recordedAt: Long = 0L
)

/**
 * Notices when the app dies, so somebody other than the user finds out.
 *
 * Without this, a crash on a customer's phone is invisible. They do not file a
 * report -- they close the app, try again once, and quietly go back to paper.
 * With five customers, five people doing that is the whole business.
 *
 * ## Why it writes to disk before it writes to the network
 *
 * A process that has just thrown an uncaught exception has seconds to live and
 * an unreliable amount of working state. Starting a network request there
 * usually loses the report and can make the crash worse. So the handler does
 * the smallest possible thing -- append a line to a file -- and the report is
 * uploaded at the next launch, when the app is healthy and there is time to
 * retry.
 *
 * That means every report arrives one launch late. It is the standard trade
 * and the right one: a report that arrives late beats a report that does not
 * arrive.
 */
object CrashReporter {

    private const val PENDING_FILE = "pending-crashes.txt"
    private const val RECORD_SEPARATOR = "\n---8<---\n"

    /** Cap the file so a crash loop cannot fill a phone's storage. */
    private const val MAX_PENDING = 20

    /** Places at the end of the file only a fatal crash may take. See [appendTo]. */
    private const val FATAL_RESERVE = 5

    /** Field divider inside one record. Chosen because no stack trace contains it. */
    private val FIELD: Char = Char(1)

    /**
     * Roughly where the user was. Set as screens open, so a crash report says
     * "Estimate" rather than only naming a coroutine somewhere.
     */
    @Volatile
    var currentScreen: String = ""

    /**
     * Who is signed in right now, kept current by the session manager.
     *
     * Stamped into each report as it is written. Attribution used to come from
     * the session at UPLOAD time -- the next launch -- so a failure under a
     * test account, uploaded after switching back, was filed under the wrong
     * person and sent the investigation the wrong way.
     */
    @Volatile var currentEmail: String = ""
    @Volatile var currentCompanyId: String = ""

    private var installed = false

    /** Reports go up once per launch. The session state emits more than once. */
    private val uploaded = java.util.concurrent.atomic.AtomicBoolean(false)

    fun install(context: Context) {
        if (installed) return
        installed = true

        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()

        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            // Wrapped so a fault in the reporter can never replace the real
            // crash. A reporting bug that hides the bug it was reporting is
            // worse than having no reporter at all.
            runCatching { writePending(app, error, fatal = true) }
            // Always hand back to the platform: the app must still die and
            // still show whatever the system shows, or this becomes a way to
            // silently swallow crashes.
            if (previous != null) {
                previous.uncaughtException(thread, error)
            } else {
                // No handler underneath us. Android normally installs one, but
                // if it is ever missing the thread would just end and leave a
                // half-dead app on screen -- worse than a clean crash, because
                // the user keeps tapping a UI whose state is already gone.
                android.os.Process.killProcess(android.os.Process.myPid())
            }
        }
    }

    /**
     * Records something that went wrong without killing the app.
     *
     * For the failures that matter and are survivable -- a sync that keeps
     * failing, a PDF that will not render. Those never surface otherwise.
     */
    fun report(context: Context, where: String, error: Throwable) {
        if (!isWorthReporting(error)) return
        if (!firstThisRun(where, error)) return
        runCatching { writePending(context.applicationContext, error, fatal = false, where = where) }
    }

    /**
     * Whether a survivable failure says anything about the app.
     *
     * Two kinds never do. A cancellation is a coroutine being told to stop --
     * the person left the screen -- and "The coroutine scope left the
     * composition" reached the admin page as a quote-link failure (1.279)
     * for exactly that. And a lost connection is the phone, not the code:
     * see [SyncFailure.isTransientNetwork]. Everything else is reported.
     */
    internal fun isWorthReporting(error: Throwable): Boolean =
        error !is kotlinx.coroutines.CancellationException && !SyncFailure.isTransientNetwork(error)

    /** Signatures of the non-fatal reports already written by this process. */
    private val reportedThisRun: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    /**
     * Once per process for the same failure in the same place.
     *
     * Sync reports once per pass, and a pass runs every minute while the app
     * is open, so one fault that nobody had fixed yet filed 157 identical
     * "push time_entries: 2 of 7 rows rejected" rows -- and, worse, filled
     * the pending file to its cap, where anything after them (a real crash
     * included) was dropped unwritten. One per run still says how many runs
     * it hit, which is the number worth knowing.
     */
    internal fun firstThisRun(where: String, error: Throwable): Boolean =
        reportedThisRun.add(signature(where, error.message ?: error::class.java.simpleName))

    /**
     * A failure's identity with the parts that vary between occurrences
     * taken out: numbers (a JSON offset, a row count, a port), hex ids (the
     * "@2383c8e" of a coroutine handler), uuids and query strings. Without
     * this, "offset 1636" and "offset 686" of one decoding bug read as two.
     */
    internal fun signature(where: String, message: String): String =
        where + FIELD + message
            .replace(Regex("""\?\S*"""), "?")
            .replace(Regex("""[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"""), "#")
            .replace(Regex("""@[0-9a-fA-F]+"""), "@#")
            .replace(Regex("""\d+"""), "#")
            .take(300)

    /**
     * What a stack or message must never carry up: the session's access
     * token. postgrest-kt 3.0.2 puts the request headers in every
     * RestException's message -- Authorization: Bearer and all -- so each
     * refused row sent a live token (an hour's worth of this person's
     * access) to app_errors, readable on the admin page. Redacted before the
     * record is even written to disk, and again on the way up for records an
     * older build wrote ([forUpload]). The publishable apikey beside it is
     * public by design and left alone.
     */
    internal fun redact(text: String): String =
        text.replace(Regex("""(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+"""), "$1<redacted>")
            .replace(Regex("""eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+"""), "<redacted-jwt>")

    private fun writePending(
        context: Context,
        error: Throwable,
        fatal: Boolean,
        where: String = currentScreen
    ) = appendTo(
        File(context.filesDir, PENDING_FILE), error, fatal, where,
        versionCode = BuildConfig.VERSION_CODE, versionName = BuildConfig.VERSION_NAME
    )

    /**
     * The on-disk half, split out from [Context] so it can be tested.
     *
     * This is the part worth testing: a record that cannot be parsed back is a
     * crash report that silently never arrives, which looks exactly like no
     * crash at all.
     */
    internal fun appendTo(
        file: File,
        error: Throwable,
        fatal: Boolean,
        where: String,
        // Fields 7 and 8: which BUILD wrote the record. Stamped now, for the
        // same reason email is: reports upload at the NEXT launch, and that
        // launch may be a newer build. Four "1.502" sync failures in
        // app_errors on 2026-09-18 were 1.501's queued reports flushed on
        // 1.502's first launch -- same stack, same R8 line, one timestamp --
        // and they sent a whole investigation after a bug 1.502 did not have.
        versionCode: Int = 0,
        versionName: String = "",
        // Field 9: when it happened, by this phone's clock. app_errors.at is
        // stamped when the row ARRIVES, a launch or more later, so seven
        // startup crashes from one crew phone all read 19:32:13 -- the moment
        // of the upload -- and looked like one burst. Shown at the top of the
        // stack on upload (see [stackWithTime]); the row's own `at` is left as
        // the server's clock, which a phone cannot set wrong.
        recordedAt: Long = System.currentTimeMillis()
    ) {
        // A fatal crash may use the last few places; a non-fatal one may not.
        // The file used to be first come, first kept, so a run of sync notes
        // filled it and the crash that mattered was the one thrown away.
        val cap = if (fatal) MAX_PENDING else MAX_PENDING - FATAL_RESERVE
        if (file.exists() && file.readText().split(RECORD_SEPARATOR).size > cap) return

        val stack = redact(StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString())
        val record = buildString {
            append(if (fatal) "FATAL" else "NONFATAL").append(FIELD)
            append(where.replace(FIELD, ' ')).append(FIELD)
            append(redact(error.message ?: error::class.java.simpleName).take(400).replace(FIELD, ' ')).append(FIELD)
            append(stack.take(8000)).append(FIELD)
            // Fields 5 and 6: who it happened to, as of this moment.
            append(currentEmail.replace(FIELD, ' ')).append(FIELD)
            append(currentCompanyId.replace(FIELD, ' ')).append(FIELD)
            append(versionCode.toString()).append(FIELD)
            append(versionName.replace(FIELD, ' ')).append(FIELD)
            append(recordedAt.toString())
        }
        file.appendText(record + RECORD_SEPARATOR)
    }

    /**
     * The stack as uploaded: when it happened on the phone, then the trace.
     * A record from before field 9 existed goes up exactly as it was.
     */
    internal fun stackWithTime(stack: String, recordedAt: Long?): String =
        if (recordedAt == null || recordedAt <= 0L) stack
        else "Happened at ${java.time.Instant.ofEpochMilli(recordedAt)} (phone clock); uploaded later.\n$stack"

    /**
     * Sends anything waiting, then forgets it.
     *
     * Called at startup once there is a session. Failure is silent and keeps
     * the file: a phone with no signal should try again next launch rather
     * than lose the report.
     */
    fun uploadPending(scope: CoroutineScope, context: Context, companyId: String?, email: String?) {
        if (!uploaded.compareAndSet(false, true)) return
        scope.launch {
            runCatching { upload(context.applicationContext, companyId, email) }
        }
    }

    private suspend fun upload(context: Context, companyId: String?, email: String?) =
        withContext(Dispatchers.IO) {
            if (!SupabaseModule.isConfigured) return@withContext
            val file = File(context.filesDir, PENDING_FILE)
            if (!file.exists() || file.length() == 0L) return@withContext

            val device = "Android ${Build.VERSION.RELEASE} · ${Build.MANUFACTURER} ${Build.MODEL}"
            val records = parse(file.readText()).map {
                forUpload(it, companyId, email, BuildConfig.VERSION_CODE, BuildConfig.VERSION_NAME, device)
            }
            if (records.isEmpty()) { file.delete(); return@withContext }

            SupabaseModule.client.postgrest.from("app_errors").insert(records)
            // Only once it is safely up. Deleting first would lose the report
            // to a dropped connection, which is exactly when crashes cluster.
            file.delete()
        }

    /**
     * One pending record as it goes up. Split out of [upload] so a test can
     * hold it to what it sends.
     *
     * Redacted again here, not only when written: [appendTo] has redacted
     * since this build, but the file on a phone was written by whatever build
     * it ran before, and 29 of the 80 app_errors rows from 2026-09-18 to
     * 09-21 carried a live bearer token. Uploaded untouched, every queued one
     * would reach app_errors on this build's first launch -- within the
     * token's hour, as often as not.
     */
    internal fun forUpload(
        record: CloudError,
        companyId: String?,
        email: String?,
        versionCode: Int,
        versionName: String,
        device: String
    ): CloudError = record.copy(
        // The record's own stamp wins; the upload-time session is
        // only a fallback for records written before stamping.
        companyId = record.companyId ?: companyId,
        email = record.email.ifBlank { email.orEmpty() },
        // The record's own build wins; the uploading build is only
        // a fallback for records written before it was stamped.
        versionCode = record.versionCode.takeIf { code -> code != 0 } ?: versionCode,
        versionName = record.versionName.ifBlank { versionName },
        android = device,
        message = redact(record.message),
        stack = stackWithTime(redact(record.stack), record.recordedAt)
    )

    /**
     * Reads records back. Anything malformed is dropped rather than thrown on:
     * one truncated record (a phone that died mid-write) must not cost us the
     * other nineteen.
     */
    internal fun parse(text: String): List<CloudError> =
        text.split(RECORD_SEPARATOR)
            .filter { it.isNotBlank() }
            .mapNotNull { raw ->
                val parts = raw.split(FIELD)
                if (parts.size < 4) return@mapNotNull null
                CloudError(
                    fatal = parts[0] == "FATAL",
                    whereAt = parts[1],
                    message = parts[2],
                    stack = parts[3],
                    email = parts.getOrNull(4).orEmpty(),
                    companyId = parts.getOrNull(5)?.takeIf { it.isNotBlank() },
                    versionCode = parts.getOrNull(6)?.toIntOrNull() ?: 0,
                    versionName = parts.getOrNull(7).orEmpty(),
                    recordedAt = parts.getOrNull(8)?.trim()?.toLongOrNull() ?: 0L
                )
            }
}

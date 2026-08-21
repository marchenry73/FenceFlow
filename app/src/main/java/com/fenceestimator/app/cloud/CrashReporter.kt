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
    val stack: String = ""
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

    /** Field divider inside one record. Chosen because no stack trace contains it. */
    private val FIELD: Char = Char(1)

    /**
     * Roughly where the user was. Set as screens open, so a crash report says
     * "Estimate" rather than only naming a coroutine somewhere.
     */
    @Volatile
    var currentScreen: String = ""

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
        runCatching { writePending(context.applicationContext, error, fatal = false, where = where) }
    }

    private fun writePending(
        context: Context,
        error: Throwable,
        fatal: Boolean,
        where: String = currentScreen
    ) = appendTo(File(context.filesDir, PENDING_FILE), error, fatal, where)

    /**
     * The on-disk half, split out from [Context] so it can be tested.
     *
     * This is the part worth testing: a record that cannot be parsed back is a
     * crash report that silently never arrives, which looks exactly like no
     * crash at all.
     */
    internal fun appendTo(file: File, error: Throwable, fatal: Boolean, where: String) {
        if (file.exists() && file.readText().split(RECORD_SEPARATOR).size > MAX_PENDING) return

        val stack = StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
        val record = buildString {
            append(if (fatal) "FATAL" else "NONFATAL").append(FIELD)
            append(where.replace(FIELD, ' ')).append(FIELD)
            append((error.message ?: error::class.java.simpleName).take(400).replace(FIELD, ' ')).append(FIELD)
            append(stack.take(8000))
        }
        file.appendText(record + RECORD_SEPARATOR)
    }

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
                it.copy(
                    companyId = companyId,
                    email = email.orEmpty(),
                    versionCode = BuildConfig.VERSION_CODE,
                    versionName = BuildConfig.VERSION_NAME,
                    android = device
                )
            }
            if (records.isEmpty()) { file.delete(); return@withContext }

            SupabaseModule.client.postgrest.from("app_errors").insert(records)
            // Only once it is safely up. Deleting first would lose the report
            // to a dropped connection, which is exactly when crashes cluster.
            file.delete()
        }

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
                    stack = parts[3]
                )
            }
}

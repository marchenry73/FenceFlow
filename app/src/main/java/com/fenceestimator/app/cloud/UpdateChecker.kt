package com.fenceestimator.app.cloud

import com.fenceestimator.app.BuildConfig
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** A build that is available, and what changed in it. */
@Serializable
data class AppRelease(
    @SerialName("version_code") val versionCode: Int,
    @SerialName("version_name") val versionName: String = "",
    val notes: String = "",
    @SerialName("download_url") val downloadUrl: String = "",
    @SerialName("is_mandatory") val isMandatory: Boolean = false
)

/**
 * Tells somebody there is a newer version, because nothing else will.
 *
 * An APK handed out directly has no update mechanism: whoever installs it stays
 * on that version until a person tells them otherwise. That is fine with two
 * phones and unworkable with five companies -- and the case that matters most
 * is the urgent one, where a money bug is fixed and the fix has to actually
 * reach people rather than sit on a Drive folder nobody checks.
 *
 * This is also the only announcement worth showing on launch. A message that
 * appears every time teaches people to dismiss it without reading; one that
 * appears only when something genuinely changed gets read.
 *
 * Play Store's In-App Updates is the better answer once the app is distributed
 * that way. This covers the period before that, which is now.
 */
object UpdateChecker {

    /**
     * Whether this launch has already asked.
     *
     * The check used to sit in a LaunchedEffect on the jobs screen, so it ran
     * again every time that screen was returned to -- which is constantly. An
     * update prompt that reappears on the way back from every job is one people
     * learn to dismiss without reading, including the time it matters.
     *
     * Process-scoped on purpose: "once per launch" means until the app is
     * actually restarted, which is also when installing an update happens.
     */
    @Volatile
    private var askedThisLaunch = false

    /** Resets the once-per-launch guard. For tests. */
    fun resetForTest() { askedThisLaunch = false }

    /**
     * The same as [check], but only ever answers once per launch.
     *
     * Returns null on every later call, whatever the server says.
     */
    suspend fun checkOnce(): AppRelease? {
        if (askedThisLaunch) return null
        askedThisLaunch = true
        return check()
    }

    /**
     * @return the release worth telling the user about, or null when this build
     *   is current -- or when we simply could not tell. A failed check is
     *   silence, never a prompt: interrupting somebody mid-job to say the
     *   update server was unreachable helps nobody.
     */
    suspend fun check(): AppRelease? = withContext(Dispatchers.IO) {
        if (!SupabaseModule.isConfigured) return@withContext null
        runCatching {
            SupabaseModule.client.postgrest.from("app_releases")
                .select {
                    filter { gt("version_code", BuildConfig.VERSION_CODE) }
                    order("version_code", io.github.jan.supabase.postgrest.query.Order.DESCENDING)
                    limit(1)
                }
                .decodeSingleOrNull<AppRelease>()
        }.getOrNull()
    }
}

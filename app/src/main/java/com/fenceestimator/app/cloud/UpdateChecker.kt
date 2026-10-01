package com.fenceestimator.app.cloud

import com.fenceestimator.app.BuildConfig
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
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
 *
 * TWO BUILDS, ONE RULE. The `link` build (handed out by link) self-updates; the
 * `release` build (Play-shaped) must not -- see docs/BUILD_VARIANTS.md and the
 * selfUpdateByBuildType map in app/build.gradle.kts. Every way of asking in this
 * object goes through [checkOutcome], which is the only place that reads
 * BuildConfig.SELF_UPDATE, so no entry point can route around the rule.
 */
object UpdateChecker {

    /**
     * Whether this build offers its own updates at all.
     *
     * True for the link build, false for the Play build and for debug. Callers
     * that draw anything about updates (the settings row, a banner) ask this
     * first rather than reading BuildConfig themselves.
     */
    val selfUpdates: Boolean get() = BuildConfig.SELF_UPDATE

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
     * What came back when somebody asked on purpose.
     *
     * Three members, and deliberately only three: a build that never asks has no
     * answer to put here, and a fourth member would stop compiling every
     * exhaustive `when` over this type. That case is [Attempt.NotSelfUpdating].
     */
    sealed interface CheckResult {
        data class Available(val release: AppRelease) : CheckResult
        data object UpToDate : CheckResult
        /** Asked, got nothing back. NOT the same as being current. */
        data object CouldNotCheck : CheckResult
    }

    /**
     * Whether a question was put to the server at all, and if so what came back.
     *
     * This exists because the three [CheckResult] answers all describe a question
     * that was ASKED. A build that does not self-update never asks, and it used to
     * answer "nothing newer" anyway, which is a claim it had no way to make. Here
     * that case has its own name, so anything that renders the answer can say
     * "this build does not check for updates" instead of "you are up to date".
     */
    sealed interface Attempt {
        /**
         * This build does not self-update (the Play build, or debug). Nothing was
         * asked. NOT current, and NOT unreachable: it did not look.
         */
        data object NotSelfUpdating : Attempt

        /** The question was put to the server; [result] is what came back. */
        data class Asked(val result: CheckResult) : Attempt
    }

    /**
     * Asks now, and says whether it asked at all. Prefer this to [checkNow] for
     * anything that renders the answer in a build that might not self-update.
     */
    suspend fun attemptNow(): Attempt = when (val outcome = checkOutcome()) {
        Outcome.NotSelfUpdating -> Attempt.NotSelfUpdating
        is Outcome.Answered -> Attempt.Asked(
            outcome.release?.let { CheckResult.Available(it) } ?: CheckResult.UpToDate
        )
        Outcome.CouldNotAsk -> Attempt.Asked(CheckResult.CouldNotCheck)
    }

    /**
     * Asks now, and distinguishes the three answers.
     *
     * [check] returns null both when you are current and when the question
     * never got through, which is the mistake this whole file keeps making:
     * a button that says "You are on the latest version" after failing to
     * reach the server is worse than one that says nothing, because it sends
     * somebody away satisfied while the fix they need sits on the server.
     *
     * Only for builds where [selfUpdates] is true. In any other build there is no
     * truthful [CheckResult] to return, so this throws rather than claim one;
     * use [attemptNow] where the build is not known to self-update.
     */
    suspend fun checkNow(): CheckResult = when (val attempt = attemptNow()) {
        is Attempt.Asked -> attempt.result
        Attempt.NotSelfUpdating -> throw IllegalStateException(
            "checkNow() was called in a build that does not self-update. " +
                "Gate on UpdateChecker.selfUpdates, or use attemptNow()."
        )
    }

    /**
     * The same as [check], but only ever answers once per launch.
     *
     * The attempt is only counted as spent when the server actually answered.
     *
     * This mattered more than it looks. Reading the release list requires being
     * signed in, and the check runs as the first screen composes -- which is
     * before Supabase has restored the session. So the first attempt asked as
     * an anonymous user, was refused, and marked itself done: the prompt could
     * then never appear for the rest of that run, however many updates were
     * waiting. It failed exactly like having no updates, which is why it looked
     * like nothing was wrong.
     *
     * A build that does not self-update returns null at once: no question, no
     * retries, and no delay spent waiting on a session it has no use for.
     */
    suspend fun checkOnce(attempts: Int = 4): AppRelease? {
        if (!selfUpdates) return null
        if (askedThisLaunch) return null
        // Keeps asking rather than relying on the caller to fire again. The
        // caller fires on signing in, and signing in is precisely the moment
        // the token has not arrived yet -- so the one attempt landed in the
        // gap and the prompt was gone for the whole run.
        repeat(attempts) { i ->
            when (val outcome = checkOutcome()) {
                is Outcome.Answered -> {
                    askedThisLaunch = true
                    return outcome.release
                }
                Outcome.NotSelfUpdating -> return null
                Outcome.CouldNotAsk -> Unit
            }
            if (i < attempts - 1) delay(1500L * (i + 1))
        }
        // Never asked at all. The attempt stays unspent.
        return null
    }

    private sealed interface Outcome {
        /** The server answered. [release] is null when this build is current. */
        data class Answered(val release: AppRelease?) : Outcome
        /** No session, no network, or the query failed. Nothing was learnt. */
        data object CouldNotAsk : Outcome
        /**
         * This build does not self-update, so nothing was asked. Kept apart from
         * [Answered] on purpose: `Answered(null)` means "I checked and there is
         * nothing newer", and this build never checked.
         */
        data object NotSelfUpdating : Outcome
    }

    private suspend fun checkOutcome(): Outcome {
        // The one place BuildConfig.SELF_UPDATE is read for asking. A Play build
        // never offers its own updates: Play does that, and distributing them
        // any other way is against its policy. Every entry point below comes
        // through here, so nothing can route around it.
        if (!selfUpdates) return Outcome.NotSelfUpdating
        return withContext(Dispatchers.IO) {
            if (!SupabaseModule.isConfigured) return@withContext Outcome.CouldNotAsk
            // No session required any more: the release list is readable without
            // one, because a phone that cannot authenticate is exactly the phone
            // that may need the update most. Version numbers and a link to a
            // public file are not worth guarding.
            runCatching {
                SupabaseModule.client.postgrest.from("app_releases")
                    .select {
                        filter { gt("version_code", BuildConfig.VERSION_CODE) }
                        order("version_code", io.github.jan.supabase.postgrest.query.Order.DESCENDING)
                        limit(1)
                    }
                    .decodeSingleOrNull<AppRelease>()
            }.fold(
                onSuccess = { Outcome.Answered(it) },
                onFailure = { Outcome.CouldNotAsk }
            )
        }
    }

    /**
     * @return the release worth telling the user about, or null when this build
     *   is current -- or when we simply could not tell, or when this build does
     *   not self-update. A failed or skipped check is silence, never a prompt:
     *   interrupting somebody mid-job to say the update server was unreachable
     *   helps nobody.
     *
     * This used to carry its own copy of the query with no SELF_UPDATE test, and
     * the jobs screen calls it every time the app comes back to the front -- so
     * the Play build, which must never offer its own updates, kept offering them
     * through here while every other entry point stayed quiet.
     */
    suspend fun check(): AppRelease? = (checkOutcome() as? Outcome.Answered)?.release
}

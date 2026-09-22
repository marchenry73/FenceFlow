package com.fenceestimator.app

/**
 * What a launch does when the database will not load.
 *
 * Seven fatal "Unable to create application ... AppDatabase_Impl does not
 * exist" reports from one crew phone on 1.512 (2026-09-21), in one burst, on a
 * build that is not broken: the same APK syncs on every other phone, and in it
 * AppDatabase_Impl sits in classes10.dex beside AppDatabase$Companion -- the
 * very code that was running when Room said the class did not exist. Room's
 * "does not exist" is every Class.forName failure there is (ART hands back
 * ClassNotFoundException whatever went wrong, and Room drops the cause), so
 * the words prove nothing about the APK. Application.onCreate building Room
 * unguarded turned every such start into a crash.
 * (The five earlier ones labelled 1.501 were written before reports carried
 * their own build, and are the genuinely broken 1.499.)
 *
 * What made the class loader fail is NOT known. It was not a start in the
 * middle of the package replace, as first thought: the same upload carried a
 * 1.512 sync failure (DeletionReaper, id 355) written BEFORE the seven, and
 * sync only runs once the database has loaded -- so 1.512 had already started
 * cleanly at least once. Background compilation rewriting the app's compiled
 * code is one candidate; it happens whenever the phone decides, and never
 * moves the package's install time. The one report written below carries
 * what the class loader itself said, which is what will settle it.
 *
 * The rule:
 *  - Anything that is not a class failing to load (a migration that throws, a
 *    corrupt file) crashes exactly as before. Nothing here hides a real fault.
 *  - The first time a build cannot load its database classes, the launch
 *    stays up without it, writes ONE non-fatal report, and the next launch
 *    tries again.
 *  - Further failures on the same build stay quiet for [SETTLE_MS] after that
 *    FIRST failure. Measured from the failure, not from the install: the
 *    1.512 burst came after a clean start, possibly long after the install,
 *    and a window counted from the install would already have closed.
 *  - After that it is a broken build, and it crashes and reports as fatal the
 *    way it always did. A genuinely broken build (1.499 was one) still shows.
 *  - A launch that loads clears the count (FenceEstimatorApp), so a later
 *    burst on the same build gets a window of its own.
 *
 * Kept free of Android types so a JVM test can hold the decision to that.
 */
internal object StartupGuard {

    enum class Verdict {
        /** Stay up without the database, record one "update in progress" report. */
        REPORT_AND_WAIT,

        /** Stay up without the database, record nothing: already reported for this build. */
        WAIT,

        /** Throw it. A real fault, or one that outlived the window. */
        CRASH,
    }

    /**
     * How long after a build's first failure to load a class that will not
     * load is still read as the phone settling. Ten minutes: far past any
     * package replace or recompile, and short enough that a broken build is
     * loud before anyone's first job.
     */
    const val SETTLE_MS: Long = 10 * 60 * 1000L

    /**
     * What the phone remembers between launches: which build failed, how many
     * launches of it failed, and when the first of them did. Stored by
     * FenceEstimatorApp; cleared by the first launch that loads.
     */
    data class Tally(val build: Int, val failures: Int, val firstFailureAt: Long)

    /** A failed launch's verdict, and the tally to store for the next one. */
    data class Outcome(val verdict: Verdict, val tally: Tally)

    /**
     * Whether [error] is generated code failing to load, rather than the
     * database itself failing. Room words every Class.forName failure the same
     * way; the class-loading throwables themselves are accepted too, since a
     * dao or entity class failing the same way surfaces raw.
     */
    fun isMissingGeneratedCode(error: Throwable): Boolean =
        generateSequence(error) { it.cause }.take(MAX_CAUSES).any { e ->
            e is ClassNotFoundException || e is NoClassDefFoundError ||
                e.message.orEmpty().let { "Cannot find implementation for" in it && "does not exist" in it }
        }

    /**
     * One failed launch of [build] at [now], against what earlier launches
     * left behind ([remembered], null when nothing was stored). A tally from
     * another build is a different build's trouble and starts again at zero;
     * the first failure of a streak is what the window is measured from, and
     * it is carried forward unchanged, so every later failure is timed
     * against it.
     */
    fun onFailure(error: Throwable, remembered: Tally?, build: Int, now: Long): Outcome {
        val streak = remembered?.takeIf { it.build == build && it.failures > 0 }
        val verdict = decide(error, streak?.failures ?: 0, streak?.let { now - it.firstFailureAt })
        return Outcome(verdict, Tally(build, (streak?.failures ?: 0) + 1, streak?.firstFailureAt ?: now))
    }

    /**
     * @param failuresThisBuild launches of THIS build that already failed this
     *   way (this one not counted). A new build starts again at zero.
     * @param sinceFirstFailureMs how long ago the first of those failed; null
     *   when unknown, which never counts as settling. Negative (the clock was
     *   moved back) does not either.
     */
    fun decide(error: Throwable, failuresThisBuild: Int, sinceFirstFailureMs: Long?): Verdict = when {
        !isMissingGeneratedCode(error) -> Verdict.CRASH
        failuresThisBuild <= 0 -> Verdict.REPORT_AND_WAIT
        sinceFirstFailureMs != null && sinceFirstFailureMs in 0..SETTLE_MS -> Verdict.WAIT
        else -> Verdict.CRASH
    }

    /**
     * The one report a settling launch writes. Its message is fixed so every
     * phone's lands in one group on the admin page; what varies -- how long
     * since the install, what the class loader really said -- rides in the
     * cause, which the stack shows.
     */
    class UpdateInProgress(cause: Throwable) : Exception(
        "Update in progress: the database classes did not load at launch. The app stayed open without them and the next launch tries again.",
        cause
    )

    private const val MAX_CAUSES = 12
}

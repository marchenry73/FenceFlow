package com.fenceestimator.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every way the process can be started goes through the one guarded door to
 * the database (FenceEstimatorApp.startIfPossible, decided by [StartupGuard]).
 *
 * Room used to be built unguarded in Application.onCreate, so a process the
 * system started while the app was being replaced -- a push, the widget, the
 * installer's "Open" -- died before a screen drew: seven fatal reports from
 * one crew phone on 1.512. The guard is only as good as the entry points that
 * respect it, and those need an Android runtime to run, so they are read
 * from source here: one new path that reaches for the database directly
 * brings the crash loop back.
 */
class StartupEntryPointsTest {

    private fun source(rel: String): String =
        listOf(File("src/main/java/com/fenceestimator/app/$rel"), File("app/src/main/java/com/fenceestimator/app/$rel"))
            .first { it.isFile }.readText()

    /** The body of `fun name(` up to the next member declared at the same indent. */
    private fun body(src: String, signature: String): String {
        val start = src.indexOf(signature)
        assertTrue("no $signature", start >= 0)
        val rest = src.substring(start + signature.length)
        val end = Regex("""\n    (override |private |internal |fun |val |var |@|/\*\*)""").find(rest)?.range?.first ?: rest.length
        return rest.substring(0, end)
    }

    @Test
    fun `the database is built in exactly one place, and it is guarded`() {
        val app = source("FenceEstimatorApp.kt")
        assertEquals("AppDatabase.getInstance appears once", 1, Regex("""AppDatabase\.getInstance\(""").findAll(app).count())
        val guarded = body(app, "fun startIfPossible(): Boolean {")
        assertTrue("the build sits inside startIfPossible's try", guarded.contains("try {") &&
            guarded.indexOf("AppDatabase.getInstance(") > guarded.indexOf("try {"))
        assertTrue("and its failure goes to StartupGuard", guarded.contains("StartupGuard.onFailure("))
        assertTrue("which is handed the stored tally, not the install time",
            guarded.contains("prefs.getLong(KEY_FIRST_FAILURE_AT") &&
                !guarded.substringBefore("StartupGuard.onFailure(").contains("lastUpdateTime"))
        assertTrue("and the first failure's time is stored for the next launch",
            guarded.contains(".putLong(KEY_FIRST_FAILURE_AT, outcome.tally.firstFailureAt)"))
        val onCreate = body(app, "override fun onCreate() {")
        assertTrue("onCreate goes through the guard", onCreate.contains("startIfPossible()"))
        assertTrue("onCreate never builds Room itself", !onCreate.contains("AppDatabase") && !onCreate.contains("repository ="))
    }

    @Test
    fun `a push never reaches for the database before the app has started`() {
        val fcm = source("notify/FenceFlowMessagingService.kt")
        val received = body(fcm, "override fun onMessageReceived(message: RemoteMessage) {")
        val gate = received.indexOf("takeIf { it.started }")
        assertTrue("the push checks started", gate >= 0)
        listOf("autoSync", "repository").forEach { member ->
            Regex("""\.\??$member\b""").findAll(received).forEach { use ->
                assertTrue("$member is used before the started check", use.range.first > gate)
            }
        }
    }

    @Test
    fun `the widget never reads the database before the app has started`() {
        val widget = source("widget/TodaysJobsWidgetProvider.kt")
        val gate = widget.indexOf("if (!app.started) return")
        val read = widget.indexOf("app.repository")
        assertTrue("the widget checks started", gate >= 0)
        assertTrue("and does so before its first read", read > gate)
    }

    /**
     * Back on the launcher's own screen only sends the task behind on
     * Android 12 and later: the process that could not load the database
     * lived on, and the next tap brought the same screen back with sync off.
     */
    @Test
    fun `Back on the settling screen closes it, as the Close button does`() {
        val screen = source("ui/onboarding/UpdateSettling.kt")
        val body = screen.substring(screen.indexOf("fun UpdateSettlingScreen(onClose: () -> Unit) {"))
        assertTrue("Back is handled, and handled as Close", body.contains("BackHandler(onBack = onClose)"))
    }

    /** Home or the app switcher leaves it the same way; coming back must ask the guard again. */
    @Test
    fun `coming back to the settling screen asks the guard again`() {
        val activity = source("MainActivity.kt")
        val restart = body(activity, "override fun onRestart() {")
        val ask = restart.indexOf("startIfPossible()")
        assertTrue("onRestart asks the guard while settling", ask >= 0 && restart.contains("if (settling &&"))
        val rebuild = restart.indexOf("recreate()")
        assertTrue("and rebuilds the activity when the database loads", rebuild > ask)
        assertTrue("clearing settling first, so onDestroy leaves the process alone",
            restart.indexOf("settling = false") in (ask + 1) until rebuild)
    }

    @Test
    fun `no screen is drawn before the guard has answered`() {
        val activity = source("MainActivity.kt")
        val onCreate = activity.substring(activity.indexOf("override fun onCreate(savedInstanceState: Bundle?) {"))
        val gate = onCreate.indexOf("app.startIfPossible()")
        assertTrue("MainActivity asks the guard", gate >= 0)
        assertTrue("before the navigation host", onCreate.indexOf("FenceEstimatorNavHost(") > gate)
        assertTrue("and shows the settling screen when it says no",
            onCreate.substring(gate, onCreate.indexOf("FenceEstimatorNavHost(")).contains("UpdateSettlingScreen("))
    }
}

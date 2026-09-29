package com.fenceestimator.app.guest

import com.fenceestimator.app.cloud.Permission
import com.fenceestimator.app.cloud.SessionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The guest demo's "look at everything, change nothing" rule, pinned at both
 * of the two layers it actually lives at -- because it has regressed or
 * shipped incomplete in three consecutive waves and nothing was testing it.
 *
 * THE CHOKE POINT. JobDetailViewModel, RunEditViewModel and SurveyViewModel
 * each refuse a write when `session.state.value.isGuestDemo` (or
 * SurveyViewModel's own `viewerIsGuestDemo()`, which reads the same flag
 * through the application context) is true. This is the layer that actually
 * stops a byte from being written, and it is where every real vulnerability
 * this wave fixed -- the photo upload, the teardown-charge switch, the
 * drawing screen having no check at all -- was found.
 *
 * It cannot be constructed off-device in this module, and rather than write
 * a test that asserts nothing, that is said plainly here instead:
 *
 *  - `Repository` (`app/src/main/java/.../data/Repository.kt`) is
 *    `class Repository(private val db: AppDatabase)`, and `AppDatabase` is a
 *    Room database. Building a real one needs Room's generated
 *    `_Impl` class and a SQLite driver, neither of which exists off an
 *    Android runtime or Robolectric.
 *  - Even given a `Repository`, every one of the three view models opens
 *    with a property initializer that calls `.stateIn(viewModelScope, ...)`
 *    in the class body -- eager, not lazy. `viewModelScope` resolves to
 *    `Dispatchers.Main.immediate`, and this module's `testImplementation` is
 *    exactly `junit:junit:4.13.2` (checked directly against
 *    `app/build.gradle.kts`) -- no `kotlinx-coroutines-android`, no
 *    `kotlinx-coroutines-test`, no Robolectric. `stateIn`'s internal
 *    `launch` dispatches onto that missing Main dispatcher immediately,
 *    which throws `IllegalStateException` at construction, before a single
 *    test method body would even run.
 *  - `SurveyViewModel` additionally takes a real `android.content.Context`
 *    and reads the session by casting `appContext.applicationContext` to
 *    `FenceEstimatorApp` -- there is no fake `Context` to hand it without a
 *    mocking library, which this module also does not have.
 *
 * So the choke point is pinned here as SOURCE TEXT instead: every function
 * that must refuse a guest is checked to open with that refusal as its
 * first statement, not merely to contain the words somewhere in its body.
 * `SessionState` itself -- a plain data class with no Android or Repository
 * dependency -- IS constructible off-device, so the boolean the guard reads
 * (`isGuestDemo`, and the permission set behind it) is tested directly and
 * for real, not just referenced by name.
 *
 * THE VISIBLE LAYER. Which controls a guest is even OFFERED lives in
 * Compose functions, which are equally unreachable off-device. This repo
 * already has a precedent for pinning that from source text --
 * `ui/jobs/CrewAccessUiGatesTest.kt` -- and every check below follows its
 * idiom: read the file as text, extract the block that matters by matching
 * braces from a marker, assert on what is inside it.
 *
 * THE TRAP. A checker anchored to a label, an assignment target or a string
 * someone will casually reword rots into one that cannot pass -- or worse,
 * crashes on a bad index instead of reporting a verdict. Every helper below
 * fails with a message naming exactly what it was looking for rather than
 * indexing blind, and every anchor is a piece of code that carries the
 * MEANING of the gate (a permission name, a guard expression, a parameter
 * that is actually wired to a control's `enabled`) rather than a comment, a
 * button's visible text or a variable name chosen for style.
 *
 * TEETH. Every source-text assertion here has a companion that proves it
 * would fail if the gate it checks were removed -- either by re-running the
 * same check against a hand-written "before" snippet representing the code
 * this wave found and fixed, or by deleting the guard from a REAL extracted
 * block and re-running the same check against that. An assertion with no
 * such companion has not been shown to be able to fail.
 */
class GuestReadOnlyTest {

    // =====================================================================
    // Reading source and resource files off disk.
    // =====================================================================

    private fun src(rel: String): String {
        val bases = listOf(
            File("src/main/java/com/fenceestimator/app"),
            File("app/src/main/java/com/fenceestimator/app")
        )
        val base = bases.firstOrNull { it.isDirectory }
            ?: error("could not locate sources from ${File(".").absolutePath}")
        // Line endings follow the checkout, not the code.
        return File(base, rel).readText().replace("\r\n", "\n")
    }

    private fun resText(rel: String): String {
        val bases = listOf(File("src/main/res"), File("app/src/main/res"))
        val base = bases.firstOrNull { it.isDirectory }
            ?: error("could not locate resources from ${File(".").absolutePath}")
        return File(base, rel).readText().replace("\r\n", "\n")
    }

    // =====================================================================
    // Source-text extraction. See the class doc's "THE TRAP" section for
    // why every failure here names what it was looking for.
    // =====================================================================

    /** Where the [openChar] at [openIndex] is closed, tracking depth. -1 if unbalanced. */
    private fun matchingClose(text: String, openIndex: Int, openChar: Char, closeChar: Char): Int {
        var depth = 0
        var i = openIndex
        while (i < text.length) {
            when (text[i]) {
                openChar -> depth++
                closeChar -> { depth--; if (depth == 0) return i }
            }
            i++
        }
        return -1
    }

    /**
     * [marker] to the brace that closes the one it opens. [marker] must end
     * in the block's own `{` (e.g. `"if (editable) {"`), the same
     * convention `CrewAccessUiGatesTest.block()` uses.
     */
    private fun block(text: String, marker: String, what: String, from: Int = 0): String {
        val start = text.indexOf(marker, from)
        if (start < 0) {
            error("the gate I was checking for is gone or was renamed: $what (looked for: `$marker`)")
        }
        val open = start + marker.length - 1
        if (text[open] != '{') {
            error("marker for $what must end in the block's own `{`: `$marker`")
        }
        val close = matchingClose(text, open, '{', '}')
        if (close < 0) error("unbalanced braces after $what")
        return text.substring(start, close + 1)
    }

    /**
     * A named function's own text, its `fun` keyword to its closing brace.
     *
     * Finds the parameter list's matching `)` first and only looks for the
     * body's `{` after that, rather than the first `{` anywhere past the
     * signature -- SurveyViewModel.editRun's `onMissing: () -> Unit = {}`
     * default puts a `{}` inside the parameter list itself, well short of
     * the real body, and a naive scan stops there instead.
     */
    private fun functionBody(text: String, name: String, from: Int = 0): String {
        val sig = Regex("""(private |internal |protected )?(suspend )?fun\s+${Regex.escape(name)}\s*\(""")
        val m = sig.find(text, from)
            ?: error("the gate I was checking for is gone or was renamed: function $name not found")
        val parenOpen = m.range.last
        val parenClose = matchingClose(text, parenOpen, '(', ')')
        if (parenClose < 0) error("unbalanced parens in the signature of $name")
        val braceOpen = text.indexOf('{', parenClose)
        if (braceOpen < 0) error("no body follows the signature of $name")
        val braceClose = matchingClose(text, braceOpen, '{', '}')
        if (braceClose < 0) error("unbalanced braces in the body of $name")
        return text.substring(m.range.first, braceClose + 1)
    }

    /**
     * Where [body] (a function's own text, as [functionBody] returns it --
     * signature onward) actually opens its body -- i.e. re-derives the same
     * brace [functionBody] already found, rather than taking the first `{`
     * in the string.
     *
     * The naive `body.indexOf('{')` this replaced was wrong for exactly the
     * case its own author called out in [functionBody]'s doc comment as
     * hand-checked: a default-value lambda in the parameter list, e.g.
     * `onMissing: () -> Unit = {}`, puts a `{` well before the real body
     * does. That earlier `{` made SurveyViewModel.editRun -- the one function
     * in this file with such a default -- read as never opening with its
     * guard, misreporting a guard that genuinely is the first statement (verified
     * by reading editRun itself) as absent. Skipping to the parameter list's
     * own matching `)` first, the same way [functionBody] locates the body,
     * is immune to that: a `{` inside the parameter list never affects a scan
     * that is only counting `(` and `)`.
     *
     * Throws, naming what it could not parse, rather than returning a guess --
     * a probe that cannot read the code must say so, not report a verdict
     * (a present guard read as absent, or an absent one read as present)
     * that happens to be wrong.
     */
    private fun realBodyOpenBrace(body: String): Int {
        val sig = Regex("""fun\s+\w+\s*\(""")
        val m = sig.find(body)
            ?: error("opensWith could not find a `fun name(` signature to locate the real body brace from, in: ${body.take(80)}")
        val parenOpen = m.range.last
        val parenClose = matchingClose(body, parenOpen, '(', ')')
        if (parenClose < 0) {
            error("opensWith could not match the parameter list's closing paren, in: ${body.take(80)}")
        }
        val braceOpen = body.indexOf('{', parenClose)
        if (braceOpen < 0) {
            error("opensWith could not find a body brace after the signature, in: ${body.take(80)}")
        }
        return braceOpen
    }

    /**
     * True when [body] refuses on [guardExpr] as its first real statement --
     * comments may come before it, any other statement disqualifies it. A
     * guard bolted on after the write it is meant to stop is not a guard.
     */
    private fun opensWith(body: String, guardExpr: String): Boolean {
        val open = realBodyOpenBrace(body)
        val first = body.substring(open + 1).lineSequence()
            .map { it.trim() }
            .firstOrNull { it.isNotEmpty() && !it.startsWith("//") && !it.startsWith("*") }
            ?: return false
        return first.startsWith(guardExpr)
    }

    private fun count(text: String, needle: String): Int {
        var c = 0
        var i = 0
        while (true) {
            i = text.indexOf(needle, i)
            if (i < 0) return c
            c++
            i += needle.length
        }
    }

    /** [a] then [b] with at most a short gap between, tolerant of reformatting/whitespace. */
    private fun wired(text: String, a: String, b: String, maxGap: Int = 200): Boolean =
        Regex(Regex.escape(a) + "[\\s\\S]{0,$maxGap}?" + Regex.escape(b)).containsMatchIn(text)

    /**
     * The boolean condition of the `if (...) { ... }` that directly encloses
     * [callSiteMarker], found by walking outward from the call site itself
     * rather than matching any particular spelling of the condition.
     *
     * This is what [conditionGuarding] replaces a literal-text anchor with:
     * the refund control's gate legitimately grew from
     * `if (session.canRecordRefunds) {` to
     * `if (session.canRecordRefunds && session.canRequestPayment) {`, and a
     * check pinned to the old text can only ever fail from there on, no
     * matter how correct the new code is. Reading the condition out and
     * handing it to [permissionTokens] instead means a reordering of the two
     * terms, or a reflow onto several lines, leaves the verdict unchanged --
     * only which permissions are actually named changes it.
     *
     * Confirms the nearest `if (` before the call site actually encloses it
     * (its block runs at least to the call site) before trusting it, and
     * fails with a message naming what it was looking for otherwise -- same
     * idiom as [block] and [functionBody], for the same reason: a probe that
     * cannot find its anchor must say so, not report a guess.
     */
    private fun conditionGuarding(text: String, callSiteMarker: String, what: String): String {
        val callIndex = text.indexOf(callSiteMarker)
        if (callIndex < 0) {
            error("the call I was checking for is gone or was renamed: $what (looked for: `$callSiteMarker`)")
        }
        val ifStart = text.lastIndexOf("if (", callIndex)
        if (ifStart < 0) error("no `if (` gate found before $what's call site (looked for: `$callSiteMarker`)")
        val parenOpen = ifStart + "if (".length - 1
        val parenClose = matchingClose(text, parenOpen, '(', ')')
        if (parenClose < 0) error("unbalanced parens in the condition guarding $what")
        val braceOpen = text.indexOf('{', parenClose)
        if (braceOpen < 0) error("no block follows the condition guarding $what")
        val braceClose = matchingClose(text, braceOpen, '{', '}')
        if (braceClose < 0) error("unbalanced braces in the block guarding $what")
        if (callIndex !in braceOpen..braceClose) {
            error(
                "the nearest `if (` before $what's call site does not actually enclose it -- " +
                    "the gate may have moved (looked for: `$callSiteMarker`)"
            )
        }
        return text.substring(parenOpen + 1, parenClose)
    }

    /**
     * Every `session.canXxx` permission token named in [condition] -- meaning
     * anchored rather than position anchored, so `a && b` and `b && a` (or
     * either reflowed onto its own line) read the same.
     */
    private fun permissionTokens(condition: String): Set<String> =
        Regex("""session\.\w+""").findAll(condition).map { it.value }.toSet()

    private fun assertOpensWithGuard(where: String, name: String, body: String, guardExpr: String) {
        assertTrue(
            "$where.$name() does not refuse a guest as its first statement " +
                "(expected the body to open with `$guardExpr`, after comments only); " +
                "the gate may have been removed, reordered after a write, or renamed",
            opensWith(body, guardExpr)
        )
    }

    // =====================================================================
    // SECTION 1 -- the choke point's decision, as real production code.
    //
    // SessionState is a plain data class: no Android, no Repository. This
    // is the one place in this whole file that runs the actual app logic
    // rather than reading it as text.
    // =====================================================================

    @Test
    fun `a guest demo session carries exactly GUEST_READ_ONLY`() {
        val guest = SessionState(signedIn = false, guestDemo = true, guestKnown = true)
        assertTrue(guest.isGuestDemo)
        assertEquals(SessionState.GUEST_READ_ONLY, guest.permissions)
    }

    @Test
    fun `isGuestDemo is true only signed out with the demo flag on`() {
        assertTrue(
            "a signed-out demo must read as the guest demo",
            SessionState(signedIn = false, guestDemo = true, guestKnown = true).isGuestDemo
        )
        assertFalse(
            "signing in must never leave isGuestDemo true, even if the demo flag lingers",
            SessionState(signedIn = true, guestDemo = true, guestKnown = true).isGuestDemo
        )
        assertFalse(
            "signed out with no demo running is the solo-owner case, not a guest",
            SessionState(signedIn = false, guestDemo = false, guestKnown = true).isGuestDemo
        )
    }

    /** Every [Permission] a guest must NOT hold, from the enum itself -- not a hand-copied list. */
    private fun forbiddenGuestWrites(perms: Set<Permission>): Set<Permission> =
        perms - SessionState.GUEST_READ_ONLY

    @Test
    fun `a guest demo cannot do any of the twelve things a write requires`() {
        val guest = SessionState(signedIn = false, guestDemo = true, guestKnown = true)
        val leaked = forbiddenGuestWrites(guest.permissions)
        assertTrue("a guest session leaked write permissions: $leaked", leaked.isEmpty())

        // Named individually too, so a failure here says which capability
        // leaked rather than just "the set differs".
        listOf(
            Permission.EDIT_JOBS, Permission.EDIT_CATALOG_AND_SETTINGS, Permission.SCHEDULE_AND_ASSIGN,
            Permission.REQUEST_PAYMENT, Permission.RECORD_REFUNDS, Permission.RECORD_FIELD_WORK,
            Permission.APPROVE_TIME, Permission.APPROVE_PLAN_CHANGES, Permission.DELETE_RECORDS,
            Permission.SHARE_INVITE_CODE, Permission.MANAGE_ACCESS, Permission.SEE_PAY
        ).forEach { perm ->
            assertFalse("a guest must not hold $perm", guest.can(perm))
        }
        // And the three the demo deliberately DOES carry, so this test is
        // pinned to "exactly read-only", not to "as restricted as possible".
        assertTrue(guest.canSeeMoney)
        assertTrue(guest.canSeeCustomerContact)
        assertTrue(guest.canSeeReports)
    }

    @Test
    fun `the forbidden-writes check has teeth -- planted failure`() {
        // A fabricated permission set, standing in for what SessionState
        // would compute if GUEST_READ_ONLY were ever widened by mistake.
        val widened = SessionState.GUEST_READ_ONLY + Permission.EDIT_JOBS
        val leaked = forbiddenGuestWrites(widened)
        assertTrue("the check should have caught the widened permission", leaked.contains(Permission.EDIT_JOBS))
        // ...and confirmed clean against the real, unwidened set.
        assertTrue(forbiddenGuestWrites(SessionState.GUEST_READ_ONLY).isEmpty())
    }

    // =====================================================================
    // SECTION 2 -- the choke point, pinned as source text (see class doc).
    // =====================================================================

    // ---- RunEditViewModel: the run editor's second line of defence -------

    @Test
    fun `RunEditViewModel takes the session so update() has something to ask`() {
        val text = src("ui/runs/RunEditViewModel.kt")
        // A direct substring, not block()-extraction: the class header is a
        // multi-line constructor followed by `: ViewModel() {`, and block()'s
        // marker convention (marker ends in the block's own `{`) does not fit
        // a constructor parameter list at all -- there is no single `{` to
        // anchor on until well past where the parameter lives.
        assertTrue(
            "RunEditViewModel's constructor must take a `session: SessionManager` parameter, " +
                "the same reference update() reads live",
            text.contains("private val session: SessionManager")
        )
    }

    @Test
    fun `RunEditViewModel update() refuses a guest before touching the repository`() {
        val body = functionBody(src("ui/runs/RunEditViewModel.kt"), "update")
        assertOpensWithGuard("RunEditViewModel", "update", body, "if (session.state.value.isGuestDemo) return")
    }

    @Test
    fun `RunEditViewModel update() guard -- planted failure`() {
        val body = functionBody(src("ui/runs/RunEditViewModel.kt"), "update")
        val stripped = body.replaceFirst("if (session.state.value.isGuestDemo) return\n", "")
        assertTrue("the real body must open with the guard", opensWith(body, "if (session.state.value.isGuestDemo) return"))
        assertFalse("the check must go red once the guard line is removed", opensWith(stripped, "if (session.state.value.isGuestDemo) return"))
    }

    // ---- JobDetailViewModel: the job screen's write funnel ----------------

    /**
     * Every function on JobDetailViewModel that writes to the repository and
     * bypasses (or is) the shared `update()` funnel. Taken from the file's
     * own inventory (`update`'s own KDoc names the ones that bypass it), not
     * guessed at -- a function missing from this list is a function this
     * test does not check, which is exactly the gap that let addPhoto()
     * write through unguarded for however long it did.
     */
    private val jobDetailWriteFunnel = listOf(
        "update", "addPhoto", "addExpense", "addPunchListItem", "togglePunchListItem",
        "addChangeOrder", "signChangeOrder", "updateChangeOrder",
        "acknowledgeFieldChanges", "reconcilePaymentStatus"
    )

    @Test
    fun `every JobDetailViewModel write funnel opens with the guest refusal`() {
        val text = src("ui/jobs/JobDetailViewModel.kt")
        jobDetailWriteFunnel.forEach { name ->
            val body = functionBody(text, name)
            assertOpensWithGuard("JobDetailViewModel", name, body, "if (session.state.value.isGuestDemo) return")
        }
    }

    @Test
    fun `JobDetailViewModel addPhoto() guard -- planted failure`() {
        // addPhoto is the one that "actually wrote": Camera and Gallery had
        // no gate of their own either, so this is the highest-stakes single
        // function in the funnel.
        val body = functionBody(src("ui/jobs/JobDetailViewModel.kt"), "addPhoto")
        assertTrue(opensWith(body, "if (session.state.value.isGuestDemo) return"))
        val stripped = body.replaceFirst("if (session.state.value.isGuestDemo) return\n", "")
        assertFalse(
            "the sweep test must go red if addPhoto()'s guard is removed",
            opensWith(stripped, "if (session.state.value.isGuestDemo) return")
        )
    }

    @Test
    fun `the JobDetailViewModel sweep actually visits every named function -- planted failure`() {
        // Proves the sweep is not vacuously green because a name was
        // spelled wrong or the function since renamed: a name that does not
        // exist must fail loudly, not be silently skipped.
        val text = src("ui/jobs/JobDetailViewModel.kt")
        try {
            functionBody(text, "addPhotoXXXNotAFunction")
            org.junit.Assert.fail("expected functionBody() to fail loudly for a function that does not exist")
        } catch (e: IllegalStateException) {
            assertTrue(e.message.orEmpty().contains("not found"))
        }
    }

    // ---- SurveyViewModel: the drawing screen's write funnel ---------------

    @Test
    fun `SurveyViewModel editRun -- the shared funnel -- refuses a guest before reading the run`() {
        val body = functionBody(src("ui/survey/SurveyViewModel.kt"), "editRun")
        assertOpensWithGuard("SurveyViewModel", "editRun", body, "if (viewerIsGuestDemo()) {")
    }

    @Test
    fun `SurveyViewModel editRun guard -- planted failure`() {
        val body = functionBody(src("ui/survey/SurveyViewModel.kt"), "editRun")
        // Regex.replaceFirst() is called ON the Regex (input, replacement),
        // not as a CharSequence extension -- that overload does not exist.
        val guardBlock = Regex("""if \(viewerIsGuestDemo\(\)\) \{\s*onMissing\(\)\s*return\s*\}\s*""")
        val stripped = guardBlock.replaceFirst(body, "")
        assertTrue(opensWith(body, "if (viewerIsGuestDemo()) {"))
        assertFalse(
            "the check must go red once editRun's guard block is removed",
            opensWith(stripped, "if (viewerIsGuestDemo()) {")
        )
    }

    /**
     * Every SurveyViewModel function that writes directly (not through the
     * editRun funnel) and must carry its own `viewerIsGuestDemo()` refusal.
     * 14 in total with editRun, matching the wave's own inventory.
     */
    private val surveyDirectGuardFunnel = listOf(
        "importImage", "applyCalibration", "addSiteMarker", "deleteSiteMarker", "addGate", "addRun",
        "setTeardownCharge", "moveSiteMarker", "ensureGridCalibration", "setGridExtent",
        "resetGridCalibration", "setGridLineSpacingFt", "clearSurveyImage"
    )

    @Test
    fun `every direct-write SurveyViewModel function opens with the guest refusal`() {
        val text = src("ui/survey/SurveyViewModel.kt")
        surveyDirectGuardFunnel.forEach { name ->
            val body = functionBody(text, name)
            assertOpensWithGuard("SurveyViewModel", name, body, "if (viewerIsGuestDemo()) return")
        }
    }

    @Test
    fun `SurveyViewModel setTeardownCharge refuses a guest before it ever asks about money`() {
        // The one gap this wave actually found: the guest demo deliberately
        // carries SEE_MONEY, so viewerMaySeeMoney() alone would have let a
        // guest flip this switch. The guest check has to come FIRST, not
        // merely be present somewhere in the function.
        val body = functionBody(src("ui/survey/SurveyViewModel.kt"), "setTeardownCharge")
        assertOpensWithGuard("SurveyViewModel", "setTeardownCharge", body, "if (viewerIsGuestDemo()) return")
        val guardAt = body.indexOf("if (viewerIsGuestDemo()) return")
        val moneyCheckAt = body.indexOf("if (!viewerMaySeeMoney()) return")
        assertTrue("expected both checks to be present", guardAt >= 0 && moneyCheckAt >= 0)
        assertTrue("the guest refusal must come before the money check, not after it", guardAt < moneyCheckAt)
    }

    @Test
    fun `SurveyViewModel setTeardownCharge guard -- planted failure`() {
        val body = functionBody(src("ui/survey/SurveyViewModel.kt"), "setTeardownCharge")
        val stripped = body.replaceFirst("if (viewerIsGuestDemo()) return\n", "")
        assertFalse(
            "removing the guest guard must leave viewerMaySeeMoney() as the effective first check, " +
                "which is exactly the hole this wave closed",
            opensWith(stripped, "if (viewerIsGuestDemo()) return")
        )
        assertTrue(
            "and the stripped body should now open with the money check instead, proving the mutation is real",
            opensWith(stripped, "if (!viewerMaySeeMoney()) return")
        )
    }

    /**
     * The point/segment/undo/redo/gate-move/gate-remove family: these carry
     * no direct `viewerIsGuestDemo()` guard of their own because they route
     * every write through the guarded [editRun] funnel instead. Pinned here
     * so a future edit that "helpfully" inlines one of these and bypasses
     * editRun does not quietly drop its only guard.
     */
    private val editRunFunnelCallers = listOf(
        "addDrawPoint", "setSegmentLengthFeet", "movePoint", "undoLast", "redo",
        "clearPoints", "toggleClosedLoop", "moveGate", "removeGate"
    )

    @Test
    fun `the point, segment, undo, redo and gate edits all write only through editRun`() {
        val text = src("ui/survey/SurveyViewModel.kt")
        editRunFunnelCallers.forEach { name ->
            val body = functionBody(text, name)
            assertTrue(
                "$name() must call the guarded editRun(...) funnel rather than writing directly " +
                    "-- it carries no guard of its own on the assumption that it does",
                body.contains("editRun(")
            )
        }
    }

    @Test
    fun `the editRun-funnel check has teeth -- planted failure`() {
        val text = src("ui/survey/SurveyViewModel.kt")
        val body = functionBody(text, "movePoint")
        assertTrue(body.contains("editRun("))
        val rerouted = body.replace("editRun(_selectedRunId.value)", "repository.updateFenceRunDirectly()")
        assertFalse(
            "the check must go red if a write is rerouted around the editRun funnel",
            rerouted.contains("editRun(")
        )
    }

    @Test
    fun `eraseSelectedRun needs no guest guard of its own -- DELETE_RECORDS already closes it`() {
        // Documents and pins the design decision: deletion is refused by
        // viewerMayDelete(), and Section 1 above proves DELETE_RECORDS is
        // never in GUEST_READ_ONLY, so this is not a gap -- but if someone
        // ever adds DELETE_RECORDS to the guest set, THIS is the function
        // that would start trusting that mistake.
        val body = functionBody(src("ui/survey/SurveyViewModel.kt"), "eraseSelectedRun")
        assertTrue(
            "eraseSelectedRun() must still ask viewerMayDelete() as its first check",
            opensWith(body, "if (!viewerMayDelete()) return")
        )
        val guest = SessionState(signedIn = false, guestDemo = true, guestKnown = true)
        assertFalse("and DELETE_RECORDS must still be absent from what a guest can do", guest.canDelete)
    }

    // =====================================================================
    // SECTION 3 -- the visible layer: which controls are even offered.
    // Idiom borrowed from ui/jobs/CrewAccessUiGatesTest.kt.
    // =====================================================================

    // ---- SurveyDrawScreen: the mode switcher and its second line --------

    @Test
    fun `a guest's mode switcher offers only Move View -- every write tool is withheld`() {
        val text = src("ui/survey/SurveyDrawScreen.kt")
        assertTrue(
            "expected editable to be defined from the guest flag",
            text.contains("val editable = !session.isGuestDemo")
        )
        val modes = block(text, "val visibleModes = remember(usingGrid, editable) {", "the drawing mode switcher")
        val editableGate = block(modes, "if (editable) {", "the write-tool gate inside visibleModes")
        listOf(
            "add(SurveyMode.DRAW to R.string.mode_draw)",
            "add(SurveyMode.GATE to R.string.mode_gate)",
            "add(SurveyMode.MARKER to R.string.mode_mark_site)",
            "add(SurveyMode.ADJUST to R.string.mode_adjust)"
        ).forEach { modeAdd ->
            assertTrue("$modeAdd must be inside the editable gate", editableGate.contains(modeAdd))
        }
        // PAN must be offered UNCONDITIONALLY -- outside the editable gate,
        // not merely present somewhere in the remember{} block.
        val panIndex = modes.indexOf("add(SurveyMode.PAN to R.string.mode_move_view)")
        val gateEndIndex = modes.indexOf(editableGate) + editableGate.length
        assertTrue("PAN must be present", panIndex >= 0)
        assertTrue("PAN must be added AFTER the editable gate closes, i.e. unconditionally", panIndex >= gateEndIndex)
    }

    @Test
    fun `the mode switcher check has teeth -- planted failure`() {
        val text = src("ui/survey/SurveyDrawScreen.kt")
        val modes = block(text, "val visibleModes = remember(usingGrid, editable) {", "the drawing mode switcher")
        // Simulates the pre-fix shape: every mode, including the write
        // tools, added unconditionally with no editable gate at all.
        val before = """
            buildList {
                add(SurveyMode.DRAW to R.string.mode_draw)
                add(SurveyMode.GATE to R.string.mode_gate)
                add(SurveyMode.MARKER to R.string.mode_mark_site)
                add(SurveyMode.ADJUST to R.string.mode_adjust)
                add(SurveyMode.PAN to R.string.mode_move_view)
            }
        """.trimIndent()
        assertFalse(
            "the before-snippet has no editable gate at all, so extracting one must fail",
            runCatching { block(before, "if (editable) {", "planted") }.isSuccess
        )
        assertTrue("sanity: the real modes block does have the gate", modes.contains("if (editable) {"))
    }

    @Test
    fun `a demo that starts mid-visit is bounced back to Move View`() {
        val text = src("ui/survey/SurveyDrawScreen.kt")
        val effect = block(text, "LaunchedEffect(editable) {", "the mid-visit guest guard")
        assertTrue(
            "expected the effect to force PAN the moment editable turns false",
            wired(effect, "!editable", "viewModel.setMode(SurveyMode.PAN)")
        )
    }

    @Test
    fun `the mid-visit guard check has teeth -- planted failure`() {
        val before = "LaunchedEffect(Unit) { }"
        assertFalse(
            "a snippet with no such effect must not satisfy the check",
            runCatching { block(before, "LaunchedEffect(editable) {", "planted") }
                .fold({ wired(it, "!editable", "viewModel.setMode(SurveyMode.PAN)") }, { false })
        )
    }

    @Test
    fun `the empty-state Add Run buttons -- the one path that writes today -- are gone for a guest`() {
        val text = src("ui/survey/SurveyDrawScreen.kt")
        val emptyState = block(text, "if (runs.isEmpty()) {", "the no-runs empty state")
        val gate = block(emptyState, "if (editable) {", "the empty-state add-run gate")
        assertTrue(
            "the new-run button must be inside the editable gate",
            gate.contains("viewModel.addRun(runDefaults, isTeardown = false)")
        )
        assertTrue(
            "the teardown-run button must be inside the editable gate",
            gate.contains("viewModel.addRun(runDefaults, isTeardown = true)")
        )
        // EmptyState() itself (the "no runs yet" message) must render
        // OUTSIDE and before the gate -- a guest still gets to look.
        val emptyStateTextIndex = emptyState.indexOf("EmptyState(stringResource(R.string.draw_no_runs_yet))")
        val gateStartIndex = emptyState.indexOf(gate)
        assertTrue("the empty-state message must render", emptyStateTextIndex >= 0)
        assertTrue("the empty-state message must render before (outside) the editable gate", emptyStateTextIndex < gateStartIndex)
    }

    @Test
    fun `the empty-state Add Run check has teeth -- planted failure`() {
        // The pre-fix shape: both buttons offered with no gate at all.
        val before = """
            if (runs.isEmpty()) {
                Column {
                    EmptyState(stringResource(R.string.draw_no_runs_yet))
                    Button(onClick = { viewModel.addRun(runDefaults, isTeardown = false) }) { }
                    OutlinedButton(onClick = { viewModel.addRun(runDefaults, isTeardown = true) }) { }
                }
            }
        """.trimIndent()
        val emptyState = block(before, "if (runs.isEmpty()) {", "planted empty state")
        assertFalse(
            "the planted before-snippet must fail to yield an editable gate, proving the check has teeth",
            runCatching { block(emptyState, "if (editable) {", "planted") }.isSuccess
        )
    }

    @Test
    fun `the toolbar's plus Add Run menu is gone for a guest too`() {
        val text = src("ui/survey/SurveyDrawScreen.kt")
        val gate = block(text, "if (editable) Box {", "the toolbar add-run menu gate")
        assertTrue(
            "the new-run menu item must be inside the editable gate",
            gate.contains("viewModel.addRun(runDefaults, isTeardown = false)")
        )
        assertTrue(
            "the teardown-run menu item must be inside the editable gate",
            gate.contains("viewModel.addRun(runDefaults, isTeardown = true)")
        )
    }

    @Test
    fun `the toolbar Add Run check has teeth -- planted failure`() {
        val before = "Box { ToolIconButton(onClick = { addRunMenuExpanded = true }) }"
        assertFalse(
            "a snippet with no `if (editable) Box {` gate must not satisfy the check",
            runCatching { block(before, "if (editable) Box {", "planted") }.isSuccess
        )
    }

    @Test
    fun `the property panel disables its writing controls for a guest`() {
        val body = functionBody(src("ui/survey/SurveyDrawScreen.kt"), "PropertyInfoPanel")
        // The segment-length chip and the closed-loop checkbox are DISABLED
        // (still visible, cannot be pressed) -- at least twice for "enabled
        // = editable" (one is inside a for-loop over segments, so this is a
        // floor, not an exact count).
        assertTrue(
            "expected at least the segment chip and the closed-loop checkbox to read `enabled = editable`, found ${count(body, "enabled = editable")}",
            count(body, "enabled = editable") >= 2
        )
        // Clear is HIDDEN outright, not merely disabled -- an OutlinedButton
        // whose onClick is onClear must sit inside its own editable gate.
        val clearGate = block(body, "if (editable) {", "the Clear-button gate inside PropertyInfoPanel")
        assertTrue("the Clear button must be inside its own editable gate", clearGate.contains("onClick = onClear"))
    }

    @Test
    fun `the property panel check has teeth -- planted failure`() {
        val before = """
            Row {
                OutlinedButton(onClick = onClear) { Text("Clear") }
            }
        """.trimIndent()
        assertFalse(
            "a snippet with Clear offered unconditionally must not satisfy the check",
            runCatching { block(before, "if (editable) {", "planted") }.isSuccess
        )
    }

    @Test
    fun `the Layers dialog disables every writing control for a guest`() {
        val body = functionBody(src("ui/survey/SurveyDrawScreen.kt"), "LayersDialog")
        // Grid/satellite choice, upload, the grid-size chips, the spacing
        // field and use-grid: six controls that write, each `enabled =
        // editable`. A floor, generous enough to tolerate a reflow.
        val n = count(body, "enabled = editable")
        assertTrue("expected at least 6 writing controls gated on editable inside LayersDialog, found $n", n >= 6)
    }

    @Test
    fun `the Layers dialog check has teeth -- planted failure`() {
        val before = "OutlinedButton(onClick = onUploadPhoto) { }"
        assertTrue(count(before, "enabled = editable") < 6)
    }

    @Test
    fun `the teardown-charge switch is wired to editable end to end`() {
        val text = src("ui/survey/SurveyDrawScreen.kt")
        // The call site passes editable in...
        assertTrue(
            "TeardownChargeRow's call site must pass enabled = editable",
            wired(text, "TeardownChargeRow(", "enabled = editable", maxGap = 400)
        )
        // ...and the row itself actually wires that parameter to the Switch.
        val body = functionBody(text, "TeardownChargeRow")
        assertTrue(
            "TeardownChargeRow must wire its enabled parameter to the Switch",
            wired(body, "onCheckedChange = onChargeChange", "enabled = enabled")
        )
    }

    // ---- RunEditScreen: the run editor's own gate --------------------------

    @Test
    fun `RunEditScreen computes editable from the guest flag and wires every spec field to it`() {
        val text = src("ui/runs/RunEditScreen.kt")
        assertTrue(
            "expected editable to be defined from the guest flag",
            text.contains("val editable = !session.isGuestDemo")
        )
        assertTrue(
            "the run's label field must be disabled for a guest",
            wired(text, "label = stringResource(R.string.est2_run_label_hint)", "enabled = editable")
        )
        assertTrue(
            "the fence-type dropdown must be disabled for a guest",
            text.contains("FenceTypeDropdown(currentRun.fenceType, editable)")
        )
        assertTrue(
            "the color/finish field must be disabled for a guest",
            wired(text, "label = stringResource(R.string.est2_color_finish)", "enabled = editable")
        )
        assertTrue(
            "the is-teardown switch must be disabled for a guest",
            wired(text, "checked = currentRun.isTeardown", "enabled = editable")
        )
        assertTrue(
            "the second line of defence must actually be threaded through: RunEditViewModel needs app.session",
            text.contains("RunEditViewModel(app.repository, runId, app.session)")
        )
    }

    @Test
    fun `RunEditScreen wiring check has teeth -- planted failure`() {
        val before = "Switch(checked = currentRun.isTeardown, onCheckedChange = { })"
        assertFalse(
            "a Switch with no enabled parameter at all must not satisfy the check",
            wired(before, "checked = currentRun.isTeardown", "enabled = editable")
        )
    }

    // ---- JobDetailScreen: everything this wave touched or added -----------

    /**
     * Every call site on the job screen that this wave gated on the guest
     * flag, keyed by the composable it calls. Each entry is checked for the
     * literal `!session.isGuestDemo` argument -- the exact expression, not a
     * renamed local like `editable`, because these are call sites passing it
     * in fresh, not reading a val already scoped to the function.
     */
    private val jobDetailGuestGatedCallSites = mapOf(
        "ChangeOrdersSection" to "ChangeOrdersSection(changeOrders, session.canDelete, !session.isGuestDemo, viewModel)",
        "ExpensesSection" to "ExpensesSection(expenses, session.canDelete, !session.isGuestDemo, viewModel)",
        "PunchListSection" to "PunchListSection(punchList, session.canDelete, !session.isGuestDemo, viewModel)",
        "PhotosSection" to "PhotosSection(photos, session.canDelete, !session.isGuestDemo, viewModel)",
        "StatusSelector" to "editable = !session.isGuestDemo, viewModel = viewModel) }"
    )

    @Test
    fun `JobDetailScreen wires the guest exclusion into every section it touched`() {
        val text = src("ui/jobs/JobDetailScreen.kt")
        jobDetailGuestGatedCallSites.forEach { (name, needle) ->
            assertTrue("$name's call site must pass !session.isGuestDemo (looked for: `$needle`)", text.contains(needle))
        }
    }

    @Test
    fun `the JobDetailScreen call-site sweep has teeth -- planted failure`() {
        val mutated = jobDetailGuestGatedCallSites.getValue("PhotosSection").replace("!session.isGuestDemo", "true")
        assertFalse(
            "a call site rewritten to pass the literal `true` must fail the check",
            mutated.contains("!session.isGuestDemo")
        )
    }

    @Test
    fun `Held Up shows the two fields read-only for a guest, never the writable section`() {
        val text = src("ui/jobs/JobDetailScreen.kt")
        val guestBranch = block(text, "if (session.isGuestDemo) {", "the Held Up guest branch")
        assertTrue("the blocked-reason field must be shown read-only", guestBranch.contains("R.string.jsec_blocked_reason_label"))
        assertTrue("the must-clear field must be shown read-only", guestBranch.contains("R.string.jsec_blocked_must_clear_label"))
        assertFalse("the writable JobBlockedSection must not be reachable from the guest branch", guestBranch.contains("JobBlockedSection("))

        val afterGuestBranch = text.indexOf(guestBranch) + guestBranch.length
        val tail = text.substring(afterGuestBranch, minOf(text.length, afterGuestBranch + 200))
        assertTrue(
            "expected an else branch offering the real JobBlockedSection right after the guest branch, " +
                "found: `${tail.trim().take(120)}`",
            Regex("""else\s*\{\s*JobBlockedSection\(""").containsMatchIn(tail)
        )
    }

    @Test
    fun `the Held Up check has teeth -- planted failure`() {
        val before = "SectionCard(title = \"held up\") { JobBlockedSection(currentJob, profile, viewModel) }"
        assertFalse(
            "a snippet with no guest branch at all must not satisfy the check",
            runCatching { block(before, "if (session.isGuestDemo) {", "planted") }.isSuccess
        )
    }

    @Test
    fun `PhotosSection hides Camera and Gallery for a guest but still shows existing photos`() {
        val body = functionBody(src("ui/jobs/JobDetailScreen.kt"), "PhotosSection")
        val addGate = block(body, "if (editable) {", "the Camera/Gallery gate inside PhotosSection")
        assertTrue("the Camera button must be inside the editable gate", addGate.contains("R.string.jd_camera"))
        assertTrue("the Gallery button must be inside the editable gate", addGate.contains("R.string.jd_gallery"))
        // Existing photos (AsyncImage) must render OUTSIDE that gate -- a
        // guest can still look at what is already there.
        val gateEnd = body.indexOf(addGate) + addGate.length
        val photoRenderIndex = body.indexOf("AsyncImage(")
        assertTrue("expected the photo grid to render", photoRenderIndex >= 0)
        assertTrue(
            "existing photos must render AFTER (outside) the add-photo gate, not be hidden by it too",
            photoRenderIndex >= gateEnd
        )
    }

    @Test
    fun `the PhotosSection check has teeth -- planted failure`() {
        val before = """
            fun PhotosSection() {
                Row {
                    OutlinedButton(onClick = {}) { Text(stringResource(R.string.jd_camera)) }
                    OutlinedButton(onClick = {}) { Text(stringResource(R.string.jd_gallery)) }
                }
                AsyncImage(model = photo.filePath)
            }
        """.trimIndent()
        assertFalse(
            "camera/gallery offered with no editable gate at all must fail the check",
            runCatching { block(before, "if (editable) {", "planted") }.isSuccess
        )
    }

    @Test
    fun `Record Payment needs REQUEST_PAYMENT and Refund needs both permissions, both inside the guest exclusion`() {
        // Was "Record Payment needs only the exclusion" until an earlier
        // wave: the server's payment_records_write_needs_request_payment
        // policy requires REQUEST_PAYMENT to insert a payment row, which
        // Sales does not hold by default, so a Record Payment button with no
        // permission check of its own was a control the server would refuse
        // -- a fake feature with extra steps. Confirmed against the live
        // policy with `npx supabase db query`, not just the app's own
        // permission sets.
        //
        // A later wave found that RECORD_REFUNDS can be granted to a person
        // independently of REQUEST_PAYMENT (a per-person override on top of
        // the role default), which recreates the same bug for RefundControl
        // -- so its gate now asks for BOTH permissions, matching the server's
        // policy exactly. That legitimately changed the refund gate's source
        // text from `if (session.canRecordRefunds) {` to
        // `if (session.canRecordRefunds && session.canRequestPayment) {`, so
        // this check reads the condition out with [conditionGuarding] and
        // asks [permissionTokens] which permissions it actually names,
        // rather than matching the condition's exact old spelling -- a check
        // that would otherwise be broken by the very fix it is meant to
        // confirm.
        val body = functionBody(src("ui/jobs/JobDetailScreen.kt"), "PaymentFields")
        assertTrue(
            "expected editable to be computed from the guest flag inside PaymentFields",
            body.contains("val editable = !session.isGuestDemo")
        )
        // PaymentFields is one large composable with several `if (editable) {`
        // sections (payment status, deposit, tip, ...) -- find the ONE that
        // actually wraps RecordPaymentControl by searching backward from its
        // call site, rather than trusting it to be the first `if (editable) {`
        // in the whole function.
        val recordPaymentIndex = body.indexOf("RecordPaymentControl(")
        assertTrue("expected a call to RecordPaymentControl inside PaymentFields", recordPaymentIndex >= 0)
        val gateStart = body.lastIndexOf("if (editable) {", recordPaymentIndex)
        assertTrue("expected an `if (editable) {` gate wrapping RecordPaymentControl", gateStart >= 0)

        val editableGate = block(body, "if (editable) {", "the payment controls' guest exclusion", from = gateStart)
        assertTrue("RecordPaymentControl must be inside that gate", editableGate.contains("RecordPaymentControl("))
        assertTrue("RefundControl must be inside that gate", editableGate.contains("RefundControl("))

        val paymentCondition = conditionGuarding(editableGate, "RecordPaymentControl(", "the record-payment permission gate")
        assertEquals(
            "RecordPaymentControl must be gated on its own session.canRequestPayment permission, and nothing " +
                "else, inside the guest exclusion -- the server refuses a payment row without REQUEST_PAYMENT, " +
                "so a control with no gate of its own here is a fake feature",
            setOf("session.canRequestPayment"),
            permissionTokens(paymentCondition)
        )

        val refundCondition = conditionGuarding(editableGate, "RefundControl(", "the refund permission gate")
        assertEquals(
            "RefundControl must be gated on BOTH session.canRecordRefunds and session.canRequestPayment -- the " +
                "live payment_records_write_needs_request_payment policy requires REQUEST_PAYMENT for every " +
                "payment_records row, refunds included, and RECORD_REFUNDS can be granted independently of it",
            setOf("session.canRecordRefunds", "session.canRequestPayment"),
            permissionTokens(refundCondition)
        )
    }

    @Test
    fun `the Record Payment and Refund gating check has teeth -- planted failure`() {
        // RecordPaymentControl offered with no permission-specific gate at
        // all -- its only enclosing `if` is the guest exclusion itself
        // (`if (editable) {`), which names no permission. conditionGuarding
        // still finds that enclosing `if` (it is a real `if` that really
        // does wrap the call), so this must be caught by the permission set
        // not matching -- exactly how the real assertEquals above would
        // catch it -- not by an exception.
        val noGateAtAll = "if (editable) { RecordPaymentControl(); RefundControl() }"
        val noGateEditable = block(noGateAtAll, "if (editable) {", "planted guest exclusion")
        val noGateCondition = conditionGuarding(noGateEditable, "RecordPaymentControl(", "planted")
        assertFalse(
            "RecordPaymentControl offered with no permission-specific gate must fail the check",
            permissionTokens(noGateCondition) == setOf("session.canRequestPayment")
        )

        // The actual regression this rewrite guards against: the refund
        // gate present, but missing one of its two required permissions --
        // exactly what a literal-text check for the OLD spelling could never
        // catch, because dropping back to the old spelling is precisely what
        // it was matching.
        val oneTermDropped = "if (editable) {\n" +
            "    if (session.canRequestPayment) { RecordPaymentControl() }\n" +
            "    if (session.canRecordRefunds) { RefundControl() }\n" +
            "}"
        val droppedGate = block(oneTermDropped, "if (editable) {", "planted guest exclusion, one term dropped")
        val droppedRefundCondition = conditionGuarding(droppedGate, "RefundControl(", "planted refund gate")
        assertEquals(
            "sanity: the planted snippet really is missing session.canRequestPayment",
            setOf("session.canRecordRefunds"),
            permissionTokens(droppedRefundCondition)
        )
        assertFalse(
            "the check must go red once the refund gate drops one of its two required permissions",
            permissionTokens(droppedRefundCondition) == setOf("session.canRecordRefunds", "session.canRequestPayment")
        )

        // ...and the real file, unmutated, must still carry both.
        val body = functionBody(src("ui/jobs/JobDetailScreen.kt"), "PaymentFields")
        val realGateStart = body.lastIndexOf("if (editable) {", body.indexOf("RecordPaymentControl("))
        val realEditableGate = block(body, "if (editable) {", "sanity: the real guest exclusion", from = realGateStart)
        assertEquals(
            setOf("session.canRecordRefunds", "session.canRequestPayment"),
            permissionTokens(conditionGuarding(realEditableGate, "RefundControl(", "sanity: the real refund gate"))
        )
    }

    @Test
    fun `duplicating a run and Add Fence Run are both hidden for a guest on the job screen`() {
        val text = src("ui/jobs/JobDetailScreen.kt")
        assertTrue(
            "FenceRunRow's showDuplicate must be driven by the guest flag",
            text.contains("showDuplicate = !session.isGuestDemo,")
        )
        val addRunGate = block(text, "if (!session.isGuestDemo) {", "the Add Fence Run button's guest gate")
        assertTrue("the Add Fence Run button must be inside that gate", addRunGate.contains("R.string.jd_add_fence_run"))
    }

    @Test
    fun `the duplicate-run and add-run check has teeth -- planted failure`() {
        val before = "OutlinedButton(onClick = { showAddRunDialog = true }) { Text(stringResource(R.string.jd_add_fence_run)) }"
        assertFalse(
            "an Add Fence Run button with no guest gate around it must fail the check",
            runCatching { block(before, "if (!session.isGuestDemo) {", "planted") }.isSuccess
        )
    }

    // ---- FenceRunListViewModel: the run-list's second line of defence ----
    //
    // Used to be a deliberately RED test recording a real gap: the view
    // model behind the two buttons above was constructed with only
    // `(repository, jobId)` -- no SessionManager, no guard in addRun() or
    // duplicateRun() -- so JobDetailScreen's own `if (!session.isGuestDemo)`
    // around those two buttons was the only thing standing between a guest
    // and a write, the same single-point-of-failure shape as the last three
    // regressions in this app's guest demo.
    //
    // The gap has since been closed: FenceRunListViewModel now takes
    // `session: SessionManager` and both functions open with the same guard
    // every sibling view model in this file uses. But the test written to
    // go green on that fix asked only
    // `text.contains("session: SessionManager") && text.contains("isGuestDemo")`
    // over the WHOLE file -- and the constructor parameter's own KDoc (see
    // FenceRunListViewModel.kt) names both strings on its own. A reviewer
    // proved that check pinned nothing by deleting both real guards from
    // addRun() and duplicateRun() and watching it still pass, the only
    // surviving occurrence of either string being that doc comment. Replaced
    // below with the same machinery every other guard in this file is
    // checked with: functionBody() + opensWith(), which asks whether the
    // guard is the function's own first statement, not whether the words
    // appear somewhere in the file.

    private val fenceRunListWriteFunnel = listOf("addRun", "duplicateRun")

    @Test
    fun `every FenceRunListViewModel write funnel opens with the guest refusal`() {
        val text = src("ui/runs/FenceRunListViewModel.kt")
        assertTrue(
            "FenceRunListViewModel's constructor must take a `session: SessionManager` parameter, " +
                "the same reference addRun() and duplicateRun() read live",
            text.contains("session: SessionManager")
        )
        fenceRunListWriteFunnel.forEach { name ->
            val body = functionBody(text, name)
            assertOpensWithGuard("FenceRunListViewModel", name, body, "if (session.state.value.isGuestDemo) return")
        }
    }

    @Test
    fun `the FenceRunListViewModel sweep has teeth -- planted failure`() {
        // Each guard removed individually: the sweep must go red and name
        // the specific function left unguarded.
        val text = src("ui/runs/FenceRunListViewModel.kt")
        fenceRunListWriteFunnel.forEach { name ->
            val body = functionBody(text, name)
            assertTrue("sanity: $name() really does open with the guard", opensWith(body, "if (session.state.value.isGuestDemo) return"))
            val stripped = body.replaceFirst("if (session.state.value.isGuestDemo) return\n", "")
            assertFalse(
                "the sweep must go red naming $name() once its guard is removed",
                opensWith(stripped, "if (session.state.value.isGuestDemo) return")
            )
        }
        // The exact regression a doc-comment-only check could not have
        // caught: BOTH real guards removed from the function bodies while
        // the constructor's own KDoc -- which names both `session:
        // SessionManager` and `isGuestDemo` -- is left completely untouched.
        // This is what the old whole-file `.contains()` check was blind to.
        val bothGuardsGutted = text.replace("if (session.state.value.isGuestDemo) return\n", "")
        assertTrue(
            "sanity: the gutted copy really has zero guards left in the function bodies",
            count(bothGuardsGutted, "if (session.state.value.isGuestDemo) return") == 0
        )
        assertTrue(
            "sanity: the constructor's own doc comment still carries both strings on its own -- " +
                "this is exactly why the old whole-file .contains() check reported success with both " +
                "real guards deleted, and why it has been replaced",
            bothGuardsGutted.contains("session: SessionManager") && bothGuardsGutted.contains("isGuestDemo")
        )
    }

    // =====================================================================
    // SECTION 4 -- the promise tied to the gates.
    //
    // strings_guest.xml's guest_banner_explain tells a guest this is sample
    // data to look around in (worded, as of this wave, without claiming
    // read-only outright -- see onb_access_changed_guest_body's own history
    // for why that specific wording matters). That claim and the code above
    // must not be able to drift apart silently: if every guard this section
    // pins were stripped out while the resource string stayed reassuring,
    // the build would still succeed and every OTHER test in this file would
    // simply be reporting the app as broken one function at a time. This
    // test ties the two together explicitly, once.
    // =====================================================================

    private fun stringResourceBody(xml: String, name: String): String? =
        Regex("<string name=\"${Regex.escape(name)}\"[^>]*>([\\s\\S]*?)</string>")
            .find(xml)?.groupValues?.get(1)

    @Test
    fun `the read-only promise the guest banner shows still exists`() {
        val xml = resText("values/strings_guest.xml")
        val body = stringResourceBody(xml, "guest_banner_explain")
        assertTrue("expected a guest_banner_explain string resource in strings_guest.xml", body != null)
        assertTrue("guest_banner_explain must not be blank", body!!.isNotBlank())
    }

    @Test
    fun `the banner that carries the promise is the one actually shown`() {
        val banner = src("guest/GuestBanner.kt")
        assertTrue(
            "GuestBanner.kt must render R.string.guest_banner_explain, or the promise is a dead resource nobody sees",
            banner.contains("R.string.guest_banner_explain")
        )
    }

    /**
     * How many times each file's guard token appears, as a floor -- comfortably
     * under the count as of this wave (10 / 1 / 14 / 2), so a harmless refactor
     * does not trip this, but wholesale removal of the guest funnel does.
     *
     * FenceRunListViewModel.kt was added here once its own gap (see the
     * FenceRunListViewModel section above) was closed -- before that, the
     * promise this TIE test defends could have been silently untrue for this
     * view model specifically, and nothing here would have noticed, because
     * a floor of zero rows means a floor of zero guards demanded.
     *
     * Known gap: three other view models with the identical
     * `session.state.value.isGuestDemo` guard -- CrewJobViewModel.kt (11
     * occurrences), EstimateViewModel.kt (11) and InventoryViewModel.kt (6),
     * all under active work by other tracks this wave -- have no entry here
     * either. That is the same shape of gap this section exists to close;
     * left unaddressed here on purpose because those three files are mid-edit
     * elsewhere in this session and pinning a floor on a moving target would
     * either be a guess or immediately stale. Whoever next touches this map
     * should add them.
     */
    private fun guardFloorsAreMet(): Map<String, Pair<Int, Int>> {
        val jobDetail = count(src("ui/jobs/JobDetailViewModel.kt"), "session.state.value.isGuestDemo")
        val runEdit = count(src("ui/runs/RunEditViewModel.kt"), "session.state.value.isGuestDemo")
        val survey = count(src("ui/survey/SurveyViewModel.kt"), "viewerIsGuestDemo()")
        val fenceRunList = count(src("ui/runs/FenceRunListViewModel.kt"), "session.state.value.isGuestDemo")
        return mapOf(
            "JobDetailViewModel.kt (session.state.value.isGuestDemo)" to (jobDetail to 6),
            "RunEditViewModel.kt (session.state.value.isGuestDemo)" to (runEdit to 1),
            "SurveyViewModel.kt (viewerIsGuestDemo())" to (survey to 8),
            "FenceRunListViewModel.kt (session.state.value.isGuestDemo)" to (fenceRunList to 2)
        )
    }

    @Test
    fun `TIE -- the promise cannot survive alone once the guarded funnels behind it are gutted`() {
        val xml = resText("values/strings_guest.xml")
        val promiseExists = stringResourceBody(xml, "guest_banner_explain")?.isNotBlank() == true
        assertTrue("this whole tie is meaningless if the promise itself is gone -- see the dedicated test above", promiseExists)

        guardFloorsAreMet().forEach { (label, actualToFloor) ->
            val (actual, floor) = actualToFloor
            assertTrue(
                "guest_banner_explain still tells a guest this is safe sample data to explore, but $label " +
                    "has only $actual guest guard(s) left (expected at least $floor) -- the promise and the " +
                    "code have drifted apart",
                actual >= floor
            )
        }
    }

    @Test
    fun `the tie check has teeth -- planted failure`() {
        // Simulates a file whose guards were stripped down to nothing, the
        // way three consecutive waves have partially done.
        val gutted = src("ui/jobs/JobDetailViewModel.kt").replace("session.state.value.isGuestDemo", "false /* stripped */")
        val actual = count(gutted, "session.state.value.isGuestDemo")
        assertEquals("the mutated copy must show zero guards left", 0, actual)
        assertTrue("zero must fall below the floor of 6, proving the tie check would have gone red", actual < 6)
        // ...and the real file must still clear it.
        assertTrue(count(src("ui/jobs/JobDetailViewModel.kt"), "session.state.value.isGuestDemo") >= 6)
    }

    @Test
    fun `the tie check's new FenceRunListViewModel row has teeth -- planted failure`() {
        // Before this row existed, gutting FenceRunListViewModel entirely
        // would not have failed the TIE test -- the map simply never asked
        // about this file. Proves the newly-added row actually would notice.
        val gutted = src("ui/runs/FenceRunListViewModel.kt")
            .replace("session.state.value.isGuestDemo", "false /* stripped */")
        val actual = count(gutted, "session.state.value.isGuestDemo")
        assertEquals("the mutated copy must show zero guards left", 0, actual)
        assertTrue("zero must fall below the floor of 2, proving the tie check would now go red for this file too", actual < 2)
        // ...and the real file must still clear its new floor.
        assertTrue(count(src("ui/runs/FenceRunListViewModel.kt"), "session.state.value.isGuestDemo") >= 2)
    }
}

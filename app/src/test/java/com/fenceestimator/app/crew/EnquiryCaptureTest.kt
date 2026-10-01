package com.fenceestimator.app.crew

import com.fenceestimator.app.cloud.Permission
import com.fenceestimator.app.cloud.PermissionOverrides
import com.fenceestimator.app.cloud.RealRestErrors
import com.fenceestimator.app.cloud.SessionState
import com.fenceestimator.app.cloud.UserRole
import com.fenceestimator.app.cloud.defaultPermissions
import com.fenceestimator.app.data.EnquiryCapture
import com.fenceestimator.app.data.EnquiryCapturePhoto
import com.fenceestimator.app.ui.crew.EnquiryCaptureAccess
import com.fenceestimator.app.ui.crew.EnquiryDraft
import com.fenceestimator.app.ui.crew.EnquiryFlushResult
import com.fenceestimator.app.ui.crew.EnquiryOutbox
import com.fenceestimator.app.ui.crew.EnquiryPayload
import com.fenceestimator.app.ui.crew.EnquiryProblem
import com.fenceestimator.app.ui.crew.EnquiryRefusal
import com.fenceestimator.app.ui.crew.EnquiryRow
import com.fenceestimator.app.ui.crew.EnquiryStatus
import com.fenceestimator.app.ui.crew.EnquiryStore
import com.fenceestimator.app.ui.crew.EnquiryTransport
import com.fenceestimator.app.ui.crew.EnquiryWait
import com.fenceestimator.app.ui.crew.FailureFacts
import com.fenceestimator.app.ui.crew.PhotoOutcome
import com.fenceestimator.app.ui.crew.SendOutcome
import com.fenceestimator.app.ui.crew.classifyEnquiryFailure
import com.fenceestimator.app.ui.crew.classifyEnquirySend
import com.fenceestimator.app.ui.crew.enquiryRows
import com.fenceestimator.app.ui.crew.enquiryStatus
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.net.UnknownHostException

/**
 * Crew enquiry capture, held to the owner's answer: a crew member who has been
 * given the permission can take down a neighbour's enquiry on the spot, it
 * reaches the office, and the OFFICE prices it. No money reaches a crew phone.
 *
 * What this proves, in the order the brief asked for it:
 *  1. the permission is off by default (and the server's substring match cannot
 *     confuse it with another),
 *  2. a crew member without it sees no entry point, and one with it does,
 *  3. a capture survives having no signal -- on the phone, whole, until the
 *     server says it holds it,
 *  4. no money field exists anywhere on the path,
 *  5. what the office later prices a capture at has no road back to the person
 *     who captured it,
 *  6. crew can correct an unsent capture and can never delete one.
 *
 * The send queue runs for real, over an in-memory store and a scripted wire --
 * the same code the phone runs. The source-text checks follow the idiom of
 * GuestReadOnlyTest and CrewAccessUiGatesTest (Compose and Room are not
 * constructible off a device), and every one of them is paired with its own
 * proof that it can fail.
 */
class EnquiryCaptureTest {

    // =====================================================================
    // Reading the repo: source, resources, the SQL file.
    // =====================================================================

    private fun mainSrc(rel: String): String {
        val bases = listOf(File("src/main/java/com/fenceestimator/app"), File("app/src/main/java/com/fenceestimator/app"))
        val base = bases.firstOrNull { it.isDirectory } ?: error("could not locate sources from ${File(".").absolutePath}")
        return File(base, rel).readText().replace("\r\n", "\n")
    }

    private fun strings(locale: String = "values"): Map<String, String> {
        val bases = listOf(File("src/main/res"), File("app/src/main/res"))
        val base = bases.firstOrNull { it.isDirectory } ?: error("could not locate resources")
        val xml = File(base, "$locale/strings.xml").readText()
        return Regex("<string name=\"([^\"]+)\"[^>]*>([\\s\\S]*?)</string>").findAll(xml).associate { it.groupValues[1] to it.groupValues[2] }
    }

    private fun repoFile(name: String): File =
        listOf(File(".."), File("."), File("../.."))
            .map { File(it, name) }
            .firstOrNull { it.isFile } ?: error("could not find $name from ${File(".").absolutePath}")

    /** Kotlin with its comments removed, so a comment cannot satisfy or trip a check about code. */
    private fun code(text: String): String =
        text.replace(Regex("/\\*[\\s\\S]*?\\*/"), " ").replace(Regex("(?m)(^|[^:\"'])//.*$"), "$1")

    /** The words of every identifier in [text]: camelCase and snake_case split, lower-cased. */
    private fun words(text: String): Set<String> =
        Regex("[A-Za-z_][A-Za-z0-9_]*").findAll(text).flatMap { id ->
            id.value.split('_').flatMap { part ->
                Regex("[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+").findAll(part).map { it.value.lowercase() }.toList()
            }.asSequence()
        }.toSet()

    /** Words that mean money. Not one may be an identifier on the capture path. */
    private val moneyWords = setOf(
        "price", "prices", "priced", "pricing", "cost", "costs", "rate", "rates", "total", "totals",
        "deposit", "deposits", "tax", "taxes", "amount", "amounts", "fee", "fees", "margin", "markup",
        "discount", "paid", "pay", "payment", "payments", "balance", "quote", "quotes", "estimate",
        "estimates", "invoice", "money", "dollar", "dollars", "cash", "charge", "charges", "billing", "refund"
    )

    private fun moneyIn(text: String): Set<String> = words(code(text)) intersect moneyWords

    private val capturePathFiles = listOf(
        "ui/crew/EnquiryCaptureLogic.kt", "ui/crew/EnquiryCaptureSender.kt",
        "ui/crew/EnquiryCaptureViewModel.kt", "ui/crew/EnquiryCaptureScreen.kt"
    )

    /** From [marker] to the brace that closes the one the marker ends in. */
    private fun block(text: String, marker: String): String {
        val start = text.indexOf(marker)
        assertTrue("what I was checking is gone or renamed (looked for: `$marker`)", start >= 0)
        val open = start + marker.length - 1
        assertEquals("marker must end in the block's own brace: `$marker`", '{', text[open])
        var depth = 0
        for (i in open until text.length) {
            if (text[i] == '{') depth++
            if (text[i] == '}') { depth--; if (depth == 0) return text.substring(start, i + 1) }
        }
        error("unbalanced braces after `$marker`")
    }

    // =====================================================================
    // 1. THE PERMISSION IS OFF BY DEFAULT
    // =====================================================================

    @Test
    fun `no role holds the permission by default, and the owner only because the owner holds everything`() {
        val holders = UserRole.values().filter { Permission.CAPTURE_ENQUIRY in it.defaultPermissions }
        assertEquals("only OWNER, which is every permission, may hold it by default", listOf(UserRole.OWNER), holders)
        assertEquals(Permission.ALL, UserRole.OWNER.defaultPermissions)
        for (role in UserRole.values().filter { it != UserRole.OWNER }) {
            assertFalse("$role must not inherit it by job title", Permission.CAPTURE_ENQUIRY in role.defaultPermissions)
            assertFalse(Permission.CAPTURE_ENQUIRY in PermissionOverrides.resolve(role, ""))
            assertFalse(Permission.CAPTURE_ENQUIRY in PermissionOverrides.resolve(role, null))
        }
    }

    @Test
    fun `it is granted to a named person, and a revocation beats the grant`() {
        val crew = PermissionOverrides.resolve(UserRole.CREW, "+CAPTURE_ENQUIRY")
        assertTrue(Permission.CAPTURE_ENQUIRY in crew)
        assertEquals("granting it drags nothing else in", UserRole.CREW.defaultPermissions + Permission.CAPTURE_ENQUIRY, crew)
        assertFalse(Permission.CAPTURE_ENQUIRY in PermissionOverrides.resolve(UserRole.CREW, "+CAPTURE_ENQUIRY,-CAPTURE_ENQUIRY"))
        assertFalse(Permission.CAPTURE_ENQUIRY in PermissionOverrides.resolve(UserRole.OWNER, "-CAPTURE_ENQUIRY"))
        assertEquals("+CAPTURE_ENQUIRY", PermissionOverrides.encode(UserRole.CREW, crew))
        assertEquals("", PermissionOverrides.encode(UserRole.CREW, UserRole.CREW.defaultPermissions))
    }

    @Test
    fun `the guest demo and the not-yet-read phone never hold it`() {
        assertFalse(Permission.CAPTURE_ENQUIRY in SessionState.GUEST_READ_ONLY)
        assertFalse(Permission.CAPTURE_ENQUIRY in SessionState(signedIn = false, guestDemo = true, guestKnown = true).permissions)
        assertFalse(Permission.CAPTURE_ENQUIRY in SessionState(signedIn = false).permissions)
        // Signed in, profile not read: nothing, which is the existing fail-closed rule.
        assertTrue(SessionState(signedIn = true, role = UserRole.CREW, permissionOverrides = "+CAPTURE_ENQUIRY").permissions.isEmpty())
    }

    @Test
    fun `no permission name is inside another, because the server matches overrides by substring`() {
        // has_permission() answers position('+' || perm in overrides) > 0, so a name that is
        // a substring of another would be granted by the other's override.
        val names = Permission.values().map { it.name }
        for (a in names) for (b in names) {
            if (a != b) assertFalse("$a is a substring of $b", b.contains(a))
        }
    }

    @Test
    fun `it is an ordinary toggle with words the owner can read`() {
        assertFalse("it does not lose money or destroy records, so it is not a warning row", Permission.CAPTURE_ENQUIRY.sensitive)
        assertTrue(Permission.CAPTURE_ENQUIRY.label.isNotBlank())
        assertTrue(Permission.CAPTURE_ENQUIRY.description.contains("never sees a price"))
        for (locale in listOf("values", "values-es", "values-fr")) {
            val s = strings(locale)
            assertTrue("$locale: label", !s["enum_perm_capture_enquiry"].isNullOrBlank())
            assertTrue("$locale: description", !s["enum_perm_capture_enquiry_desc"].isNullOrBlank())
        }
        // The exhaustive `when` in EnumLabels names it, so the Team access screen can show it.
        val labels = mainSrc("ui/components/EnumLabels.kt")
        assertTrue(labels.contains("Permission.CAPTURE_ENQUIRY -> R.string.enum_perm_capture_enquiry\n"))
        assertTrue(labels.contains("Permission.CAPTURE_ENQUIRY -> R.string.enum_perm_capture_enquiry_desc\n"))
    }

    // =====================================================================
    // 2. A CREW MEMBER WITHOUT IT SEES NO ENTRY POINT; ONE WITH IT DOES
    // =====================================================================

    private fun session(role: UserRole, overrides: String = "", signedIn: Boolean = true, known: Boolean = true, company: String? = "co") =
        SessionState(signedIn = signedIn, companyId = company, role = role, permissionOverrides = overrides, accessKnown = known, guestKnown = true)

    @Test
    fun `a crew member without it is offered nothing, one with it is offered the capture`() {
        assertFalse(EnquiryCaptureAccess.mayCapture(session(UserRole.CREW)))
        assertTrue(EnquiryCaptureAccess.mayCapture(session(UserRole.CREW, "+CAPTURE_ENQUIRY")))
        assertFalse("revoked again", EnquiryCaptureAccess.mayCapture(session(UserRole.CREW, "+CAPTURE_ENQUIRY,-CAPTURE_ENQUIRY")))
        assertTrue("a foreman who was given it", EnquiryCaptureAccess.mayCapture(session(UserRole.FOREMAN, "+CAPTURE_ENQUIRY")))
        assertFalse("a foreman who was not", EnquiryCaptureAccess.mayCapture(session(UserRole.FOREMAN)))
    }

    @Test
    fun `nobody is offered it before they are known, signed out, or in the demo`() {
        assertFalse("profile not read yet", EnquiryCaptureAccess.mayCapture(session(UserRole.CREW, "+CAPTURE_ENQUIRY", known = false)))
        assertFalse("signed out", EnquiryCaptureAccess.mayCapture(session(UserRole.CREW, "+CAPTURE_ENQUIRY", signedIn = false)))
        assertFalse(
            "the guest demo",
            EnquiryCaptureAccess.mayCapture(SessionState(signedIn = false, guestDemo = true, guestKnown = true, role = UserRole.CREW, permissionOverrides = "+CAPTURE_ENQUIRY"))
        )
    }

    @Test
    fun `anyone who can already create jobs is not offered the poorer door`() {
        // Owner holds the permission by being everything, and has the real thing.
        assertFalse(EnquiryCaptureAccess.mayCapture(session(UserRole.OWNER)))
        assertFalse(EnquiryCaptureAccess.mayCapture(session(UserRole.MANAGER, "+CAPTURE_ENQUIRY")))
        assertFalse(EnquiryCaptureAccess.mayCapture(session(UserRole.SALES, "+CAPTURE_ENQUIRY")))
        assertFalse("a crew member given EDIT_JOBS as well", EnquiryCaptureAccess.mayCapture(session(UserRole.CREW, "+CAPTURE_ENQUIRY,+EDIT_JOBS")))
    }

    @Test
    fun `what is already captured can still be sent after a promotion, but never without a company or the permission`() {
        assertTrue(EnquiryCaptureAccess.maySend(session(UserRole.CREW, "+CAPTURE_ENQUIRY")))
        assertTrue("promoted to a job-editing role, with the grant still on", EnquiryCaptureAccess.maySend(session(UserRole.CREW, "+CAPTURE_ENQUIRY,+EDIT_JOBS")))
        assertFalse(EnquiryCaptureAccess.maySend(session(UserRole.CREW)))
        assertFalse(EnquiryCaptureAccess.maySend(session(UserRole.CREW, "+CAPTURE_ENQUIRY", company = null)))
        assertFalse(EnquiryCaptureAccess.maySend(session(UserRole.CREW, "+CAPTURE_ENQUIRY", known = false)))
    }

    @Test
    fun `the entry card and the screen both ask the one gate`() {
        val screen = code(mainSrc("ui/crew/EnquiryCaptureScreen.kt"))
        val card = block(screen, "fun EnquiryEntryCard(onOpen: () -> Unit, modifier: Modifier = Modifier) {")
        assertTrue("the card must hide itself unless mayCapture", card.contains("if (!EnquiryCaptureAccess.mayCapture(session)) return"))
        val vm = code(mainSrc("ui/crew/EnquiryCaptureViewModel.kt"))
        assertTrue("the view model re-checks before writing", vm.contains("EnquiryCaptureAccess.mayCapture(session.state.value)"))
        // The check the card relies on cannot be quietly emptied: the planted version has no gate.
        assertFalse(card.replace("if (!EnquiryCaptureAccess.mayCapture(session)) return", "").contains("mayCapture"))
    }

    // =====================================================================
    // 3. A CAPTURE SURVIVES BEING OFFLINE
    // =====================================================================

    private class FakeStore(captures: List<EnquiryCapture>, photos: List<EnquiryCapturePhoto> = emptyList()) : EnquiryStore {
        val rows = captures.toMutableList()
        val photoRows = photos.toMutableList()
        /** Runs once, just after the queue is listed -- where a correction can land. */
        var afterListing: (() -> Unit)? = null
        private val lock = Any()

        override suspend fun unsent(): List<EnquiryCapture> {
            val list = synchronized(lock) { rows.filter { it.sentAt == null && it.rejectedAt == null }.sortedBy { it.capturedAt } }
            afterListing?.let { it(); afterListing = null }
            return list
        }
        override suspend fun get(id: Long): EnquiryCapture? = synchronized(lock) { rows.firstOrNull { it.id == id } }
        override suspend fun sentOwingPhotos(): List<EnquiryCapture> = synchronized(lock) {
            rows.filter { c -> c.sentAt != null && photoRows.any { it.captureId == c.id && it.storagePath == null } }
        }
        override suspend fun photos(captureId: Long): List<EnquiryCapturePhoto> = synchronized(lock) { photoRows.filter { it.captureId == captureId } }
        override suspend fun claim(id: Long, now: Long): Boolean = synchronized(lock) {
            val i = rows.indexOfFirst { it.id == id }
            val r = rows[i]
            val held = r.sendingSince != null && r.sendingSince >= now - EnquiryCapture.CLAIM_LIFETIME_MS
            if (r.sentAt != null || r.rejectedAt != null || held) false else { rows[i] = r.copy(sendingSince = now); true }
        }
        override suspend fun release(id: Long) = synchronized(lock) {
            val i = rows.indexOfFirst { it.id == id }; rows[i] = rows[i].copy(sendingSince = null)
        }
        override suspend fun markSent(id: Long, at: Long) = synchronized(lock) {
            val i = rows.indexOfFirst { it.id == id }
            if (rows[i].sentAt == null) rows[i] = rows[i].copy(sentAt = at, sendingSince = null)
        }
        override suspend fun markRejected(id: Long, at: Long, why: String) = synchronized(lock) {
            val i = rows.indexOfFirst { it.id == id }; rows[i] = rows[i].copy(rejectedAt = at, rejectedWhy = why, sendingSince = null)
        }
        override suspend fun setPhotoPath(photoId: Long, storagePath: String) = synchronized(lock) {
            val i = photoRows.indexOfFirst { it.id == photoId }
            if (photoRows[i].storagePath == null) photoRows[i] = photoRows[i].copy(storagePath = storagePath)
        }
        fun row(id: Long) = rows.first { it.id == id }
    }

    private class FakeWire(
        var onSend: suspend (EnquiryCapture) -> SendOutcome = { SendOutcome.Accepted },
        var onPhoto: suspend (EnquiryCapture, EnquiryCapturePhoto) -> PhotoOutcome = { c, p -> PhotoOutcome.Uploaded("co/${c.syncId}/photo/${p.id}.jpg") }
    ) : EnquiryTransport {
        val sends = mutableListOf<EnquiryCapture>()
        val uploads = mutableListOf<Long>()
        override suspend fun send(capture: EnquiryCapture): SendOutcome { sends += capture; return onSend(capture) }
        override suspend fun uploadPhoto(capture: EnquiryCapture, photo: EnquiryCapturePhoto): PhotoOutcome { uploads += photo.id; return onPhoto(capture, photo) }
    }

    /** The company everything below is captured under and signed in to, unless a test says otherwise. */
    private val CO = "co"

    private fun capture(id: Long, at: Long = 1_000L * id) = EnquiryCapture(
        id = id, companyId = CO, syncId = "00000000-0000-4000-8000-00000000000$id", customerName = "Mrs Next-Door", phone = "5551234567",
        email = "", address = "12 Elm Street", fenceType = "VINYL", approxFeet = 120, notes = "Gate on the left, dog", capturedAt = at
    )

    private fun photo(id: Long, captureId: Long, stored: String? = null) =
        EnquiryCapturePhoto(id = id, captureId = captureId, syncId = "11111111-0000-4000-8000-00000000000$id", filePath = "/files/p$id.jpg", storagePath = stored)

    private val now = { 5_000_000L }

    @Test
    fun `with no signal the capture stays on the phone whole, unsent and not refused`() = runBlocking {
        val c = capture(1)
        val store = FakeStore(listOf(c), listOf(photo(1, 1)))
        val wire = FakeWire(onSend = { SendOutcome.TryLater(EnquiryWait.NO_SIGNAL) })

        val result = EnquiryOutbox.flush(store, wire, now, CO)

        assertEquals(EnquiryWait.NO_SIGNAL, result.waiting)
        assertEquals(0, result.sent)
        val after = store.row(1)
        assertNull("not marked delivered", after.sentAt)
        assertNull("not refused: a dead spot is not a verdict", after.rejectedAt)
        assertNull("the claim is given back so the next pass can send it", after.sendingSince)
        assertEquals("every captured field is exactly what was typed", c, after)
        assertEquals("its photo is still on the phone, unsent", 1, store.photoRows.size)
        assertTrue(store.photoRows.single().storagePath == null)
        assertTrue("nothing was uploaded for a lead the office does not have", wire.uploads.isEmpty())
    }

    @Test
    fun `when signal returns it goes up once, and a second pass sends nothing more`() = runBlocking {
        val store = FakeStore(listOf(capture(1)))
        val wire = FakeWire(onSend = { SendOutcome.TryLater(EnquiryWait.NO_SIGNAL) })
        EnquiryOutbox.flush(store, wire, now, CO)
        EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals("each pass tried once and stopped; nothing hammered", 2, wire.sends.size)

        wire.onSend = { SendOutcome.Accepted }
        val third = EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals(1, third.sent)
        assertNull(third.waiting)
        assertNotNull(store.row(1).sentAt)

        val fourth = EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals("already with the office: nothing to send", 0, fourth.sent)
        assertEquals("the wire saw three attempts in all, never a fourth", 3, wire.sends.size)
    }

    @Test
    fun `a pass that cannot send stops at the first failure instead of trying every capture`() = runBlocking {
        val store = FakeStore(listOf(capture(1), capture(2), capture(3)))
        val wire = FakeWire(onSend = { SendOutcome.TryLater(EnquiryWait.NO_SIGNAL) })
        EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals(1, wire.sends.size)
        assertTrue(store.rows.all { it.sentAt == null && it.rejectedAt == null && it.sendingSince == null })
    }

    @Test
    fun `signed out is reported as signed out, and keeps the capture`() = runBlocking {
        val store = FakeStore(listOf(capture(1)))
        val wire = FakeWire(onSend = { SendOutcome.TryLater(EnquiryWait.SIGNED_OUT) })
        val result = EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals(EnquiryWait.SIGNED_OUT, result.waiting)
        assertNull(store.row(1).sentAt)
        assertNull(store.row(1).rejectedAt)
    }

    @Test
    fun `oldest first, so the neighbour who asked first is called first`() = runBlocking {
        val store = FakeStore(listOf(capture(2, at = 9_000L), capture(1, at = 1_000L), capture(3, at = 5_000L)))
        val wire = FakeWire()
        EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals(listOf(1L, 3L, 2L), wire.sends.map { it.id })
    }

    @Test
    fun `a refusal is kept whole with its reason, never retried by itself, and can be sent again by hand`() = runBlocking {
        val store = FakeStore(listOf(capture(1)))
        val wire = FakeWire(onSend = { SendOutcome.Refused(EnquiryRefusal.NOT_ALLOWED) })
        val first = EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals(1, first.refused)
        assertEquals("the capture is still here", 1, store.rows.size)
        assertEquals("NOT_ALLOWED", store.row(1).rejectedWhy)
        assertNotNull(store.row(1).rejectedAt)
        assertEquals("Mrs Next-Door", store.row(1).customerName)

        EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals("a refused capture is not retried on its own", 1, wire.sends.size)

        // "Send again": the rejection cleared, content untouched, back in the queue.
        store.rows[0] = store.row(1).copy(rejectedAt = null, rejectedWhy = "")
        wire.onSend = { SendOutcome.Accepted }
        assertEquals(1, EnquiryOutbox.flush(store, wire, now, CO).sent)
    }

    @Test
    fun `a wire that throws loses nothing and strands no claim`() = runBlocking {
        val store = FakeStore(listOf(capture(1)))
        val wire = FakeWire(onSend = { throw IllegalStateException("a bug in the transport") })
        val result = EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals(EnquiryWait.FAILED, result.waiting)
        assertNull(store.row(1).sendingSince)
        assertNull(store.row(1).sentAt)
        assertEquals(capture(1), store.row(1))
    }

    @Test
    fun `a capture taken under another company is never sent, claimed or refused while this one is signed in`() = runBlocking {
        // A phone that changed hands between two businesses with a capture still unsent: the wipe is
        // withheld while anything is unsent, so it is still here -- and the server files whatever it is
        // handed under whoever is signed in, which would put one company's neighbour in the other's pipeline.
        val mine = capture(1)
        val theirs = capture(2).copy(companyId = "other-company")
        val sentTheirs = capture(3).copy(companyId = "other-company", sentAt = 1L)
        val store = FakeStore(listOf(mine, theirs, sentTheirs), listOf(photo(1, 3)))
        val wire = FakeWire()

        val result = EnquiryOutbox.flush(store, wire, now, CO)

        assertEquals("only the capture taken under this company went", listOf(1L), wire.sends.map { it.id })
        assertEquals(1, result.sent)
        assertEquals("the other company's capture is exactly as it was", theirs, store.row(2))
        assertTrue("and so are its photos: nothing was uploaded under the wrong company", wire.uploads.isEmpty())
        // ...and it goes when ITS company signs back in.
        EnquiryOutbox.flush(store, wire, now, "other-company")
        assertEquals(listOf(1L, 2L), wire.sends.map { it.id })
        assertEquals(listOf(1L), wire.uploads)
    }

    @Test
    fun `only this company's captures are listed, and a company that is not known lists none`() {
        val mine = capture(1)
        val theirs = capture(2).copy(companyId = "other-company")
        assertEquals(listOf(1L), enquiryRows(listOf(mine, theirs), emptyList(), CO).map { it.capture.id })
        assertEquals(listOf(2L), enquiryRows(listOf(mine, theirs), emptyList(), "other-company").map { it.capture.id })
        assertTrue(enquiryRows(listOf(mine, theirs), emptyList(), "").isEmpty())
    }

    @Test
    fun `nobody is offered the capture without a company to file it under`() {
        assertFalse(EnquiryCaptureAccess.mayCapture(session(UserRole.CREW, "+CAPTURE_ENQUIRY", company = null)))
    }

    @Test
    fun `two passes at once send a capture once`() = runBlocking {
        val store = FakeStore(listOf(capture(1)))
        val wire = FakeWire(onSend = { delay(50); SendOutcome.Accepted })
        val a = async { EnquiryOutbox.flush(store, wire, now, CO) }
        val b = async { EnquiryOutbox.flush(store, wire, now, CO) }
        val total = a.await().sent + b.await().sent
        assertEquals(1, wire.sends.size)
        assertEquals(1, total)
    }

    @Test
    fun `an abandoned claim goes stale, so a process that died mid-send does not hold a capture for ever`() = runBlocking {
        val held = capture(1).copy(sendingSince = 5_000_000L - EnquiryCapture.CLAIM_LIFETIME_MS - 1)
        val store = FakeStore(listOf(held))
        val wire = FakeWire()
        assertEquals(1, EnquiryOutbox.flush(store, wire, now, CO).sent)

        val fresh = capture(2).copy(sendingSince = 5_000_000L - 1_000L)
        val store2 = FakeStore(listOf(fresh))
        assertEquals("a fresh claim is respected", 0, EnquiryOutbox.flush(store2, FakeWire(), now, CO).sent)
    }

    @Test
    fun `a correction that lands between the listing and the claim is the one that goes`() = runBlocking {
        val store = FakeStore(listOf(capture(1)))
        store.afterListing = { store.rows[0] = store.row(1).copy(phone = "5559998888") }
        val wire = FakeWire()
        EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals("5559998888", wire.sends.single().phone)
    }

    @Test
    fun `photos go after the lead, one failure leaves them owed, and the capture is not undone by it`() = runBlocking {
        val store = FakeStore(listOf(capture(1)), listOf(photo(1, 1), photo(2, 1)))
        val wire = FakeWire(onPhoto = { _, p -> if (p.id == 1L) PhotoOutcome.Uploaded("co/x/photo/1.jpg") else PhotoOutcome.TryLater(EnquiryWait.NO_SIGNAL) })
        val first = EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals(1, first.sent)
        assertEquals(1, first.photosUploaded)
        assertEquals(EnquiryWait.NO_SIGNAL, first.waiting)
        assertNotNull("the office has the lead", store.row(1).sentAt)
        assertEquals(EnquiryStatus.SENT_PHOTOS_OWED, enquiryStatus(store.row(1), store.photoRows))

        wire.onPhoto = { _, p -> PhotoOutcome.Uploaded("co/x/photo/${p.id}.jpg") }
        val second = EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals(0, second.sent)
        assertEquals(1, second.photosUploaded)
        assertEquals(EnquiryStatus.SENT, enquiryStatus(store.row(1), store.photoRows))
        assertEquals("the first photo was not uploaded twice", listOf(1L, 2L, 2L), wire.uploads)
    }

    @Test
    fun `a photo whose file is gone is settled, not owed for ever`() = runBlocking {
        val store = FakeStore(listOf(capture(1).copy(sentAt = 1L)), listOf(photo(1, 1)))
        val wire = FakeWire(onPhoto = { _, _ -> PhotoOutcome.FileGone })
        EnquiryOutbox.flush(store, wire, now, CO)
        assertEquals(EnquiryCapturePhoto.FILE_GONE, store.photoRows.single().storagePath)
        assertEquals(EnquiryStatus.SENT, enquiryStatus(store.row(1), store.photoRows))
    }

    @Test
    fun `the server saying it holds a different capture is not good news`() {
        val id = "00000000-0000-4000-8000-000000000001"
        val ok = buildJsonObject { put("job_sync_id", id); put("created", true) }
        assertTrue(EnquiryPayload.accepted(ok, id))
        assertTrue("the second send of the same capture", EnquiryPayload.accepted(buildJsonObject { put("job_sync_id", id.uppercase()); put("created", false) }, id))
        assertFalse("an empty answer", EnquiryPayload.accepted(null, id))
        assertFalse("an empty object", EnquiryPayload.accepted(JsonObject(emptyMap()), id))
        assertFalse("an array", EnquiryPayload.accepted(JsonArray(emptyList()), id))
        assertFalse("a bare string", EnquiryPayload.accepted(JsonPrimitive(id), id))
        assertFalse("another capture's id", EnquiryPayload.accepted(buildJsonObject { put("job_sync_id", "00000000-0000-4000-8000-0000000000ff") }, id))
        assertFalse("not a string", EnquiryPayload.accepted(buildJsonObject { put("job_sync_id", 7) }, id))
    }

    @Test
    fun `a draft is valid only if the neighbour can be called back and the fence found`() {
        val good = EnquiryDraft(name = "Mrs Next-Door", phone = "(555) 123-4567", address = "12 Elm Street", feetText = "120")
        assertTrue(good.problems().isEmpty())
        assertEquals(setOf(EnquiryProblem.NAME, EnquiryProblem.CONTACT, EnquiryProblem.ADDRESS), EnquiryDraft().problems().toSet())
        assertTrue("an email alone is a way to reach them", EnquiryDraft(name = "Al", email = "al@example.com", address = "12 Elm").problems().isEmpty())
        assertTrue(EnquiryProblem.CONTACT in good.copy(phone = "555-12").problems())
        assertTrue(EnquiryProblem.EMAIL in good.copy(email = "not an email").problems())
        assertTrue(EnquiryProblem.FEET in good.copy(feetText = "lots").problems())
        assertTrue(EnquiryProblem.FEET in good.copy(feetText = "0").problems())
        assertTrue(EnquiryProblem.FEET in good.copy(feetText = "20001").problems())
        assertTrue("blank feet is 'not sure', not an error", good.copy(feetText = "").problems().isEmpty())
        assertNull(good.copy(feetText = "").approxFeet())
        assertEquals(120, good.approxFeet())
    }

    @Test
    fun `a saved draft is trimmed, capped at the server's limits, and never carries a send state`() {
        val long = "x".repeat(5000)
        val c = EnquiryDraft(name = "  Mrs Next-Door ", phone = "555 123 4567", address = "12 Elm Street", fenceType = "VINYL", notes = long)
            .toCapture(now = 42L, companyId = CO)
        assertEquals("Mrs Next-Door", c.customerName)
        assertEquals(EnquiryDraft.MAX_NOTES, c.notes.length)
        assertEquals(42L, c.capturedAt)
        assertNull(c.sentAt); assertNull(c.sendingSince); assertNull(c.rejectedAt)
        assertEquals("an unknown fence kind is stored as 'not sure', not as text the office cannot read",
            "", EnquiryDraft(fenceType = "LASER").toCapture(0L, CO).fenceType)
        assertEquals(CO, c.companyId)
        assertEquals(EnquiryDraft.of(c).toCapture(42L, CO).copy(syncId = c.syncId), c)
    }

    // ---- The classifier, held to the SQL file's own sentences, and to the library's real exceptions ----

    private val statusFor = mapOf("42501" to 403, "22023" to 400, "54000" to 413)

    /** Every `raise exception '...' using errcode = '...'` in crew_capture_enquiry, as (message, code). */
    private fun sqlRaises(): List<Pair<String, String>> {
        val sql = repoFile("supabase_a28_crew_enquiry_capture.sql").readText()
        val start = sql.indexOf("create or replace function public.crew_capture_enquiry")
        val end = sql.indexOf("\$fn\$;", start)
        assertTrue("the function's bounds moved", start in 0 until end)
        val raise = Regex("""raise exception '((?:[^']|'')*)'\s*using errcode = '(\w+)'""", RegexOption.IGNORE_CASE)
        return raise.findAll(sql.substring(start, end)).map { it.groupValues[1].replace("''", "'") to it.groupValues[2] }.toList()
    }

    @Test
    fun `every sentence the SQL raises is classified as what its SQLSTATE means`() {
        val raises = sqlRaises()
        assertTrue("parsed nothing -- the parser is broken, not the file", raises.size >= 8)
        for ((message, code) in raises) {
            val status = statusFor[code] ?: error("the SQL raises $code, which the phone has no answer for: \"$message\"")
            val got = classifyEnquirySend(FailureFacts(status, message, notDeployed = false, noConnection = false))
            val want: SendOutcome = when (code) {
                "42501" -> if ("sign in" in message.lowercase()) SendOutcome.TryLater(EnquiryWait.SIGNED_OUT) else SendOutcome.Refused(EnquiryRefusal.NOT_ALLOWED)
                "22023" -> SendOutcome.Refused(EnquiryRefusal.INVALID)
                else -> SendOutcome.TryLater(EnquiryWait.LIMIT)
            }
            assertEquals("\"$message\" ($code)", want, got)
            // ...and by sentence alone, with the status unknown, for a library that drops it.
            val bySentence = classifyEnquirySend(FailureFacts(null, message, notDeployed = false, noConnection = false))
            if (code != "22023" || "needed" in message || "not valid" in message || "Nothing to capture" in message) {
                assertEquals("by sentence: \"$message\"", want, bySentence)
            }
        }
    }

    @Test
    fun `real library exceptions are classified the way the phone will meet them`() {
        RealRestErrors().use { errors ->
            fun of(status: Int, message: String) = classifyEnquiryFailure(errors.of(status, message, rpc = "crew_capture_enquiry"))
            assertEquals(SendOutcome.Refused(EnquiryRefusal.NOT_ALLOWED), of(403, "You cannot capture enquiries."))
            assertEquals(SendOutcome.Refused(EnquiryRefusal.NOT_ALLOWED), of(403, "Company suspended"))
            assertEquals(SendOutcome.Refused(EnquiryRefusal.INVALID), of(400, "The address is needed."))
            assertEquals(SendOutcome.TryLater(EnquiryWait.SIGNED_OUT), of(401, "JWT expired"))
            assertEquals(SendOutcome.TryLater(EnquiryWait.SIGNED_OUT), of(403, "Sign in first."))
            assertEquals(SendOutcome.TryLater(EnquiryWait.LIMIT), of(413, "You have captured 20 enquiries in the last hour. Try again later."))
            assertEquals(SendOutcome.TryLater(EnquiryWait.FAILED), of(500, "boom"))
            assertEquals(
                "the SQL is not applied yet: wait, never refuse",
                SendOutcome.TryLater(EnquiryWait.NOT_READY),
                of(404, "Could not find the function public.crew_capture_enquiry(p_capture) in the schema cache")
            )
        }
        assertEquals(SendOutcome.TryLater(EnquiryWait.NO_SIGNAL), classifyEnquiryFailure(UnknownHostException("Unable to resolve host")))
        assertEquals(SendOutcome.TryLater(EnquiryWait.NO_SIGNAL), classifyEnquiryFailure(IOException("Failed to connect to example.supabase.co")))
        assertEquals(SendOutcome.TryLater(EnquiryWait.FAILED), classifyEnquiryFailure(IllegalStateException("something else")))
    }

    // =====================================================================
    // 4. NO MONEY FIELD EXISTS ANYWHERE ON THE PATH
    // =====================================================================

    @Test
    fun `no type on the capture path has a money field`() {
        val fieldWords = listOf(
            EnquiryCapture::class.java, EnquiryCapturePhoto::class.java, EnquiryDraft::class.java,
            EnquiryRow::class.java, EnquiryFlushResult::class.java
        ).flatMap { c -> c.declaredFields.map { c.simpleName to it.name } }
        assertTrue("reflection found no fields -- the check is broken", fieldWords.size >= 30)
        for ((owner, name) in fieldWords) {
            assertEquals("$owner.$name looks like money", emptySet<String>(), words(name) intersect moneyWords)
        }
    }

    @Test
    fun `no key on the wire is money, and the payload is exactly the contract`() {
        assertEquals(emptySet<String>(), EnquiryPayload.KEYS.flatMap { words(it) }.toSet() intersect moneyWords)
        val full = EnquiryPayload.of(capture(1))
        assertEquals(EnquiryPayload.KEYS, full.keys)
        val unsure = EnquiryPayload.of(capture(1).copy(approxFeet = null))
        assertEquals("a length nobody gave is absent, not zero", EnquiryPayload.KEYS - "approx_feet", unsure.keys)
        assertEquals("120", full["approx_feet"].toString())
    }

    @Test
    fun `no identifier in the capture screen, view model, sender or logic is money`() {
        for (f in capturePathFiles) {
            assertEquals("$f carries a money word", emptySet<String>(), moneyIn(mainSrc(f)))
        }
        // The check can see one: a planted price field is caught.
        assertEquals(setOf("price"), moneyIn("data class Planted(val price: Double)"))
        assertEquals(setOf("total", "deposit"), moneyIn("val grandTotal = 0; fun depositDue() = 0"))
        assertEquals("a comment is not code", emptySet<String>(), moneyIn("// the price is the office's job\nval x = 1"))
    }

    @Test
    fun `the capture path imports nothing that prices`() {
        for (f in capturePathFiles) {
            val imports = Regex("(?m)^import (\\S+)").findAll(mainSrc(f)).map { it.groupValues[1] }.toList()
            assertTrue("$f has no imports -- the check is broken", imports.size > 3)
            val bad = imports.filter { it.startsWith("com.fenceestimator.app.estimate.") || it.contains("JobMoney") || it.contains("EstimateEngine") }
            assertEquals("$f imports the pricing code: $bad", emptyList<String>(), bad)
        }
        // And neither screen nor view model asks whether this person may see money, to show it.
        for (f in capturePathFiles) assertFalse("$f asks about money", Regex("canSeeMoney|SEE_MONEY").containsMatchIn(code(mainSrc(f))))
    }

    @Test
    fun `no string of the capture screen carries a figure or talks about a price, bar the three that say you will not see one`() {
        val allowedToMention = setOf("enq_intro", "enq_entry_body", "enum_perm_capture_enquiry_desc")
        for (locale in listOf("values", "values-es", "values-fr")) {
            val s = strings(locale).filterKeys { it.startsWith("enq_") || it == "enum_perm_capture_enquiry_desc" || it == "enum_perm_capture_enquiry" }
            assertTrue("$locale: strings not found", s.size >= 50)
            for ((key, value) in s) {
                // The format placeholders (%1$d) carry a dollar sign of their own; they are not money.
                val bare = value.replace(Regex("%\\d\\$[sd]"), "")
                assertFalse("$locale/$key shows a currency figure: $value", Regex("[\$€£]|\\d+[.,]\\d{2}\\b").containsMatchIn(bare))
                if (key !in allowedToMention) {
                    val bad = Regex("\\b(price|prices|priced|pricing|cost|costs|total|deposit|quote|estimate|prix|precio|precios|coste|costo|depósito|devis)\\b", RegexOption.IGNORE_CASE).find(value)
                    assertEquals("$locale/$key mentions money: ${bad?.value}", null, bad)
                }
            }
        }
    }

    // =====================================================================
    // 5. WHAT THE OFFICE PRICES IT AT HAS NO ROAD BACK TO THE CAPTURER
    // =====================================================================

    @Test
    fun `the phone never reads a lead back -- its only calls are the one RPC and the photo upload`() {
        val sender = code(mainSrc("ui/crew/EnquiryCaptureSender.kt"))
        assertEquals("exactly one RPC is called", listOf("crew_capture_enquiry"), Regex("rpc\\(\\s*\"([a-z_]+)\"").findAll(sender).map { it.groupValues[1] }.toList())
        for (forbidden in listOf(".from(", "jobs_crew", "\"jobs\"", ".select", "list_requestable_jobs", "job_assignments", "my_job_scope", "estimate_line_items", "change_orders")) {
            assertFalse("the sender must not read: `$forbidden`", sender.contains(forbidden))
        }
        for (f in listOf("ui/crew/EnquiryCaptureViewModel.kt", "ui/crew/EnquiryCaptureScreen.kt", "ui/crew/EnquiryCaptureLogic.kt")) {
            val c = code(mainSrc(f))
            for (forbidden in listOf("postgrest", "SupabaseModule", ".from(", "observeJobs", "getJob(", "JobAccess")) {
                assertFalse("$f must not reach the server or the jobs: `$forbidden`", c.contains(forbidden))
            }
        }
        // The check can fail: a sender that read the jobs view would be caught.
        assertTrue(code("client.postgrest.from(\"jobs_crew\").select()").contains(".from("))
    }

    @Test
    fun `the capture's own database code never touches jobs, and keeps no word the server said`() {
        val raw = mainSrc("data/Repository.kt")
        val from = raw.indexOf("// ---- Enquiry capture")
        val to = raw.indexOf("// ---- Build templates")
        assertTrue("the enquiry block's bounds moved", from in 0 until to)
        val enquiry = code(raw.substring(from, to))
        for (forbidden in listOf("jobDao", "observeJobs", "getJob(", "createJob", "updateJob", "lineItemDao", "changeOrderDao")) {
            assertFalse("the enquiry block must not touch `$forbidden`", enquiry.contains(forbidden))
        }
        val dao = code(mainSrc("data/Daos.kt"))
        val daoBlock = dao.substring(dao.indexOf("interface EnquiryCaptureDao"))
        val tables = Regex("(?:FROM|UPDATE|JOIN)\\s+([a-z_]+)", RegexOption.IGNORE_CASE).findAll(daoBlock).map { it.groupValues[1] }.toSet()
        assertEquals(setOf("enquiry_captures", "enquiry_capture_photos"), tables)
    }

    @Test
    fun `a server sentence that mentions a price cannot be stored or shown, only a fixed reason`() = runBlocking {
        // Whatever the server's sentence says, the phone keeps the reason as an enum name.
        val hostile = "You cannot capture enquiries. contract_total=9999 accepted_total=8888"
        val outcome = classifyEnquirySend(FailureFacts(403, hostile, notDeployed = false, noConnection = false))
        assertEquals(SendOutcome.Refused(EnquiryRefusal.NOT_ALLOWED), outcome)
        val store = FakeStore(listOf(capture(1)))
        EnquiryOutbox.flush(store, FakeWire(onSend = { outcome }), now, CO)
        assertEquals("NOT_ALLOWED", store.row(1).rejectedWhy)
        assertFalse(store.row(1).rejectedWhy.contains("9999"))
        // The entity has no field a server value could be written into beyond the two it names.
        assertEquals(
            setOf("id", "syncId", "companyId", "customerName", "phone", "email", "address", "fenceType", "approxFeet", "notes",
                "capturedAt", "sentAt", "sendingSince", "rejectedAt", "rejectedWhy"),
            EnquiryCapture::class.java.declaredFields
                .filter { !java.lang.reflect.Modifier.isStatic(it.modifiers) }.map { it.name }.toSet()
        )
    }

    @Test
    fun `a list row is only this phone's own copy of the capture and its photos`() {
        val c = capture(1)
        val row = enquiryRows(listOf(c), listOf(photo(1, 1), photo(2, 2)), CO).single()
        assertEquals(c, row.capture)
        assertEquals(listOf(1L), row.photos.map { it.id })
        // (the Compose compiler adds a static $stable marker to every class; it is not state)
        assertEquals(
            setOf("capture", "photos"),
            EnquiryRow::class.java.declaredFields.filter { !java.lang.reflect.Modifier.isStatic(it.modifiers) }.map { it.name }.toSet()
        )
    }

    // =====================================================================
    // 6. CREW CORRECT, NEVER DELETE
    // =====================================================================

    @Test
    fun `a correction is open until the office has it, and a sent one is read-only`() {
        val unsent = EnquiryRow(capture(1), emptyList())
        val sent = EnquiryRow(capture(1).copy(sentAt = 1L), emptyList())
        val refused = EnquiryRow(capture(1).copy(rejectedAt = 1L, rejectedWhy = "INVALID"), emptyList())
        assertTrue(unsent.canCorrect)
        assertTrue("a refused one can be corrected and sent again", refused.canCorrect)
        assertFalse(sent.canCorrect)
        assertEquals(EnquiryStatus.WAITING, unsent.status)
        assertEquals(EnquiryStatus.SENT, sent.status)
        assertEquals(EnquiryStatus.REJECTED, refused.status)
    }

    @Test
    fun `there is no delete anywhere on the capture path`() {
        val dao = code(mainSrc("data/Daos.kt"))
        val daoBlock = dao.substring(dao.indexOf("interface EnquiryCaptureDao"))
        assertFalse("no @Delete", daoBlock.contains("@Delete"))
        assertFalse("no DELETE FROM", Regex("DELETE\\s+FROM", RegexOption.IGNORE_CASE).containsMatchIn(daoBlock))

        val raw = mainSrc("data/Repository.kt")
        val from = raw.indexOf("// ---- Enquiry capture")
        val to = raw.indexOf("// ---- Build templates")
        assertTrue("the enquiry block's bounds moved", from in 0 until to)
        val enquiry = code(raw.substring(from, to))
        for (forbidden in listOf("delete", "remove", "queueDeletion", "deleteSynced", "pendingDeletion", "trash", "discard")) {
            assertFalse("the enquiry block mentions `$forbidden`", enquiry.contains(forbidden, ignoreCase = true))
        }
        for (f in capturePathFiles) {
            val c = code(mainSrc(f))
            for (forbidden in listOf("delete", "remove", "trash")) {
                val hits = Regex(forbidden, RegexOption.IGNORE_CASE).findAll(c).count()
                if (f == "ui/crew/EnquiryCaptureSender.kt" && forbidden == "delete") {
                    // The one delete on the path: the temporary shrunk copy of a photo in the cache directory, made
                    // for the upload and never the crew member's own file (guarded by "is it a copy").
                    assertEquals("$f: exactly the temp-copy cleanup", 1, hits)
                    assertTrue(c.contains("if (toUpload != photo.filePath) runCatching { File(toUpload).delete() }"))
                } else {
                    assertEquals("$f mentions `$forbidden`", 0, hits)
                }
            }
        }
        assertEquals(
            "the store the queue works through has no way to remove a row",
            emptyList<String>(),
            EnquiryStore::class.java.methods.map { it.name }.filter { Regex("delete|remove|clear|drop", RegexOption.IGNORE_CASE).containsMatchIn(it) }
        )
        // The check can fail: a planted delete is seen.
        assertTrue(code("@Dao interface X { @Delete suspend fun gone(c: EnquiryCapture) }").contains("@Delete"))
    }

    @Test
    fun `the correction query only lands on a capture the office does not have and nobody is sending`() {
        val dao = code(mainSrc("data/Daos.kt"))
        val at = dao.indexOf("suspend fun editUnsent")
        val sql = dao.substring(dao.lastIndexOf("@Query(", at), at)
        assertTrue(sql, sql.contains("sentAt IS NULL"))
        assertTrue(sql, sql.contains("sendingSince IS NULL OR sendingSince < :staleBefore"))
    }

    // =====================================================================
    // 7. THE GUARDS: GUEST FIRST, ADDED TO NEVER REPLACED
    // =====================================================================

    @Test
    fun `the guest demo is refused as the first statement of every write the screen can make`() {
        val vm = code(mainSrc("ui/crew/EnquiryCaptureViewModel.kt"))
        for (fn in listOf("fun save(", "fun sendAgain(")) {
            val at = vm.indexOf(fn)
            assertTrue("$fn is gone", at >= 0)
            val body = vm.substring(vm.indexOf('{', vm.indexOf(')', at)) + 1).trimStart()
            assertTrue("$fn must open with the guest refusal, not merely contain it:\n${body.take(120)}", body.startsWith("if (session.state.value.isGuestDemo)"))
        }
        val repo = code(mainSrc("data/Repository.kt"))
        for (fn in listOf("saveEnquiryCapture", "editEnquiryCapture", "retryEnquiryCapture")) {
            val at = repo.indexOf("suspend fun $fn(")
            assertTrue("$fn is gone", at >= 0)
            val rest = repo.substring(at, minOf(repo.length, at + 700))
            assertTrue("$fn must pass the guest gate first", rest.contains("guardWrite(\"$fn\")"))
        }
    }

    @Test
    fun `the screen is reachable only through a route the caller wires, and nothing here edits another file's navigation`() {
        val screen = mainSrc("ui/crew/EnquiryCaptureScreen.kt")
        assertTrue(screen.contains("const val ENQUIRY_CAPTURE_ROUTE = \"capture_enquiry\""))
        assertFalse(code(mainSrc("ui/crew/EnquiryCaptureLogic.kt")).contains("navController"))
    }

    @Test
    fun `an unsent capture is counted by the sign-out guard, so signing out cannot silently drop it`() {
        val repo = code(mainSrc("data/Repository.kt"))
        val summary = repo.substring(repo.indexOf("suspend fun unsyncedSummary()"), repo.indexOf("suspend fun hasUnsyncedWork()"))
        assertTrue(summary.contains("enquiryCaptureDao.countUnsent()"))
        assertTrue(summary.contains("enquiryCaptureDao.countPhotosNotUploaded()"))
    }
}

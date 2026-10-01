package com.fenceestimator.app.ui.crew

import com.fenceestimator.app.cloud.Permission
import com.fenceestimator.app.cloud.SessionState
import com.fenceestimator.app.data.EnquiryCapture
import com.fenceestimator.app.data.EnquiryCapturePhoto
import com.fenceestimator.app.data.FenceType
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/*
 * Capture an enquiry: the pure half.
 *
 * THE OWNER'S ANSWER, and the whole brief: a crew member who has been given
 * the permission can take down a neighbour's enquiry on the spot; it reaches
 * the office; the OFFICE prices it. Nothing here -- no type, no field, no key
 * on the wire, no sentence -- carries a price, a rate, a total or a deposit,
 * and nothing here ever asks the server what became of a capture. The phone
 * sends one enquiry and keeps its own copy; it never reads the lead back, so
 * what the office later puts on that lead cannot reach the person who
 * captured it.
 *
 * No Android, no Room, no Supabase in this file, so EnquiryCaptureTest runs
 * every rule off a device: who is offered it, what a valid capture is, what
 * goes on the wire, and the send queue that has to survive a garden with no
 * bars. The impure half (the RPC, the photo upload, the connectivity) is
 * EnquiryCaptureSender.kt.
 */

/** Who is offered the capture screen at all. */
object EnquiryCaptureAccess {

    /**
     * Whether this person is shown the way in.
     *
     * Every clause is a refusal, in the order a stranger to the phone would
     * hit them:
     *  - not signed in, or signed in but not yet known (the profile has not
     *    been read, so [SessionState.permissions] is empty by design): nobody.
     *  - no company yet: a capture is filed under the company it was taken
     *    for, so there has to be one to stamp it with.
     *  - the guest demo: look, never write -- and the demo's permission list
     *    does not hold it anyway; this is the second lock.
     *  - the permission itself, which no role holds by default.
     *  - not for anyone who can already create jobs the ordinary way
     *    (EDIT_JOBS: owner, manager, sales). They have the real thing; a
     *    capture-only form beside it would only be a second, poorer door.
     */
    fun mayCapture(state: SessionState): Boolean =
        state.signedIn &&
            state.accessKnown &&
            state.companyId != null &&
            !state.isGuestDemo &&
            state.can(Permission.CAPTURE_ENQUIRY) &&
            !state.canEditJobs

    /**
     * Whether the phone may send what is already captured. Narrower than
     * [mayCapture] on purpose: somebody who was promoted to a job-editing role
     * after capturing something still has a neighbour waiting on that call, so
     * the queue is not stranded by losing the entry point.
     */
    fun maySend(state: SessionState): Boolean =
        state.signedIn &&
            state.accessKnown &&
            !state.isGuestDemo &&
            state.companyId != null &&
            state.can(Permission.CAPTURE_ENQUIRY)
}

/** The fence kinds the form offers. Everything the app prices, bar the catch-all. */
val ENQUIRY_FENCE_CHOICES: List<FenceType> = listOf(
    FenceType.VINYL, FenceType.WOOD, FenceType.CHAIN_LINK, FenceType.ALUMINUM,
    FenceType.ORNAMENTAL_IRON, FenceType.SPLIT_RAIL, FenceType.COMPOSITE
)

/** What is wrong with a draft, by field, so the screen can say it next to the field. */
enum class EnquiryProblem { NAME, CONTACT, EMAIL, ADDRESS, FEET }

/**
 * What the form holds. Text, as typed: parsed and checked in one place
 * ([problems], [approxFeet]) so the screen and the tests read the same rules.
 *
 * The limits are the server's own (crew_capture_enquiry): a draft this passes
 * is one the server will not refuse for being the wrong shape, so a "rejected"
 * capture is the rare case it is meant to be.
 */
data class EnquiryDraft(
    val name: String = "",
    val phone: String = "",
    val email: String = "",
    val address: String = "",
    /** A [FenceType] name, or "" for "not sure". */
    val fenceType: String = "",
    val feetText: String = "",
    val notes: String = ""
) {
    /** The rough length, or null when it was left blank ("not sure") or is not a usable number. */
    fun approxFeet(): Int? {
        val t = feetText.trim()
        if (t.isEmpty()) return null
        val n = t.toIntOrNull() ?: return null
        return n.takeIf { it in MIN_FEET..MAX_FEET }
    }

    fun problems(): List<EnquiryProblem> {
        val out = ArrayList<EnquiryProblem>()
        if (name.trim().length < MIN_NAME) out += EnquiryProblem.NAME
        val mail = email.trim()
        val digits = phone.count { it.isDigit() }
        val emailOk = mail.isNotEmpty() && EMAIL.matches(mail)
        // A way to reach them: a phone number with enough digits to be one, or
        // an email. The neighbour was promised a call, so a capture with
        // neither is not a capture.
        if (digits < MIN_PHONE_DIGITS && !emailOk) out += EnquiryProblem.CONTACT
        if (mail.isNotEmpty() && !emailOk) out += EnquiryProblem.EMAIL
        if (address.trim().length < MIN_ADDRESS) out += EnquiryProblem.ADDRESS
        if (feetText.isNotBlank() && approxFeet() == null) out += EnquiryProblem.FEET
        return out
    }

    /**
     * The capture row this draft becomes: trimmed and cut to the server's limits,
     * stamped with the company it was taken under. Never carries a send state.
     */
    fun toCapture(now: Long, companyId: String): EnquiryCapture = EnquiryCapture(
        companyId = companyId,
        customerName = name.trim().take(MAX_NAME),
        phone = phone.trim().take(MAX_PHONE),
        email = email.trim().take(MAX_EMAIL),
        address = address.trim().take(MAX_ADDRESS),
        fenceType = fenceType.takeIf { t -> ENQUIRY_FENCE_CHOICES.any { it.name == t } } ?: "",
        approxFeet = approxFeet(),
        notes = notes.trim().take(MAX_NOTES),
        capturedAt = now
    )

    companion object {
        const val MIN_NAME = 2
        const val MIN_PHONE_DIGITS = 7
        const val MIN_ADDRESS = 5
        const val MIN_FEET = 1
        const val MAX_FEET = 20000
        const val MAX_NAME = 120
        const val MAX_PHONE = 40
        const val MAX_EMAIL = 120
        const val MAX_ADDRESS = 200
        const val MAX_NOTES = 1000
        private val EMAIL = Regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")

        /** A draft made from a saved capture, to correct it. */
        fun of(c: EnquiryCapture): EnquiryDraft = EnquiryDraft(
            name = c.customerName, phone = c.phone, email = c.email, address = c.address,
            fenceType = c.fenceType, feetText = c.approxFeet?.toString().orEmpty(), notes = c.notes
        )
    }
}

/**
 * What goes to the server for one capture. The key set is the contract with
 * crew_capture_enquiry: the SQL reads exactly these and nothing else, and no
 * key is, or may become, a price. Both halves of that are held by tests.
 */
object EnquiryPayload {

    val KEYS: Set<String> = linkedSetOf(
        "sync_id", "customer_name", "phone", "email", "address",
        "fence_type", "approx_feet", "notes", "captured_at_ms"
    )

    fun of(c: EnquiryCapture): JsonObject = buildJsonObject {
        put("sync_id", c.syncId)
        put("customer_name", c.customerName)
        put("phone", c.phone)
        put("email", c.email)
        put("address", c.address)
        put("fence_type", c.fenceType)
        // Absent, not zero, when the crew member did not know: "0 ft" is a
        // claim, and the office would read it as one.
        c.approxFeet?.let { put("approx_feet", it) }
        put("notes", c.notes)
        put("captured_at_ms", c.capturedAt)
    }

    /**
     * Whether the server's answer says it holds THIS capture. The RPC answers
     * `{"job_sync_id": ..., "created": ...}`; anything else -- an empty body, a
     * shape from some other function, another id -- is not "it took it", and a
     * capture is never marked delivered on a guess (an empty answer reads as
     * good news, and has before).
     */
    fun accepted(answer: JsonElement?, syncId: String): Boolean {
        val id = (answer as? JsonObject)?.get("job_sync_id") as? JsonPrimitive ?: return false
        return id.isString && id.content.equals(syncId, ignoreCase = true)
    }
}

/** Where a capture stands, for the list. Derived from the row, never stored. */
enum class EnquiryStatus {
    /** On this phone only. Goes by itself when there is signal and a sign-in. */
    WAITING,
    /** The office has it. */
    SENT,
    /** The office has it; some photos are still on this phone. */
    SENT_PHOTOS_OWED,
    /** The server refused it for good. Still here, whole, with the reason. */
    REJECTED
}

fun enquiryStatus(c: EnquiryCapture, photos: List<EnquiryCapturePhoto>): EnquiryStatus = when {
    c.sentAt != null ->
        if (photos.any { it.storagePath == null }) EnquiryStatus.SENT_PHOTOS_OWED else EnquiryStatus.SENT
    c.rejectedAt != null -> EnquiryStatus.REJECTED
    else -> EnquiryStatus.WAITING
}

/** One capture with its photos, as the list shows it. */
data class EnquiryRow(val capture: EnquiryCapture, val photos: List<EnquiryCapturePhoto>) {
    val status: EnquiryStatus get() = enquiryStatus(capture, photos)
    val photosOwed: Int get() = photos.count { it.storagePath == null }

    /** A correction is open only until the office has it. Never a delete: there is none. */
    val canCorrect: Boolean get() = capture.sentAt == null
}

/** This company's captures only: another company's, left on a shared phone, are never listed. */
fun enquiryRows(captures: List<EnquiryCapture>, photos: List<EnquiryCapturePhoto>, companyId: String): List<EnquiryRow> {
    val byCapture = photos.groupBy { it.captureId }
    return captures.filter { it.companyId == companyId }.map { EnquiryRow(it, byCapture[it.id].orEmpty()) }
}

/** Why a pass could not send everything -- all of them mean "still on this phone, will try again". */
enum class EnquiryWait {
    /** No usable connection. Waiting fixes it. */
    NO_SIGNAL,
    /** The sign-in has expired. Only signing in again fixes it; waiting does not. */
    SIGNED_OUT,
    /** The server does not have crew_capture_enquiry yet (the SQL is not applied). */
    NOT_READY,
    /** The per-hour limit. An hour fixes it. */
    LIMIT,
    /** Anything else; the work is still on the phone. */
    FAILED
}

/** Why the server turned a capture down for good. Retrying the same bytes cannot change it. */
enum class EnquiryRefusal { NOT_ALLOWED, INVALID }

sealed class SendOutcome {
    /** The server says it holds this capture. */
    object Accepted : SendOutcome()
    data class Refused(val why: EnquiryRefusal) : SendOutcome()
    data class TryLater(val why: EnquiryWait) : SendOutcome()
}

sealed class PhotoOutcome {
    data class Uploaded(val storagePath: String) : PhotoOutcome()
    /** The file is gone from this phone; it can never be uploaded. */
    object FileGone : PhotoOutcome()
    data class TryLater(val why: EnquiryWait) : PhotoOutcome()
}

/** What a failed call leaves to decide on, already stripped of the request's own URL and headers. */
data class FailureFacts(
    val httpStatus: Int?,
    /** The server's own sentence, from a REST error only -- never the exception text of the transport. */
    val serverText: String,
    /** PostgREST cannot find the function: the SQL has not been applied. */
    val notDeployed: Boolean,
    /** The request never completed: no signal. */
    val noConnection: Boolean
)

/**
 * A failed send, as a decision. The server's sentences are crew_capture_enquiry's
 * own `raise exception` lines (a test holds them to the SQL file), tried before
 * the status because postgrest-kt keeps the sentence and the status but drops
 * the SQLSTATE; the status is the fallback for any sentence this does not know.
 *
 * Only two answers are final: the server saying you may not (403 / "cannot
 * capture"), and saying what you sent is unusable (400). Everything else --
 * signed out, no signal, a busy server, a limit, a function that does not exist
 * yet -- leaves the capture on the phone to try again.
 */
fun classifyEnquirySend(f: FailureFacts): SendOutcome {
    val t = f.serverText.lowercase()
    return when {
        f.notDeployed -> SendOutcome.TryLater(EnquiryWait.NOT_READY)
        "sign in first" in t || f.httpStatus == 401 -> SendOutcome.TryLater(EnquiryWait.SIGNED_OUT)
        "in the last hour" in t || f.httpStatus == 413 || f.httpStatus == 429 ->
            SendOutcome.TryLater(EnquiryWait.LIMIT)
        "cannot capture enquiries" in t || "company suspended" in t || f.httpStatus == 403 ->
            SendOutcome.Refused(EnquiryRefusal.NOT_ALLOWED)
        "is needed" in t || "is not valid" in t || "nothing to capture" in t || f.httpStatus == 400 ->
            SendOutcome.Refused(EnquiryRefusal.INVALID)
        f.httpStatus != null && f.httpStatus >= 500 -> SendOutcome.TryLater(EnquiryWait.FAILED)
        f.noConnection -> SendOutcome.TryLater(EnquiryWait.NO_SIGNAL)
        else -> SendOutcome.TryLater(EnquiryWait.FAILED)
    }
}

/** What the outbox reads and writes. The phone implements it over Room; a test over a list. */
interface EnquiryStore {
    /** Captures the server has neither taken nor refused, oldest first. */
    suspend fun unsent(): List<EnquiryCapture>
    suspend fun get(id: Long): EnquiryCapture?
    /** Sent captures with at least one photo not uploaded yet, oldest first. */
    suspend fun sentOwingPhotos(): List<EnquiryCapture>
    suspend fun photos(captureId: Long): List<EnquiryCapturePhoto>
    /** Takes the capture to send it. False: already sent or refused, or someone else is sending it. */
    suspend fun claim(id: Long, now: Long): Boolean
    suspend fun release(id: Long)
    suspend fun markSent(id: Long, at: Long)
    suspend fun markRejected(id: Long, at: Long, why: String)
    suspend fun setPhotoPath(photoId: Long, storagePath: String)
}

/** What the phone does over the wire. */
interface EnquiryTransport {
    suspend fun send(capture: EnquiryCapture): SendOutcome
    suspend fun uploadPhoto(capture: EnquiryCapture, photo: EnquiryCapturePhoto): PhotoOutcome
}

data class EnquiryFlushResult(
    val sent: Int,
    val photosUploaded: Int,
    val refused: Int,
    /** Why the pass stopped early, or null if it got through everything it had. */
    val waiting: EnquiryWait?
)

/**
 * The send queue: every capture goes up when it can, and not one is lost,
 * doubled, or marked delivered on a guess.
 *
 *  - A capture is claimed before it is sent, read again after the claim (so a
 *    correction typed a moment earlier is what goes), and marked sent only when
 *    the server says it holds that capture.
 *  - A pass that cannot send -- no signal, signed out, a busy server -- gives
 *    the claim back, writes nothing else, and stops: the remaining captures
 *    would fail the same way. Nothing is retried in a loop here; the caller
 *    runs another pass when something changes (signal, a sign-in, a tap).
 *  - A refusal is final and is kept: the capture stays on the phone, whole,
 *    with the reason. Never deleted, never retried by itself.
 *  - The same capture sent twice (the answer was lost) is harmless: the
 *    server answers its sync id with "already have it".
 *  - Photos go after the lead exists, one at a time, oldest capture first.
 *    A photo that fails stays owed; the capture is already with the office.
 *  - Nothing here removes a row. There is no delete in [EnquiryStore] to call.
 *  - Only captures taken under [companyId] are touched. Another company's,
 *    still on a phone that changed hands, stay exactly as they are -- never
 *    sent, never claimed, never refused -- because the server files a capture
 *    under whoever is signed in, and that would be the wrong business.
 */
object EnquiryOutbox {

    suspend fun flush(
        store: EnquiryStore,
        transport: EnquiryTransport,
        now: () -> Long,
        companyId: String
    ): EnquiryFlushResult {
        var sent = 0
        var photosUp = 0
        var refused = 0
        var waiting: EnquiryWait? = null

        for (queued in store.unsent()) {
            if (waiting != null) break
            if (queued.companyId != companyId) continue
            if (!store.claim(queued.id, now())) continue
            // The row as it is now: a correction can have landed between the
            // list and the claim, and it is the corrected one that goes.
            val capture = store.get(queued.id)
            if (capture == null || capture.sentAt != null) {
                store.release(queued.id)
                continue
            }
            val outcome = try {
                transport.send(capture)
            } catch (e: CancellationException) {
                store.release(queued.id)
                throw e
            } catch (e: Throwable) {
                SendOutcome.TryLater(EnquiryWait.FAILED)
            }
            when (outcome) {
                SendOutcome.Accepted -> {
                    store.markSent(capture.id, now())
                    sent++
                }
                is SendOutcome.Refused -> {
                    store.markRejected(capture.id, now(), outcome.why.name)
                    refused++
                }
                is SendOutcome.TryLater -> {
                    store.release(capture.id)
                    waiting = outcome.why
                }
            }
        }

        if (waiting == null) {
            for (capture in store.sentOwingPhotos()) {
                if (waiting != null) break
                if (capture.companyId != companyId) continue
                for (photo in store.photos(capture.id).filter { it.storagePath == null }) {
                    val outcome = try {
                        transport.uploadPhoto(capture, photo)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Throwable) {
                        PhotoOutcome.TryLater(EnquiryWait.FAILED)
                    }
                    when (outcome) {
                        is PhotoOutcome.Uploaded -> {
                            store.setPhotoPath(photo.id, outcome.storagePath)
                            photosUp++
                        }
                        PhotoOutcome.FileGone -> store.setPhotoPath(photo.id, EnquiryCapturePhoto.FILE_GONE)
                        is PhotoOutcome.TryLater -> {
                            waiting = outcome.why
                            break
                        }
                    }
                }
            }
        }
        return EnquiryFlushResult(sent, photosUp, refused, waiting)
    }
}

package com.fenceestimator.app.ui.crew

import android.content.Context
import com.fenceestimator.app.cloud.FileSync
import com.fenceestimator.app.cloud.ImageCompressor
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.cloud.SupabaseModule
import com.fenceestimator.app.cloud.SyncFailure
import com.fenceestimator.app.cloud.isNotDeployedYet
import com.fenceestimator.app.data.EnquiryCapture
import com.fenceestimator.app.data.EnquiryCapturePhoto
import com.fenceestimator.app.data.Repository
import io.github.jan.supabase.exceptions.RestException
import io.github.jan.supabase.postgrest.postgrest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File

/*
 * Capture an enquiry: the half that touches the network, the clock and the disk.
 *
 * The rules it follows live in EnquiryCaptureLogic.kt and are tested off a
 * device. This file is deliberately thin: one RPC, one upload, and the glue
 * that runs a pass.
 *
 * What it does NOT do, on purpose: read anything back. The only calls here are
 * `rpc("crew_capture_enquiry")` and a storage upload. There is no select on
 * jobs, no look at the crew views, no asking after the lead -- so what the
 * office puts on the lead afterwards, a price above all, has no road to the
 * phone of the person who captured it. EnquiryCaptureTest reads this file's
 * source and fails on a read that is not one of those two.
 */

/** The store the outbox reads and writes, over Room. */
class RepositoryEnquiryStore(private val repository: Repository) : EnquiryStore {
    override suspend fun unsent(): List<EnquiryCapture> = repository.enquiriesToSend()
    override suspend fun get(id: Long): EnquiryCapture? = repository.getEnquiryCapture(id)
    override suspend fun sentOwingPhotos(): List<EnquiryCapture> = repository.enquiriesOwingPhotos()
    override suspend fun photos(captureId: Long): List<EnquiryCapturePhoto> = repository.enquiryPhotos(captureId)
    override suspend fun claim(id: Long, now: Long): Boolean = repository.claimEnquiry(id, now)
    override suspend fun release(id: Long) = repository.releaseEnquiry(id)
    override suspend fun markSent(id: Long, at: Long) { repository.markEnquirySent(id, at) }
    override suspend fun markRejected(id: Long, at: Long, why: String) = repository.markEnquiryRejected(id, at, why)
    override suspend fun setPhotoPath(photoId: Long, storagePath: String) =
        repository.setEnquiryPhotoStoragePath(photoId, storagePath)
}

/**
 * The wire. One RPC for the lead, then the photos into the lead's own folder
 * (`{company}/{lead}/photo/`, which the office's job sheet already lists).
 */
class SupabaseEnquiryTransport(
    private val context: Context,
    private val companyId: String
) : EnquiryTransport {

    override suspend fun send(capture: EnquiryCapture): SendOutcome {
        if (!SupabaseModule.isConfigured) return SendOutcome.TryLater(EnquiryWait.NOT_READY)
        gateOnSession()?.let { return SendOutcome.TryLater(it) }
        return try {
            val answer = withContext(Dispatchers.IO) {
                SupabaseModule.client.postgrest.rpc(
                    "crew_capture_enquiry",
                    buildJsonObject { put("p_capture", EnquiryPayload.of(capture)) }
                ).decodeAs<JsonElement>()
            }
            // Only the server saying it holds THIS capture counts. A 200 with
            // some other body is not good news.
            if (EnquiryPayload.accepted(answer, capture.syncId)) SendOutcome.Accepted
            else SendOutcome.TryLater(EnquiryWait.FAILED)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            classifyEnquiryFailure(e)
        }
    }

    override suspend fun uploadPhoto(capture: EnquiryCapture, photo: EnquiryCapturePhoto): PhotoOutcome {
        val file = File(photo.filePath)
        if (!file.exists() || file.length() == 0L) return PhotoOutcome.FileGone
        gateOnSession()?.let { return PhotoOutcome.TryLater(it) }
        // Shrunk before it goes up, as every job photo is: a phone photo is
        // several megabytes and this goes over the crew's own data, from a
        // yard, at the moment signal is worst. The original stays on the phone.
        val toUpload = withContext(Dispatchers.IO) { ImageCompressor.compressForUpload(photo.filePath, context.cacheDir) }
        val remote = FileSync.upload(companyId, capture.syncId, "photo", toUpload)
        if (toUpload != photo.filePath) runCatching { File(toUpload).delete() }
        return if (remote != null) PhotoOutcome.Uploaded(remote) else PhotoOutcome.TryLater(EnquiryWait.NO_SIGNAL)
    }

    private suspend fun gateOnSession(): EnquiryWait? = sessionGate()
}

/**
 * Null when there is a live sign-in to send with; otherwise why not. Asks the
 * Auth plugin rather than the network (see tryRefreshSession), and says
 * SIGNED_OUT only when the server has answered no -- a dead spot is NO_SIGNAL,
 * and the two read very differently to somebody who has just been told to sign
 * in again.
 */
internal suspend fun sessionGate(): EnquiryWait? {
    if (!SupabaseModule.isConfigured) return EnquiryWait.NOT_READY
    if (SupabaseModule.hasLiveSession()) return null
    return when (SupabaseModule.tryRefreshSession()) {
        SupabaseModule.RefreshOutcome.OK -> null
        SupabaseModule.RefreshOutcome.SIGNED_OUT -> EnquiryWait.SIGNED_OUT
        SupabaseModule.RefreshOutcome.NO_NETWORK -> EnquiryWait.NO_SIGNAL
        // Not yet knowable (still loading, or asked too soon): neither
        // "signed out" nor "no signal", so neither is claimed.
        SupabaseModule.RefreshOutcome.UNKNOWN -> EnquiryWait.FAILED
    }
}

/** A thrown failure as a decision: the sentence and status the library kept, plus the two transport tests. */
internal fun classifyEnquiryFailure(e: Throwable): SendOutcome {
    val chain = generateSequence(e) { it.cause }.toList()
    val rest = chain.firstNotNullOfOrNull { it as? RestException }
    return classifyEnquirySend(
        FailureFacts(
            httpStatus = rest?.statusCode,
            // The REST error's own words, never the request: its URL names the
            // RPC, and a phrase test must not match the question instead of
            // the answer.
            serverText = rest?.let { listOfNotNull(it.error, it.description).joinToString(" ") }.orEmpty(),
            notDeployed = isNotDeployedYet(e),
            noConnection = SyncFailure.isTransientNetwork(e)
        )
    )
}

/**
 * Runs a pass of the outbox. Safe to call from anywhere, any number of times: a
 * pass already running makes the call return at once, and the claim on each
 * capture means two passes could not send one twice even if they overlapped.
 *
 * Called by the capture screen (on save and when signal returns) and by the
 * entry card on the crew home (every time it is shown). It is ALSO meant to be
 * called by the sync pass -- see the hand-over: AutoSync.runSync, after the
 * table pushes, `runCatching { EnquiryOutboxRunner.flush(repository, session, context) }`
 * -- so a capture goes up on the heartbeat and on the signal-returned trigger
 * with no screen open. Until that line is added, delivery waits for one of the
 * two screens above.
 */
object EnquiryOutboxRunner {

    private val mutex = Mutex()
    private val _waiting = MutableStateFlow<EnquiryWait?>(null)

    /**
     * Why the last pass stopped early, or null if it got through everything. In
     * memory only, on purpose: writing it to the database each pass would wake
     * the very sync that runs the next pass.
     */
    val waiting: StateFlow<EnquiryWait?> = _waiting

    /**
     * Whether a send could be made right now, asked without sending anything:
     * the capture screen calls it as it opens, so "you are signed out" is said
     * before somebody has typed a neighbour's details, not after. Only moves
     * the two reasons it can know (signed out, no signal); anything a real pass
     * learned (a limit, the server not ready) is left as that pass left it.
     */
    suspend fun checkSession() {
        val gate = sessionGate()
        _waiting.update { current ->
            when {
                gate != null -> gate
                current == EnquiryWait.SIGNED_OUT || current == EnquiryWait.NO_SIGNAL -> null
                else -> current
            }
        }
    }

    /**
     * @return the pass's result, or null if nothing ran (no right to send, no
     *   company yet, or another pass is already running).
     */
    suspend fun flush(repository: Repository, session: SessionManager, context: Context): EnquiryFlushResult? {
        val state = session.state.value
        if (!EnquiryCaptureAccess.maySend(state)) return null
        val company = state.companyId ?: return null
        if (!mutex.tryLock()) return null
        try {
            val result = EnquiryOutbox.flush(
                RepositoryEnquiryStore(repository),
                SupabaseEnquiryTransport(context.applicationContext, company),
                System::currentTimeMillis,
                company
            )
            _waiting.value = result.waiting
            return result
        } finally {
            mutex.unlock()
        }
    }
}

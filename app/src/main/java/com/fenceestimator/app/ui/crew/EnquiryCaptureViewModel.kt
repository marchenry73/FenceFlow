package com.fenceestimator.app.ui.crew

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.FenceEstimatorApp
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.EnquiryEditResult
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.ui.components.UiMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * The capture screen's brain: save, correct, send again -- and nothing that
 * removes anything. There is no delete function on this class and none may be
 * added (EnquiryCaptureTest reads this file).
 *
 * Saving is local and instant. The send runs after, in the background, and its
 * result arrives as the list's own status flipping from "waiting" to "sent":
 * a request over one bar of signal can hang for half a minute, and a crew
 * member standing in a garden must not be held on a spinner for it.
 */
class EnquiryCaptureViewModel(
    private val repository: Repository,
    private val session: SessionManager,
    private val appContext: Context
) : ViewModel() {

    /**
     * This company's captures on this phone, newest first, with their photos.
     * Local only: the server is never asked. Another company's, left on a phone
     * that changed hands, are not listed.
     */
    val rows: StateFlow<List<EnquiryRow>> = combine(
        repository.observeEnquiryCaptures(),
        repository.observeEnquiryPhotos(),
        session.state.map { it.companyId.orEmpty() }.distinctUntilChanged()
    ) { captures, photos, company -> enquiryRows(captures, photos, company) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * Where a send runs. The application's scope when there is one, so a send
     * started by Save is not cancelled by walking away from the form a second
     * later -- the capture is on the phone either way, but the neighbour is
     * waiting on the office to have it. The screen's own scope is the fallback.
     */
    private val workScope: CoroutineScope
        get() = (appContext as? FenceEstimatorApp)?.applicationScope ?: viewModelScope

    private val _message = MutableStateFlow<UiMessage?>(null)
    val message: StateFlow<UiMessage?> = _message

    fun consumeMessage() {
        _message.value = null
    }

    /**
     * Saves a new capture, or -- with [editingId] -- a correction to one the
     * office does not have yet. [onSaved] runs once it is on the phone, so the
     * screen can clear its form; it does not wait for the send.
     */
    fun save(draft: EnquiryDraft, photoPaths: List<String>, editingId: Long?, onSaved: () -> Unit) {
        // The guest demo looks and never writes. First statement, before
        // anything is read or launched.
        if (session.state.value.isGuestDemo) {
            _message.value = UiMessage(R.string.enq_not_allowed)
            return
        }
        // One save at a time: a second tap before the form clears must not
        // become a second enquiry, and so a second call to the neighbour.
        if (saving) return
        saving = true
        viewModelScope.launch {
            try {
                saveNow(draft, photoPaths, editingId, onSaved)
            } finally {
                saving = false
            }
        }
    }

    private var saving = false

    private suspend fun saveNow(draft: EnquiryDraft, photoPaths: List<String>, editingId: Long?, onSaved: () -> Unit) {
        if (!EnquiryCaptureAccess.mayCapture(session.state.value)) {
            _message.value = UiMessage(R.string.enq_not_allowed)
            return
        }
        // The screen shows the problems beside the fields; this is the second
        // look, for a caller that did not.
        if (draft.problems().isNotEmpty()) {
            _message.value = UiMessage(R.string.enq_err_check)
            return
        }
        val now = System.currentTimeMillis()
        // mayCapture has just said there is a company; stamped on the capture so
        // it can only ever go up under the business it was taken for.
        val company = session.state.value.companyId ?: return
        if (editingId == null) {
            repository.saveEnquiryCapture(draft.toCapture(now, company), photoPaths)
            _message.value = UiMessage(R.string.enq_saved_local)
        } else {
            val fixed = draft.toCapture(now, company)
            val result = repository.editEnquiryCapture(
                id = editingId,
                name = fixed.customerName, phone = fixed.phone, email = fixed.email,
                address = fixed.address, fenceType = fixed.fenceType, approxFeet = fixed.approxFeet,
                notes = fixed.notes, newPhotoPaths = photoPaths
            )
            when (result) {
                EnquiryEditResult.SAVED -> _message.value = UiMessage(R.string.enq_changes_saved)
                EnquiryEditResult.BUSY_SENDING -> {
                    _message.value = UiMessage(R.string.enq_edit_busy)
                    return
                }
                EnquiryEditResult.LOCKED_SENT, EnquiryEditResult.NOT_FOUND -> {
                    _message.value = UiMessage(R.string.enq_edit_locked)
                    return
                }
            }
        }
        onSaved()
        send()
    }

    /** "Send again" on a capture the server refused: back in the queue, then a pass. */
    fun sendAgain(captureId: Long) {
        if (session.state.value.isGuestDemo) return
        workScope.launch {
            if (repository.retryEnquiryCapture(captureId)) send()
        }
    }

    /**
     * One pass of the outbox. The list shows what came of it.
     *
     * A pass already running (the crew home's card starts one every time it is
     * shown) makes this one return at once -- and that pass may have read the
     * queue before this capture was saved. So it asks again a couple of times
     * rather than leave the new one waiting for the next trigger.
     */
    fun send() {
        workScope.launch {
            repeat(SEND_ATTEMPTS) {
                if (EnquiryOutboxRunner.flush(repository, session, appContext) != null) return@launch
                if (!EnquiryCaptureAccess.maySend(session.state.value)) return@launch
                delay(SEND_RETRY_MS)
            }
        }
    }

    /**
     * Whether this phone can send right now, found out before anyone types
     * anything -- so somebody who is signed out hears it at the start, not
     * after the neighbour has gone indoors.
     */
    fun checkSignIn() {
        viewModelScope.launch { EnquiryOutboxRunner.checkSession() }
    }

    private companion object {
        const val SEND_ATTEMPTS = 3
        const val SEND_RETRY_MS = 1500L
    }
}

package com.fenceestimator.app.ui.runs

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.cloud.SessionManager
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.estimate.DrawingScale
import com.fenceestimator.app.estimate.TakeoffRefresher
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.RunSplit
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

class RunEditViewModel(
    private val repository: Repository,
    private val runId: Long,
    /**
     * Who is holding the phone, so [update] can refuse a guest in the
     * read-only demo -- the same reference JobDetailViewModel takes and for
     * the same reason: read live rather than as a boolean fixed at
     * construction, so a demo that starts or ends while this screen is
     * already open is still caught.
     *
     * Every field on this screen is disabled today by RunEditScreen's own
     * `editable` (see the comment there), which is what has kept this table
     * safe so far -- but that was equally true of the twelve controls closed
     * elsewhere in this wave, right up until one of them was not. This is the
     * second line of defence, not the only one.
     */
    private val session: SessionManager
) : ViewModel() {
    val run: StateFlow<FenceRun?> = repository.observeFenceRun(runId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    /**
     * An ordinary field edit on this side, AND the re-pricing it earns.
     *
     * [setFenceType] below spells out why the type could not go through here:
     * the only re-pricing watcher in the app is on the drawing screen, so a
     * side edited on THIS screen kept the old numbers priced on it. That was
     * never specific to the type. Panel height, panel width, post spacing,
     * concrete bags per post, the rail count, the picket spacing and the
     * teardown flag are all spec, they all pick different catalog rows or
     * different quantities, and every one of them went through here and
     * stopped -- so the estimate kept billing the previous spec until somebody
     * pressed Suggest Quantities, while every other surface in the app already
     * read the new one off the row. That gap is what makes a total appear to
     * change on its own later.
     *
     * [TakeoffRefresher.pricingSignature] is what decides, rather than a list
     * of field names kept in step by hand: it is the run with identity, the
     * sync clock, the label and the sort order taken out, which is precisely
     * "everything the price is made of". Rename a side and nothing re-prices;
     * move its height and it does.
     *
     * Re-read first, for the same reason [setFenceType] does: the screen's
     * copy can be stale, and a spec written over a stale row undoes whatever
     * else moved on it.
     */
    fun update(transform: (FenceRun) -> FenceRun) {
        if (session.state.value.isGuestDemo) return
        if (run.value == null) return
        viewModelScope.launch {
            val fresh = repository.getFenceRun(runId) ?: return@launch
            val updated = transform(fresh)
            repository.updateFenceRun(updated)
            if (TakeoffRefresher.pricingSignature(fresh) !=
                TakeoffRefresher.pricingSignature(updated)
            ) {
                TakeoffRefresher.refreshRun(
                    repository = repository,
                    run = updated,
                    mayReprice = TakeoffRefresher.mayReprice(session.state.value)
                )
            }
        }
    }

    /**
     * Changing WHAT KIND OF FENCE this side is, which is not an ordinary field
     * edit and must not go through [update].
     *
     * Vinyl, wood and chain link pick different catalog rows, different posts
     * and different hardware, so the type IS the price. [update] writes the row
     * and stops; the only re-pricing watcher in the app is on the drawing
     * screen (`SurveyViewModel.watchDrawingForRepricing`), so a side switched
     * here kept the previous type's panels, posts and caps priced on it until
     * somebody pressed Suggest Quantities on the estimate -- with every surface
     * in the app already reading the new type off the row.
     *
     * Delegated to [SideTypesViewModel]'s two steps rather than restated:
     * [RunTypeChange.apply] for the spacing follow and the height carry, then
     * [TakeoffRefresher.refreshAfterTypeChange]. Both pickers, one set of
     * rules.
     */
    fun setFenceType(newType: com.fenceestimator.app.data.FenceType) {
        if (session.state.value.isGuestDemo) return
        val current = run.value ?: return
        if (current.fenceType == newType) return
        viewModelScope.launch {
            // Re-read rather than trusting the screen's copy: another phone's
            // sync or the drawing screen can have moved this row since it was
            // collected, and a type change written over a stale row undoes
            // whatever else moved on it.
            val fresh = repository.getFenceRun(runId) ?: return@launch
            val updated = RunTypeChange.apply(fresh, newType)
            repository.updateFenceRun(updated)
            TakeoffRefresher.refreshAfterTypeChange(
                repository = repository,
                run = updated,
                mayReprice = TakeoffRefresher.mayReprice(session.state.value)
            )
        }
    }

    // -----------------------------------------------------------------
    // CUTTING THIS SIDE IN TWO, so part of it can be a different height.
    // -----------------------------------------------------------------

    /** What the split dialog needs to know, or null when this side cannot be measured. */
    data class SplitContext(
        val totalFeet: Float,
        /** How far along each corner sits, offered as one-tap cut points. */
        val cornerFeet: List<Float>,
        /**
         * The footage was TYPED rather than drawn, so the cut is arithmetic on
         * his figure. No corners are offered in that case: the drawing, if
         * there even is one, is not what the price is measured from, so its
         * corners are not distances he can trust.
         */
        val typed: Boolean,
    )

    val splitContext: StateFlow<SplitContext?> = run
        .map { r -> r?.let { splitContextFor(it) } }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    private suspend fun splitContextFor(r: FenceRun): SplitContext? {
        val typedFeet = r.manualLinearFeet?.takeIf { it > 0f && it.isFinite() }
        if (typedFeet != null) return SplitContext(typedFeet, emptyList(), typed = true)
        // DrawingScale.of, not the engine's `calibration ?: GRID`: an
        // uncalibrated survey photo genuinely has no scale, and measuring a cut
        // on it at the grid's 20 units per foot would put the cut somewhere
        // other than where he asked. Null here is the screen saying so.
        val scale = repository.getJob(r.jobId)?.let { DrawingScale.of(it) } ?: return null
        val points = FenceCodec.decodePoints(r.pointsEncoded)
        if (points.size < 2) return null
        val total = RunSplit.totalFeet(points, r.closedLoop, scale)
        if (!(total > 2f * RunSplit.MIN_PIECE_FT)) return null
        return SplitContext(total, RunSplit.cornerDistancesFeet(points, r.closedLoop, scale), typed = false)
    }

    sealed interface SplitOutcome {
        data class Done(
            val firstFeet: Float,
            val secondFeet: Float,
            val newLabel: String,
            /** Set when the cut fell inside a gate's opening; names the side that kept it. */
            val gateStayedWith: String?,
        ) : SplitOutcome

        /** The distance is off the end of the side, or leaves a piece with no length. */
        data object OffTheEnd : SplitOutcome

        /** No scale to measure the cut at -- an uncalibrated survey photo. */
        data object NotMeasurable : SplitOutcome
    }

    private val _splitOutcome = MutableStateFlow<SplitOutcome?>(null)
    val splitOutcome: StateFlow<SplitOutcome?> = _splitOutcome
    fun clearSplitOutcome() { _splitOutcome.value = null }

    /**
     * Cuts this side [atFeet] from its start, leaving two sides whose heights
     * can be set independently.
     *
     * THE FOOTAGE IS CONSERVED, which is the whole contract: a cut is meant to
     * change a height and nothing else, so the two pieces together measure what
     * the one side measured. RunSplit asserts that on the geometry; this half
     * must not undo it, which is why the far piece carries the cut point as its
     * first point rather than starting after it.
     */
    fun splitAt(atFeet: Float) {
        if (session.state.value.isGuestDemo) return
        viewModelScope.launch {
            // Re-read, for the reason setFenceType gives: the screen's copy can
            // be stale, and a split written over a stale row undoes whatever
            // else moved on it -- here that would be a drawing edit, and the
            // drawing is what the cut is measured on.
            val fresh = repository.getFenceRun(runId) ?: return@launch
            val scale = repository.getJob(fresh.jobId)?.let { DrawingScale.of(it) }
            val points = FenceCodec.decodePoints(fresh.pointsEncoded)
            val gates = FenceCodec.decodeGates(fresh.gatesEncoded)
            val typedFeet = fresh.manualLinearFeet?.takeIf { it > 0f && it.isFinite() }

            // Whether this side is PRICED decides whether the new one is. A
            // priced side that split into one priced and one unpriced piece
            // would drop half its materials off the quote while the drawing and
            // the footage both still looked right -- the quietest money bug
            // there is. An unpriced side stays unpriced on both halves: nobody
            // has chosen to price this job yet.
            val wasPriced = repository.getLineItems(fresh.jobId)
                .any { it.fenceRunId == fresh.id && it.role != com.fenceestimator.app.data.MaterialRole.NONE }

            val siblings = repository.getFenceRuns(fresh.jobId)
            val newLabel = RunSplit.splitLabel(fresh.label, siblings.map { it.label })
            val newSortOrder = (siblings.maxOfOrNull { it.sortOrder } ?: -1) + 1

            var firstFeet: Float
            var secondFeet: Float
            var gateStayedWith: String? = null

            var keep = fresh
            var far = fresh

            if (typedFeet != null) {
                val typed = RunSplit.planTyped(typedFeet, atFeet)
                if (!typed.ok) { _splitOutcome.value = SplitOutcome.OffTheEnd; return@launch }
                firstFeet = typed.firstFeet
                secondFeet = typed.secondFeet
                keep = keep.copy(manualLinearFeet = typed.firstFeet)
                // The corners he typed stay with the near piece and the far one
                // starts at none. There is no way to know which piece the
                // corners were on -- there is no drawing to look at -- and
                // guessing a split of them would put posts on the quote for
                // bends nobody has described. He can type the far side's own.
                far = far.copy(manualLinearFeet = typed.secondFeet, manualCornerCount = 0)
                // If there IS a drawing as well, cut it at the same FRACTION so
                // the plan still looks like the side it is pricing. The typed
                // figure is what the price comes from either way.
                if (scale != null && points.size >= 2) {
                    val drawn = RunSplit.totalFeet(points, fresh.closedLoop, scale)
                    val geo = RunSplit.plan(points, gates, fresh.closedLoop, drawn * (atFeet / typedFeet), scale)
                    if (geo.ok) {
                        keep = keep.copy(
                            pointsEncoded = FenceCodec.encodePoints(geo.first),
                            gatesEncoded = FenceCodec.encodeGates(geo.firstGates),
                            closedLoop = false,
                        )
                        far = far.copy(
                            pointsEncoded = FenceCodec.encodePoints(geo.second),
                            gatesEncoded = FenceCodec.encodeGates(geo.secondGates),
                            closedLoop = false,
                        )
                    }
                }
            } else {
                if (scale == null) { _splitOutcome.value = SplitOutcome.NotMeasurable; return@launch }
                val geo = RunSplit.plan(points, gates, fresh.closedLoop, atFeet, scale)
                if (!geo.ok) {
                    _splitOutcome.value =
                        if (geo.refusal == RunSplit.Refusal.NOT_MEASURABLE) SplitOutcome.NotMeasurable
                        else SplitOutcome.OffTheEnd
                    return@launch
                }
                firstFeet = geo.firstFeet
                secondFeet = geo.secondFeet
                keep = keep.copy(
                    pointsEncoded = FenceCodec.encodePoints(geo.first),
                    gatesEncoded = FenceCodec.encodeGates(geo.firstGates),
                    closedLoop = false,
                )
                far = far.copy(
                    pointsEncoded = FenceCodec.encodePoints(geo.second),
                    gatesEncoded = FenceCodec.encodeGates(geo.secondGates),
                    closedLoop = false,
                )
                if (geo.cutsThroughGate != null) {
                    val keptByNear = geo.firstGates.contains(geo.cutsThroughGate)
                    gateStayedWith = if (keptByNear) fresh.label else newLabel
                }
            }

            // A CUT END CARRIES NO JOINT, the same rule eraseSegment follows:
            // the joint ids say this end shares a post with another side and the
            // engine deducts a post for one, so an id left on an end that has
            // just become a cut bills a shared corner that is not there -- a
            // post, a cap and a bag short.
            keep = keep.copy(endJoint = "")
            far = far.copy(
                id = 0,
                // Its OWN cloud identity. copy() keeps the original's, and two
                // rows sharing one syncId is how deleting one kills the other on
                // every phone.
                syncId = java.util.UUID.randomUUID().toString(),
                label = newLabel,
                sortOrder = newSortOrder,
                startJoint = "",
                endJoint = fresh.endJoint,
            )

            repository.updateFenceRun(keep)
            val farId = repository.createFenceRun(far)

            val mayReprice = TakeoffRefresher.mayReprice(session.state.value)
            TakeoffRefresher.refreshRun(repository, keep, mayReprice)
            TakeoffRefresher.refreshRun(
                repository, far.copy(id = farId), mayReprice,
                priceUnpriced = wasPriced,
            )

            _splitOutcome.value = SplitOutcome.Done(
                firstFeet = firstFeet,
                secondFeet = secondFeet,
                newLabel = newLabel,
                gateStayedWith = gateStayedWith,
            )
        }
    }

    /**
     * Deletes this side, and re-prices the ones left behind.
     *
     * [Repository.deleteFenceRun] frees the joint ids this run held, so a side
     * that shared a corner post with it goes back to needing its own end post.
     * Its OWN row never changed, so no signature watcher will ever look at it,
     * and it would sit one post short on the customer's quote until something
     * unrelated happened to touch it. Every remaining run, therefore, not just
     * a guessed partner: a job has a handful of sides, a delete is rare, and a
     * side missed here is money.
     */
    fun delete(onDeleted: () -> Unit) {
        val current = run.value ?: return
        viewModelScope.launch {
            val jobId = current.jobId
            repository.deleteFenceRun(current)
            val mayReprice = TakeoffRefresher.mayReprice(session.state.value)
            if (mayReprice) {
                for (other in repository.getFenceRuns(jobId)) {
                    TakeoffRefresher.refreshRun(repository, other, mayReprice = true)
                }
            }
            onDeleted()
        }
    }
}

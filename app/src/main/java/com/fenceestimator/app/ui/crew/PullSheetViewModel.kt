package com.fenceestimator.app.ui.crew

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.EstimateLineItem
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.MaterialItem
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.SiteMarker
import com.fenceestimator.app.estimate.PlanExtent
import com.fenceestimator.app.estimate.TakeoffRefresher
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

/**
 * The pull sheet's state: the job, the drawing, and what the takeoff says to
 * load, with the ticks this phone remembers.
 *
 * READS ONLY. This view model writes nothing to the job, the runs, the line
 * items or the catalog -- the only thing it writes is a tick and a
 * substitution note, both into [PullSheetTickStore], which is a local
 * preferences file. Nothing on this page can re-price a job, which matters
 * because this is the one screen designed to be used by whoever is standing at
 * a supply counter.
 *
 * It also never re-prices by accident. [com.fenceestimator.app.estimate.TakeoffRefresher]
 * is deliberately NOT started here, the same trap [CrewFencePlanScreen] had to
 * close: that screen built a [com.fenceestimator.app.ui.survey.SurveyViewModel]
 * only to read a drawing, and its init kicked off a takeoff refresh on a crew
 * phone whose catalog has every price scrubbed -- which chose different
 * products and pushed its own quantities over the office's on every sync.
 */
class PullSheetViewModel(
    private val repository: Repository,
    private val jobId: Long,
    context: Context,
) : ViewModel() {

    private val ticks = PullSheetTickStore(context)

    val job: StateFlow<Job?> = repository.observeJob(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val runs: StateFlow<List<FenceRun>> = repository.observeFenceRuns(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val siteMarkers: StateFlow<List<SiteMarker>> = repository.observeSiteMarkers(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val lineItems: StateFlow<List<EstimateLineItem>> = repository.observeLineItems(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    /**
     * The catalog, read for ONE reason: to say whether the product the takeoff
     * named is still the right product -- its height and whether its filing
     * was ever checked. No price is read from it, and
     * [PullSheetCatalogRow] has no field to carry one.
     */
    private val catalog: StateFlow<List<MaterialItem>> = repository.observeFullCatalog()
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    val sheet: StateFlow<PullSheetState> =
        combine(job, runs, lineItems, catalog) { job, runs, lines, catalog ->
            if (job == null) PullSheetState.NoRuns else buildPullSheet(
                runs = runs.map { run -> toPullSheetRun(job, run) },
                lines = lines.mapNotNull { item -> toSourceLine(item) },
                catalog = catalog.map { item ->
                    PullSheetCatalogRow(
                        name = item.name,
                        role = item.role,
                        heightFt = item.heightFt,
                        sourceDoc = item.sourceDoc,
                    )
                },
            )
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), PullSheetState.NoRuns)

    /**
     * Seeded from the store at construction, not after it. The view model is
     * rebuilt every time the screen is left and returned to, and that is
     * exactly the case this page has to survive -- so the first frame has to
     * already know what was ticked rather than flashing an unticked sheet.
     */
    private val _ticked = MutableStateFlow(ticks.tickedKeys(jobId))
    val ticked: StateFlow<Set<String>> = _ticked

    /** Bumped by [setSubstitution] so [notes] recomputes; the store has no flow. */
    private val noteRevision = MutableStateFlow(0)

    /**
     * Substitution notes for the lines currently on the sheet.
     *
     * DERIVED FROM [sheet], not seeded once. An earlier version read the store
     * in `init` against `sheet.value`, which at construction is still the
     * initial [PullSheetState.NoRuns] -- so the key list was empty, every note
     * already on the phone read as absent, and the only notes that ever showed
     * were the ones typed in that same session. Reading it off whatever the
     * sheet currently holds is what makes a note survive the screen being left,
     * which is the whole reason it is stored at all.
     */
    val notes: StateFlow<Map<String, String>> =
        combine(sheet, noteRevision) { state, _ ->
            val keys = (state as? PullSheetState.Ready)
                ?.groups?.flatMap { group -> group.lines.map { it.key } }
                .orEmpty()
            ticks.substitutions(jobId, keys)
        }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())

    fun setTicked(lineKey: String, isTicked: Boolean) {
        ticks.setTicked(jobId, lineKey, isTicked)
        _ticked.value = ticks.tickedKeys(jobId)
    }

    fun clearTicks() {
        ticks.clearTicks(jobId)
        _ticked.value = ticks.tickedKeys(jobId)
    }

    fun setSubstitution(lineKey: String, note: String) {
        ticks.setSubstitution(jobId, lineKey, note)
        noteRevision.value += 1
    }

    /**
     * A run reduced for [buildPullSheet].
     *
     * `hasWork` is the same two-part test the plan screen uses to decide
     * whether a run is on the drawing at all -- typed footage, or something
     * drawn ([PlanExtent.hasSomethingToDraw], which counts a gate-only run) --
     * so a run quoted by typing its length is not reported as "nothing here".
     *
     * `measurable` is [TakeoffRefresher.blockedByUncalibratedPhoto] inverted,
     * the app's existing answer to "can this run be measured honestly right
     * now". Its materials on an uncalibrated photo are not wrong, they do not
     * exist, and the sheet must say that rather than show an empty section.
     */
    private fun toPullSheetRun(job: Job, run: FenceRun): PullSheetRun = PullSheetRun(
        id = run.id,
        label = run.label,
        isTeardown = run.isTeardown,
        fenceHeightFt = run.panelHeightFt,
        hasWork = run.usesManualFeet || PlanExtent.hasSomethingToDraw(run),
        measurable = !TakeoffRefresher.blockedByUncalibratedPhoto(job, run),
    )

    /**
     * Projects a stored line into the price-free shape the sheet works in.
     *
     * This is the one place money is dropped, and it drops it by NOT COPYING
     * rather than by zeroing: [PullSheetSourceLine] has no `unitPrice`,
     * `supplierUnitPrice` or `lineTotal` field, so there is nothing to forget
     * to clear. [EstimateLineItem.effectiveUnitPrice] and
     * [EstimateLineItem.lineTotal] are never called on this path.
     */
    private fun toSourceLine(item: EstimateLineItem): PullSheetSourceLine? {
        if (item.description.isBlank()) return null
        return PullSheetSourceLine(
            runId = item.fenceRunId,
            role = item.role,
            product = item.description,
            quantity = item.quantity,
            unit = item.unit,
            isAutoGenerated = item.isAutoGenerated,
        )
    }

    /** Runs the drawing should show: fence to build, never the fence coming out. */
    fun drawableRuns(all: List<FenceRun>): List<FenceRun> =
        all.filter { !it.isTeardown && PlanExtent.hasSomethingToDraw(it) }
}

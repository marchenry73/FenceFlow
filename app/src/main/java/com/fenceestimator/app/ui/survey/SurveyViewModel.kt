package com.fenceestimator.app.ui.survey

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.FieldChange
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.Repository
import com.fenceestimator.app.data.SiteMarker
import com.fenceestimator.app.data.SiteMarkerKind
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.geometry.GateMarker
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

enum class SurveyMode { DRAW, CALIBRATE, GATE, MARKER, ADJUST, PAN }

class SurveyViewModel(private val repository: Repository, private val jobId: Long) : ViewModel() {
    val job: StateFlow<Job?> = repository.observeJob(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), null)

    val runs: StateFlow<List<FenceRun>> = repository.observeFenceRuns(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    private val _selectedRunId = MutableStateFlow<Long?>(null)
    val selectedRunId: StateFlow<Long?> = _selectedRunId

    fun selectRun(id: Long) {
        _selectedRunId.value = id
    }

    fun ensureSelection() {
        if (_selectedRunId.value == null || runs.value.none { it.id == _selectedRunId.value }) {
            _selectedRunId.value = runs.value.firstOrNull()?.id
        }
    }

    private val _mode = MutableStateFlow(SurveyMode.DRAW)
    val mode: StateFlow<SurveyMode> = _mode

    private val _pendingCalibrationPoints = MutableStateFlow<List<FencePoint>>(emptyList())
    val pendingCalibrationPoints: StateFlow<List<FencePoint>> = _pendingCalibrationPoints

    fun setMode(m: SurveyMode) {
        _mode.value = m
        _pendingCalibrationPoints.value = emptyList()
    }

    fun importImage(context: Context, uri: Uri) {
        viewModelScope.launch {
            val savedPath = withContext(Dispatchers.IO) {
                val dir = File(context.filesDir, "surveys").apply { mkdirs() }
                val outFile = File(dir, "survey_${jobId}_${UUID.randomUUID()}.jpg")
                context.contentResolver.openInputStream(uri)?.use { input ->
                    FileOutputStream(outFile).use { output -> input.copyTo(output) }
                }
                outFile.absolutePath
            }
            val current = job.value ?: repository.getJob(jobId) ?: return@launch
            repository.updateJob(
                current.copy(
                    surveyImagePath = savedPath,
                    calibrationPixelsPerFoot = null,
                    calibrationKnownFeet = null
                )
            )
        }
    }

    private fun selectedRun(): FenceRun? = runs.value.firstOrNull { it.id == _selectedRunId.value }

    fun addDrawPoint(point: FencePoint) {
        val run = selectedRun() ?: return
        val points = FenceCodec.decodePoints(run.pointsEncoded).toMutableList()
        points.add(point)
        persistPoints(run, points)
    }

    /** Moves a single already-placed vertex -- for fixing a point without redrawing the whole run. */
    fun movePoint(index: Int, point: FencePoint) {
        val run = selectedRun() ?: return
        val points = FenceCodec.decodePoints(run.pointsEncoded).toMutableList()
        if (index !in points.indices) return
        points[index] = point
        persistPoints(run, points)
    }

    fun undoLastPoint() {
        val run = selectedRun() ?: return
        val points = FenceCodec.decodePoints(run.pointsEncoded).toMutableList()
        if (points.isNotEmpty()) points.removeAt(points.size - 1)
        persistPoints(run, points)
    }

    fun clearPoints() {
        val run = selectedRun() ?: return
        viewModelScope.launch { repository.updateFenceRun(run.copy(pointsEncoded = "", gatesEncoded = "")) }
    }

    fun toggleClosedLoop(closed: Boolean) {
        val run = selectedRun() ?: return
        viewModelScope.launch { repository.updateFenceRun(run.copy(closedLoop = closed)) }
    }

    /**
     * Who is editing, so a change made in the field can be attributed. Null on
     * an owner's own phone, where there is nobody to report to.
     */
    var editorName: String? = null
    var editorRole: String? = null

    private fun persistPoints(run: FenceRun, points: List<FencePoint>) {
        viewModelScope.launch {
            val before = measure(run, FenceCodec.decodePoints(run.pointsEncoded))
            repository.updateFenceRun(run.copy(pointsEncoded = FenceCodec.encodePoints(points)))
            val after = measure(run, points)
            noteFootageChange(run, before, after)
        }
    }

    private fun measure(run: FenceRun, points: List<FencePoint>): Float {
        if (points.size < 2) return 0f
        val pxPerFt = job.value?.calibrationPixelsPerFoot ?: PIXELS_PER_FOOT_GRID
        return FenceGeometryEngine.analyze(points, pxPerFt, run.closedLoop).totalLinearFeet
    }

    /**
     * Records a footage change so the office sees it.
     *
     * Only worth logging when the length actually moved by something that
     * changes an order -- a foot of drift while nudging a corner is noise, and
     * a log full of noise is a log nobody reads. Footage drives the estimate,
     * the post count and the material order, so a real change the office never
     * hears about is a job that stops matching what the customer agreed to pay.
     */
    private suspend fun noteFootageChange(run: FenceRun, before: Float, after: Float) {
        val name = editorName ?: return
        if (kotlin.math.abs(after - before) < MIN_REPORTABLE_FEET) return

        repository.recordFieldChange(
            FieldChange(
                jobId = jobId,
                summary = "${run.label.ifBlank { "Fence run" }}: " +
                    "${"%.0f".format(before)} ft → ${"%.0f".format(after)} ft",
                detail = if (after > before)
                    "Longer than planned — the estimate and material order may need redoing."
                else
                    "Shorter than planned — there may be material left over.",
                changedBy = name,
                changedByRole = editorRole.orEmpty()
            )
        )
    }

    fun tapCalibrationPoint(point: FencePoint, onNeedDistance: (FencePoint, FencePoint) -> Unit) {
        val pts = _pendingCalibrationPoints.value + point
        if (pts.size < 2) {
            _pendingCalibrationPoints.value = pts
        } else {
            _pendingCalibrationPoints.value = emptyList()
            onNeedDistance(pts[0], pts[1])
        }
    }

    fun applyCalibration(p1: FencePoint, p2: FencePoint, knownFeet: Float) {
        val current = job.value ?: return
        val distPx = kotlin.math.hypot((p2.x - p1.x).toDouble(), (p2.y - p1.y).toDouble()).toFloat()
        if (distPx <= 0f || knownFeet <= 0f) return
        val pxPerFt = distPx / knownFeet
        viewModelScope.launch {
            repository.updateJob(current.copy(calibrationPixelsPerFoot = pxPerFt, calibrationKnownFeet = knownFeet))
        }
    }

    val siteMarkers: StateFlow<List<SiteMarker>> = repository.observeSiteMarkers(jobId)
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun addSiteMarker(kind: SiteMarkerKind, x: Float, y: Float, label: String) {
        viewModelScope.launch {
            repository.addSiteMarker(SiteMarker(jobId = jobId, kind = kind, x = x, y = y, label = label))
        }
    }

    fun deleteSiteMarker(marker: SiteMarker) {
        viewModelScope.launch { repository.deleteSiteMarker(marker) }
    }

    /** Places a gate at an exact point -- it does not need to sit on the drawn fence line. */
    fun addGate(x: Float, y: Float, widthFt: Float) {
        val run = selectedRun() ?: return
        val gates = FenceCodec.decodeGates(run.gatesEncoded).toMutableList()
        gates.add(GateMarker(x, y, widthFt))
        viewModelScope.launch {
            repository.updateFenceRun(run.copy(gatesEncoded = FenceCodec.encodeGates(gates)))
        }
    }

    /**
     * Moves an already-placed gate. Previously a gate in the wrong spot had to
     * be deleted and re-added, which loses its width and is a poor trade for
     * something you nudge a few feet.
     */
    fun moveGate(index: Int, x: Float, y: Float) {
        val run = selectedRun() ?: return
        val gates = FenceCodec.decodeGates(run.gatesEncoded).toMutableList()
        if (index !in gates.indices) return
        gates[index] = gates[index].copy(x = x, y = y)
        viewModelScope.launch {
            repository.updateFenceRun(run.copy(gatesEncoded = FenceCodec.encodeGates(gates)))
        }
    }

    /** Moves a site marker, for the same reason gates can be moved. */
    fun moveSiteMarker(marker: SiteMarker, x: Float, y: Float) {
        viewModelScope.launch {
            repository.updateSiteMarker(marker.copy(x = x, y = y))
        }
    }

    fun removeGate(gate: GateMarker) {
        val run = selectedRun() ?: return
        val gates = FenceCodec.decodeGates(run.gatesEncoded).toMutableList()
        gates.remove(gate)
        viewModelScope.launch {
            repository.updateFenceRun(run.copy(gatesEncoded = FenceCodec.encodeGates(gates)))
        }
    }

    /**
     * With no survey photo, drawing happens on a fixed-scale virtual grid
     * instead -- so the scale is known automatically and there's no
     * tap-two-points calibration step. The calibration is a fixed constant
     * ([PIXELS_PER_FOOT_GRID]), set once and never touched again by display
     * changes -- so changing how the grid *looks* (gridline spacing, zoom)
     * can never silently rescale a line you already drew.
     */
    fun ensureGridCalibration() {
        val current = job.value ?: return
        if (current.surveyImagePath != null) return
        // Only seed a scale when there isn't one. This used to force the grid
        // default back on every visit, which silently threw away any scale the
        // user set by hand -- so calibrating on the grid never stuck.
        if (current.calibrationPixelsPerFoot == null) {
            viewModelScope.launch {
                repository.updateJob(current.copy(calibrationPixelsPerFoot = PIXELS_PER_FOOT_GRID, calibrationKnownFeet = null))
            }
        }
    }

    /** Puts the no-photo grid back on its default scale after a hand calibration. */
    fun resetGridCalibration() {
        val current = job.value ?: return
        viewModelScope.launch {
            repository.updateJob(
                current.copy(calibrationPixelsPerFoot = PIXELS_PER_FOOT_GRID, calibrationKnownFeet = null)
            )
        }
    }

    /** Purely a display setting (how far apart gridlines are drawn) -- never affects calibration or existing points. */
    fun setGridLineSpacingFt(feet: Float) {
        val current = job.value ?: return
        viewModelScope.launch {
            repository.updateJob(current.copy(gridFeetPerSquare = feet.coerceAtLeast(0.5f)))
        }
    }

    /** Switches a run back to photo mode by clearing the survey image (drawing starts over). */
    fun clearSurveyImage() {
        val current = job.value ?: return
        viewModelScope.launch {
            repository.updateJob(current.copy(surveyImagePath = null, calibrationPixelsPerFoot = null, calibrationKnownFeet = null))
        }
    }

    companion object {
        /** Fixed virtual-units-per-foot for the no-photo grid canvas. Never changes once set, so
         *  display/zoom changes can't retroactively alter the real-world size of drawn lines. */
        const val PIXELS_PER_FOOT_GRID = 20f
        /** Virtual canvas size (width == height) used when there's no survey photo -- 400ft x 400ft of drawable area. */
        const val GRID_CANVAS_SIZE = 8000
        /** Below this, a footage change is someone nudging a corner, not a real change. */
        const val MIN_REPORTABLE_FEET = 3f
    }
}

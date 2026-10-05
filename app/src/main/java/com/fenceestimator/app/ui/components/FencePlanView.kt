package com.fenceestimator.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.fenceestimator.app.R
import com.fenceestimator.app.data.FenceRun
import com.fenceestimator.app.data.Job
import com.fenceestimator.app.data.SiteMarker
import com.fenceestimator.app.estimate.DrawingScale
import com.fenceestimator.app.estimate.PlanExtent
import com.fenceestimator.app.geometry.FenceCodec
import com.fenceestimator.app.geometry.FenceGeometryEngine
import com.fenceestimator.app.geometry.FencePoint
import com.fenceestimator.app.ui.survey.SurveyViewModel
import com.fenceestimator.app.ui.theme.PlanColors
import com.fenceestimator.app.ui.theme.Radius
import com.fenceestimator.app.ui.theme.Space

/**
 * THE drawing, once.
 *
 * Moved here verbatim from [com.fenceestimator.app.ui.crew.CrewFencePlanScreen],
 * which had it as a private composable, because a second screen now needs the
 * same picture and a fence drawn two ways is a fence drawn wrong one of those
 * ways. Nothing about the geometry, the scale, the grid, the colours or the
 * order things are drawn in changed in the move -- the only addition is
 * [labelLengthsForRunIds], and it is empty by default so the crew plan screen
 * renders exactly what it rendered before.
 *
 * Every comment below came with the code and is kept because each one records
 * a bug: the gate-only run that drew nothing, the flat 20-units-per-foot
 * fallback that drew the grid at the wrong spacing, the straight run whose zero
 * span divided the scale to infinity.
 *
 * @param labelLengthsForRunIds writes each side's length in feet, for THESE
 *   runs only. The pull sheet asks for it because the owner asked for it in as
 *   many words -- "it would show the grid and the drawing ... and how many post
 *   there needs" -- and somebody buying for a shape needs the shape's
 *   dimensions. Per run, and not a boolean, because a printed dimension is a
 *   number somebody can buy panels against: it was a boolean for one afternoon,
 *   and in that form it labelled the sides of a run with no takeoff on it at
 *   all. Two gates gate it, and this is only the second: a length is written
 *   when the run is named here AND the drawing has a real scale (below). With
 *   no scale nothing is labelled no matter what is passed, because the
 *   20-units-per-foot fallback is a layout default and not a measurement.
 */
@Composable
fun FencePlanCanvas(
    job: Job,
    runs: List<FenceRun>,
    markers: List<SiteMarker>,
    labelLengthsForRunIds: Set<Long> = emptySet(),
    modifier: Modifier = Modifier,
) {
    val measurer = rememberTextMeasurer()
    Card(modifier.fillMaxWidth()) {
        Box(
            Modifier.fillMaxWidth().aspectRatio(1.1f)
                .padding(Space.md)
                .clip(RoundedCornerShape(Radius.sm))
                // White, like the drawing surface the plan was made on, so the
                // crew are looking at the same picture rather than a recoloured
                // version of it.
                .background(Color.White)
        ) {
            // The drawing's scale, the one the drawing screen measures at
            // (DrawingScale.of) -- what turns a gate's width in feet into a
            // width on the plan.
            val drawingScale = DrawingScale.of(job)
            // A gate with no fence line under it, laid level at its real width
            // where it was placed, exactly as the drawing screen lays it. Per
            // run, so each is drawn in its run's turn below.
            val standaloneByRun = runs.map { PlanExtent.standaloneGateSpans(listOf(it), drawingScale) }
            // Fitted to the fence lines, as it always was, and to both posts
            // of every gate standing on its own. With no scale (a photo nobody
            // has calibrated) such a gate has no width to draw, so its marker
            // alone is fitted and drawn.
            val allPoints = runs.flatMap { run ->
                val points = FenceCodec.decodePoints(run.pointsEncoded)
                if (points.size >= 2) points
                else FenceCodec.decodeGates(run.gatesEncoded).map { FencePoint(it.x, it.y) }
            } + standaloneByRun.flatten().flatMap { (_, span) -> listOf(span.start, span.end) }
            if (allPoints.isEmpty()) return@Box

            val minX = allPoints.minOf { it.x }
            val maxX = allPoints.maxOf { it.x }
            val minY = allPoints.minOf { it.y }
            val maxY = allPoints.maxOf { it.y }
            // Guard against a perfectly straight run, where one span is zero and
            // would divide the scale to infinity.
            val spanX = (maxX - minX).coerceAtLeast(1f)
            val spanY = (maxY - minY).coerceAtLeast(1f)
            // The drawing's real scale, or null when nobody has calibrated the
            // survey photo. Kept SEPARATE from the layout fallback below, and
            // that separation is the point: the fallback is fine for drawing a
            // shape and the grid, and is a guess as a measurement.
            val measuredPxPerFoot = SurveyViewModel.drawingScale(job)
            val pxPerFoot = measuredPxPerFoot ?: SurveyViewModel.PIXELS_PER_FOOT_GRID
            // No scale, no dimensions, whatever the caller asked for. A caller
            // that forgets the check cannot print a guessed length through here.
            val labelledRunIds = if (measuredPxPerFoot == null) emptySet() else labelLengthsForRunIds

            Canvas(Modifier.fillMaxSize()) {
                val pad = 32f
                val usableW = (size.width - pad * 2).coerceAtLeast(1f)
                val usableH = (size.height - pad * 2).coerceAtLeast(1f)
                val scale = minOf(usableW / spanX, usableH / spanY)

                // Centre whatever is left over, so the plan sits in the middle
                // instead of hugging a corner.
                val offsetX = pad + (usableW - spanX * scale) / 2f
                val offsetY = pad + (usableH - spanY * scale) / 2f

                fun place(p: FencePoint) = Offset(
                    offsetX + (p.x - minX) * scale,
                    offsetY + (p.y - minY) * scale
                )

                // The same grid the plan was drawn on.
                //
                // Without it the crew were reading a bare outline while the
                // office was looking at a scaled drawing -- the same fence, but
                // no shared way to say "about two squares past the corner".
                // Spacing comes from the job so both views agree on what a
                // square means.
                val feetPerSquare = job.gridFeetPerSquare.coerceAtLeast(0.5f)
                // The scale the drawing screen draws at (SurveyViewModel.drawingScale),
                // so a square here is the square the office drew on. The raw
                // calibration fell back to a flat 20 units per foot, which on
                // an uncalibrated grid of any other size drew the squares at
                // the wrong spacing.
                val squarePx = feetPerSquare * pxPerFoot * scale
                if (squarePx > 6f) {
                    var gx = offsetX
                    while (gx <= size.width) {
                        drawLine(PlanColors.grid, Offset(gx, 0f), Offset(gx, size.height), strokeWidth = 1f)
                        gx += squarePx
                    }
                    var gy = offsetY
                    while (gy <= size.height) {
                        drawLine(PlanColors.grid, Offset(0f, gy), Offset(size.width, gy), strokeWidth = 1f)
                        gy += squarePx
                    }
                }

                runs.forEachIndexed { runIndex, run ->
                    val points = FenceCodec.decodePoints(run.pointsEncoded)

                    if (points.size >= 2) {
                        // Teardown reads differently from a run being built, the
                        // same as it does on the drawing screen -- the crew needs
                        // to tell "pull this out" from "build this" from the plan
                        // itself, not by asking.
                        val lineColor = if (run.isTeardown) PlanColors.teardownLine else PlanColors.fenceLine
                        val count = if (run.closedLoop) points.size else points.size - 1
                        for (i in 0 until count) {
                            drawLine(
                                color = lineColor,
                                start = place(points[i]),
                                end = place(points[(i + 1) % points.size]),
                                strokeWidth = 6f
                            )
                        }
                        // Every vertex is a post the crew has to set, so mark them.
                        points.forEach { drawCircle(lineColor, radius = 9f, center = place(it)) }

                        if (measuredPxPerFoot != null && run.id in labelledRunIds) {
                            // Lengths from the SAME geometry the takeoff is
                            // measured with (FenceGeometryEngine.analyze), at
                            // the drawing's CALIBRATED scale -- never the
                            // layout fallback, which is why measuredPxPerFoot
                            // is used here and pxPerFoot is not. A second way
                            // of measuring a side is a second answer.
                            //
                            // WHAT A LABEL HERE GUARANTEES, exactly, because
                            // this comment used to claim more than the code
                            // delivered. It guarantees two things: the number
                            // is this run's real measured length, because a
                            // null calibration empties labelledRunIds above;
                            // and this run contributed the takeoff lines it is
                            // drawn beside, because the only caller that fills
                            // this set fills it from the runs whose lines are
                            // on the sheet (PullSheetState.Ready.runIdsOnSheet).
                            // It does NOT guarantee that the takeoff is
                            // current -- a stale engine version is a different
                            // problem, warned about separately and loudly on
                            // the page itself (PullSheetTakeoffAge).
                            val geometry =
                                FenceGeometryEngine.analyze(points, measuredPxPerFoot, run.closedLoop)
                            geometry.segments.forEach { segment ->
                                val a = place(points[segment.fromIndex])
                                val b = place(points[segment.toIndex])
                                drawSegmentLabel(measurer, a, b, segment.lengthFt)
                            }
                        }
                    }

                    // A gate standing on its own: the opening at its real
                    // width and the two posts it hangs between, which are what
                    // the crew sets in concrete. Under the gate's own marker,
                    // drawn next, so it reads as the same gate as every other.
                    standaloneByRun[runIndex].forEach { (_, span) ->
                        val from = place(span.start)
                        val to = place(span.end)
                        drawLine(PlanColors.gate, from, to, strokeWidth = 6f)
                        drawCircle(PlanColors.gate, radius = 9f, center = from)
                        drawCircle(PlanColors.gate, radius = 9f, center = to)
                    }

                    FenceCodec.decodeGates(run.gatesEncoded).forEach { gate ->
                        val at = place(FencePoint(gate.x, gate.y))
                        drawCircle(PlanColors.gate, radius = 16f, center = at)
                        drawCircle(Color.White, radius = 16f, center = at, style = Stroke(width = 4f))
                    }
                }

                markers.forEach { marker ->
                    val at = place(FencePoint(marker.x, marker.y))
                    val colour = PlanColors.marker(marker.kind)

                    // A HOUSE IS A BOX HERE TOO.
                    //
                    // A marker with a width and a depth is a box, and this view
                    // drew every one of them as a 13px dot. SurveyDrawScreen was
                    // the only place in the app that read widthFt/heightFt, so a
                    // house measured at 40 by 30 and turned to the road showed
                    // its real footprint to the person who drew it and a dot to
                    // the CREW building from this plan -- and to the customer,
                    // since this is the plan that goes out.
                    //
                    // Feet times pxPerFoot times the fit scale is the same
                    // conversion squarePx uses above, so the box lands on the
                    // grid squares it was drawn against rather than near them.
                    val wFt = marker.widthFt
                    val hFt = marker.heightFt
                    if (wFt > 0f && hFt > 0f) {
                        val halfW = wFt * pxPerFoot * scale / 2f
                        val halfH = hFt * pxPerFoot * scale / 2f
                        rotate(degrees = marker.rotationDeg, pivot = at) {
                            drawRect(
                                color = colour.copy(alpha = 0.16f),
                                topLeft = Offset(at.x - halfW, at.y - halfH),
                                size = Size(halfW * 2, halfH * 2),
                            )
                            drawRect(
                                color = colour,
                                topLeft = Offset(at.x - halfW, at.y - halfH),
                                size = Size(halfW * 2, halfH * 2),
                                style = Stroke(width = 2.5f),
                            )
                        }
                    }

                    // The dot stays whether or not there is a box around it: it
                    // is what the legend's colour refers to, and on a plan with
                    // a big house it is the only thing marking the exact spot.
                    drawCircle(colour, radius = 13f, center = at)
                    drawCircle(Color.White, radius = 13f, center = at, style = Stroke(width = 3f))
                }
            }
        }
    }
}

/**
 * One side's length, written beside the middle of that side.
 *
 * A zero-length side gets no label: two corners dropped on the same spot
 * happen while drawing, and "0 ft" beside a dot is noise, not information.
 *
 * The number is rounded to whole feet, which is how the rest of the app states
 * a run's length (the plan screen's length row does the same). It is NOT the
 * figure anything is priced from -- that is the takeoff -- so the rounding
 * cannot move money.
 */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawSegmentLabel(
    measurer: TextMeasurer,
    a: Offset,
    b: Offset,
    lengthFt: Float,
) {
    if (lengthFt < 0.5f) return
    val text = "${Math.round(lengthFt)} ft"
    val layout = measurer.measure(
        text = text,
        style = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = PlanColors.fenceLine),
    )
    val midX = (a.x + b.x) / 2f
    val midY = (a.y + b.y) / 2f
    // Offset off the line rather than on it, so the label does not sit under
    // the 6px stroke it describes.
    val topLeft = Offset(
        (midX - layout.size.width / 2f).coerceIn(0f, (size.width - layout.size.width).coerceAtLeast(0f)),
        (midY - layout.size.height - 4f).coerceIn(0f, (size.height - layout.size.height).coerceAtLeast(0f)),
    )
    // A white plate under the text: the grid runs behind every label, and dark
    // text on a grid line is the one thing on this drawing nobody could read.
    drawRect(
        color = Color.White.copy(alpha = 0.85f),
        topLeft = Offset(topLeft.x - 2f, topLeft.y - 1f),
        size = androidx.compose.ui.geometry.Size(
            layout.size.width + 4f,
            layout.size.height + 2f,
        ),
    )
    drawText(layout, topLeft = topLeft)
}

/**
 * What the colours on [FencePlanCanvas] mean, for exactly what is on this job.
 *
 * Moved here with the canvas, unchanged. Site markers used to share one generic
 * amber dot regardless of kind, so this said "Watch out" and left the crew to
 * work out what from the canvas alone. The canvas now draws a pool, a tree and
 * a utility line in three different colours -- the same three the office sees
 * while drawing -- so the legend has to say which is which or it stops
 * explaining what it is next to.
 */
@Composable
fun FencePlanLegend(runs: List<FenceRun>, markers: List<SiteMarker>) {
    // Only runs with a line put a line on the plan; a gate-only run is here
    // for its gate, which the gate dot already explains. On such a job that
    // dot IS the plan's explanation, so its label is translated like every
    // other one here -- it was the last English word left on a Spanish or
    // French crew phone's plan.
    val lined = remember(runs) { runs.filter { FenceCodec.decodePoints(it.pointsEncoded).size >= 2 } }
    val hasBuildLine = remember(lined) { lined.any { !it.isTeardown } }
    val hasTeardownLine = remember(lined) { lined.any { it.isTeardown } }
    val presentMarkerKinds = remember(markers) { markers.map { it.kind }.distinct() }

    Column(verticalArrangement = Arrangement.spacedBy(Space.xs)) {
        Row(horizontalArrangement = Arrangement.spacedBy(Space.lg)) {
            if (hasBuildLine) FencePlanLegendDot(PlanColors.fenceLine, stringResource(R.string.crew_plan_legend_build))
            if (hasTeardownLine) FencePlanLegendDot(PlanColors.teardownLine, stringResource(R.string.crew_plan_legend_teardown))
            FencePlanLegendDot(PlanColors.gate, stringResource(R.string.crew_plan_legend_gate))
        }
        // Two per row rather than one long row, so this stays legible on a
        // 360dp phone even on a job with several kinds of marker on it.
        presentMarkerKinds.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(Space.lg)) {
                pair.forEach { kind -> FencePlanLegendDot(PlanColors.marker(kind), kind.label()) }
            }
        }
    }
}

@Composable
private fun FencePlanLegendDot(color: Color, label: String) {
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Box(
            Modifier.padding(end = 6.dp)
                .size(12.dp)
                .clip(RoundedCornerShape(50))
                .background(color)
        )
        Text(label, style = MaterialTheme.typography.bodySmall)
    }
}

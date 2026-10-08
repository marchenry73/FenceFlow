package com.fenceestimator.app.geometry

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/**
 * WHETHER A TAP GRABBED A SITE MARKER, AND HOW GOOD A TARGET IT WAS.
 *
 * A site marker used to be a dot, so one radius around its stored point was
 * the whole story. Then a house, pool or driveway gained a SIZE and started
 * drawing as a box -- and the hit test did not change. It still measured to
 * the box's CENTRE with a 40 px reach, so pressing the body or the edge of a
 * large house grabbed nothing at all. Worse, a drag that grabbed nothing is
 * discarded in silence: there is no else branch, so the house simply did not
 * move and nothing said why.
 *
 * That is one of the things "the house marker keeps reverting" can mean, and
 * it is the one that needs no network: the marker never moved, so there was
 * nothing to revert.
 *
 * Pure, and in the geometry package rather than the drawing screen, because
 * this project's bugs have consistently been in the half that cannot be
 * tested off a phone.
 *
 * EVERYTHING IS IN CANVAS PIXELS. The caller has already applied the view
 * transform, so this does not need to know about scale, pan or the grid --
 * which also means a zoom cannot change whether a press lands inside a box
 * that is drawn around it.
 *
 * @param halfW half the box's width; 0 for a marker with no size
 * @param halfH half the box's height; 0 for a marker with no size
 * @param rotationDeg the box's own rotation, clockwise, about its centre --
 *   a house is almost never square to the road
 * @param slopPx extra reach outside the shape, so the edge of a box is
 *   grabbable rather than being a one-pixel target
 * @return distance from the marker's centre when the tap counts as a grab,
 *   or null when it misses. A distance rather than a boolean so that two
 *   overlapping markers still resolve to the nearer centre, exactly as the
 *   old nearest-point test did.
 */
fun markerGrabDistance(
    cx: Float,
    cy: Float,
    halfW: Float,
    halfH: Float,
    rotationDeg: Float,
    tapX: Float,
    tapY: Float,
    slopPx: Float,
): Float? {
    val dx = tapX - cx
    val dy = tapY - cy
    val centreDistance = hypot(dx.toDouble(), dy.toDouble()).toFloat()

    // No size: the old behaviour exactly, a circle of slopPx about the point.
    if (halfW <= 0f || halfH <= 0f) {
        return if (centreDistance <= slopPx) centreDistance else null
    }

    // Into the box's own frame. The box is DRAWN by rotating the canvas by
    // +rotationDeg about the centre, so the tap comes back by -rotationDeg.
    val rad = Math.toRadians(-rotationDeg.toDouble())
    val c = cos(rad).toFloat()
    val s = sin(rad).toFloat()
    val localX = dx * c - dy * s
    val localY = dx * s + dy * c

    val inside = abs(localX) <= halfW + slopPx && abs(localY) <= halfH + slopPx
    return if (inside) centreDistance else null
}

/**
 * The reach outside a marker's own shape, in screen pixels.
 *
 * Deliberately the same number as a vertex's reach rather than a new one: a
 * press near the edge of a house and a press near a corner of the fence are
 * the same gesture with the same finger, and two different slops would make
 * one of them feel broken.
 */
const val MARKER_GRAB_SLOP_PX = 40f

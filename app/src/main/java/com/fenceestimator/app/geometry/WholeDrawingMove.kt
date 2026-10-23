package com.fenceestimator.app.geometry

/**
 * MOVING THE WHOLE DRAWING -- every side, every gate, every marker -- at once.
 *
 * HIS WORDS: "I need to be able to move the entire fence and everything
 * connected to wherever I want on the drawing."
 *
 * WHY IT IS A DIFFERENT THING FROM MOVE VIEW. Panning changes where the
 * drawing is LOOKED AT from; the stored coordinates do not move, so nothing
 * lines up any differently against the survey photo or the satellite tile
 * underneath. This moves the drawing ITSELF, which is what is wanted when the
 * whole fence was traced ten feet off the property line, or when the photo was
 * fitted afterwards and everything needs to slide across to meet it.
 *
 * WHY IT CANNOT CHANGE A PRICE, and this is the point of putting it here:
 * a translation adds the same (dx, dy) to every coordinate, so every distance
 * between any two of them is unchanged. Side lengths, the total footage, the
 * post count, the gate spans, which side a gate sits on, the angle at a corner
 * -- all are differences of coordinates, and a constant added to both ends of
 * a difference cancels. So the takeoff and the quote are bit-identical after a
 * move. [movedBy] is deliberately the ONLY arithmetic, used for points, gates
 * and markers alike, so there is one place where that could stop being true.
 *
 * ALL OR NOTHING. [plan] returns null rather than a partial answer when any
 * coordinate would come out non-finite. A half-applied move is far worse than
 * a refused one: the sides that moved and the sides that did not are now in
 * different places, the joints between them are nonsense, and there is nothing
 * on screen that says which half happened.
 *
 * Pure, so every arm of it is driven off-device.
 */
object WholeDrawingMove {

    /** One coordinate, moved. The only arithmetic in a whole-drawing move. */
    fun movedBy(x: Float, y: Float, dx: Float, dy: Float): FencePoint =
        FencePoint(x + dx, y + dy)

    /** A finite offset that actually goes somewhere. A zero move is not a move. */
    fun isUsableOffset(dx: Float, dy: Float): Boolean =
        dx.isFinite() && dy.isFinite() && !(dx == 0f && dy == 0f)

    /**
     * Everything one run contributes to a move: its points and its gates,
     * already shifted.
     */
    data class RunShift(
        val points: List<FencePoint>,
        val gates: List<GateMarker>
    )

    /**
     * What a move does to the drawing, or null if it must not be made.
     *
     * [runs] is every run of the job -- points and gates, in order -- and
     * [markers] every site marker's (x, y). The answer is in the same order,
     * so the caller pairs each shift back with the row it came from.
     *
     * Null for an unusable offset ([isUsableOffset]) and null if any shifted
     * coordinate is not finite: a drawing whose coordinates have grown to the
     * edge of what a Float holds would silently become NaN, and a NaN
     * coordinate prices the whole fence at nothing.
     */
    data class Plan(
        val runs: List<RunShift>,
        val markers: List<FencePoint>
    )

    fun plan(
        runs: List<RunShift>,
        markers: List<FencePoint>,
        dx: Float,
        dy: Float
    ): Plan? {
        if (!isUsableOffset(dx, dy)) return null
        val movedRuns = runs.map { run ->
            RunShift(
                points = run.points.map { movedBy(it.x, it.y, dx, dy) },
                gates = run.gates.map { g ->
                    val p = movedBy(g.x, g.y, dx, dy)
                    g.copy(x = p.x, y = p.y)
                }
            )
        }
        val movedMarkers = markers.map { movedBy(it.x, it.y, dx, dy) }
        val everyCoordinate = movedRuns.asSequence().flatMap { run ->
            run.points.asSequence() + run.gates.asSequence().map { FencePoint(it.x, it.y) }
        } + movedMarkers.asSequence()
        if (everyCoordinate.any { !it.x.isFinite() || !it.y.isFinite() }) return null
        return Plan(movedRuns, movedMarkers)
    }

    /**
     * The move that puts a [plan]'s move back: the same offset, negated. No
     * snapshot of the old drawing has to be kept anywhere.
     *
     * NOT BIT-EXACT, and the reason is worth stating because the first version
     * of this file claimed it was. `(x + d) - d` is not `x` in floating point:
     * the sum is rounded to the nearest representable float, and subtracting
     * the same amount back cannot always recover what the rounding discarded.
     * A corner at 100.0 moved by 123.456 and put back lands on 99.99999 --
     * caught by [WholeDrawingMoveTest], asserting the exactness that had been
     * asserted in words here.
     *
     * The error is one rounding step of a float, which on this drawing is
     * about a ten-thousandth of an inch, and it cannot accumulate into
     * anything: each round trip adds at most another step. Every number
     * anybody is shown or billed is rounded far above it -- a side's length to
     * the foot, a panel count to the bay -- so a put-back returns the drawing
     * to where it was for every purpose the drawing has. It is simply not the
     * same thing as "identical", and a comment that says "exact" invites
     * somebody to write an equality check against it.
     *
     * Negating a float zero gives negative zero, and `-0.0f == 0.0f` is true,
     * so a put-back along one axis only is still accepted by [isUsableOffset]
     * -- it refuses only when BOTH components are zero, which is a case [plan]
     * has already refused.
     */
    fun putBack(dx: Float, dy: Float): Pair<Float, Float> = -dx to -dy
}

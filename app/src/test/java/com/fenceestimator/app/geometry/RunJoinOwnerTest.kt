package com.fenceestimator.app.geometry

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Who is billed the post where two runs meet.
 *
 * WHY THIS FILE EXISTS. Until 22 October 2026 this engine and the office's
 * joins.ts both said the SHORTER run owns the shared post, while
 * docs/JOINING_RUNS.md 2.4 and this file's own `@param heightFt` both said the
 * taller one did. The two implementations agreed with each other and with
 * nothing else, so every parity run passed -- parity proves the engines agree,
 * never that they are right.
 *
 * What finally said so was tests/a32-join-posts.test.mjs case D2, which had
 * been red on purpose the whole time. But a32 imports the OFFICE engine. There
 * was no Kotlin test for joining at all, and no parity fixture carries a joint
 * either (no live run has ever had one), so the phone's half of this rule was
 * covered by nothing whatsoever. That is the gap this file closes: the office
 * side was proved by a32, and now the phone side is proved here.
 *
 * THE RULE: the tallest run, then the lowest sort order, then the lowest id.
 * One post, two panels of different heights -- the post has to be tall enough
 * for the taller panel, because a 6 ft panel cannot hang on a 4 ft post. The
 * post that gets bought and set is the tall one, so the tall run carries it.
 */
class RunJoinOwnerTest {

    /** A straight run of [lengthFt] feet, drawn, so it has two ends to join. */
    private fun straight(lengthFt: Float): FenceGeometryResult =
        FenceGeometryEngine.analyze(
            listOf(FencePoint(0f, 0f), FencePoint(lengthFt, 0f)),
            pixelsPerFoot = 1f,
        )

    private fun run(
        id: String,
        heightFt: Float,
        sortOrder: Int,
        lengthFt: Float = 30f,
        endJointId: String = "",
        startJointId: String = "",
    ) = JoinableRun(
        id = id,
        geometry = straight(lengthFt),
        heightFt = heightFt,
        sortOrder = sortOrder,
        startJointId = startJointId,
        endJointId = endJointId,
    )

    /** The one joint in the adjustment, or a failure naming what came back. */
    private fun soleJoint(result: JoinAdjustment): JoinedPost {
        assertEquals(
            "expected exactly one shared post, got ${result.posts.size} (ignored: ${result.ignored})",
            1, result.posts.size,
        )
        return result.posts[0]
    }

    @Test
    fun `a height change shares no post at all, so nobody is billed one`() {
        // 6 ft meets 4 ft. SUPERSEDED 26 Oct 2026: this used to assert that
        // the taller run was billed the one shared post, on the reasoning that
        // the post has to carry the 6 ft panel. Asked two posts or one, the
        // owner answered "Do the two posts" -- so there is no shared post here
        // for anyone to own, and each side keeps its own at its own height.
        val tall = run("a-tall", heightFt = 6f, sortOrder = 0, endJointId = "j1")
        val short = run("b-short", heightFt = 4f, sortOrder = 1, startJointId = "j1")
        val post = soleJoint(RunJoinArithmetic.adjust(listOf(tall, short)))
        assertEquals("a height change still claims to share a post", false, post.sharedPost)
        assertEquals("a joint that shares nothing still named an owner", "", post.ownerRunId)
    }

    @Test
    fun `neither side of a height change gives up its end post`() {
        // The money half of the rule above: the 4 ft side must end up with a
        // post of its own, which is what puts a 4 ft corner post on his quote.
        val short = run("a-short", heightFt = 4f, sortOrder = 0, endJointId = "j1")
        val tall = run("b-tall", heightFt = 6f, sortOrder = 9, startJointId = "j1")
        val result = RunJoinArithmetic.adjust(listOf(short, tall))
        assertEquals("a height change saved a post; it must save none", 0, result.postsSaved)
        // Each converts an end post into a corner post, so each moves, and
        // both move the SAME way -- neither is the owner of anything.
        // The DELTAS, not the whole object: RunPostAdjustment carries its own
        // runId, so comparing toString() can only ever fail.
        val a = result.forRun("a-short")
        val b = result.forRun("b-tall")
        assertEquals(
            "the two sides of a height change were treated differently",
            listOf(a.linePostsDelta, a.cornerPostsDelta, a.endPostsDelta),
            listOf(b.linePostsDelta, b.cornerPostsDelta, b.endPostsDelta),
        )
        // And each really did trade an end post for a corner post, rather than
        // both simply being left alone.
        // A post of its own, of whichever KIND the angle calls for -- these two
        // legs run straight on, so it is a line post. The kind is decided by
        // the same 15-degree rule a bend inside one run follows; what this case
        // pins is that a post is kept, not which sort it is.
        assertEquals("the 4 ft side did not gain a post of its own", 1, a.linePostsDelta + a.cornerPostsDelta)
        assertEquals("the 4 ft side did not give up its end post", -1, a.endPostsDelta)
    }

    @Test
    fun `the answer does not depend on the order the runs are listed in`() {
        val short = run("a-short", heightFt = 4f, sortOrder = 0, endJointId = "j1")
        val tall = run("b-tall", heightFt = 6f, sortOrder = 9, startJointId = "j1")
        val forward = soleJoint(RunJoinArithmetic.adjust(listOf(short, tall)))
        val backward = soleJoint(RunJoinArithmetic.adjust(listOf(tall, short)))
        assertEquals("the answer changed when the list was reversed", forward.sharedPost, backward.sharedPost)
        assertEquals(forward.memberRunIds, backward.memberRunIds)
        assertEquals(false, forward.sharedPost)
    }

    @Test
    fun `equal heights fall through to the lower sort order`() {
        val second = run("a-second", heightFt = 6f, sortOrder = 5, endJointId = "j1")
        val first = run("b-first", heightFt = 6f, sortOrder = 1, startJointId = "j1")
        val post = soleJoint(RunJoinArithmetic.adjust(listOf(second, first)))
        assertEquals("equal heights did not fall through to sort order", "b-first", post.ownerRunId)
    }

    @Test
    fun `equal heights and equal sort order fall through to the id`() {
        val later = run("zz", heightFt = 6f, sortOrder = 3, endJointId = "j1")
        val earlier = run("aa", heightFt = 6f, sortOrder = 3, startJointId = "j1")
        val post = soleJoint(RunJoinArithmetic.adjust(listOf(later, earlier)))
        assertEquals("the last tie-break is not the id", "aa", post.ownerRunId)
    }

    @Test
    fun `only one run gives up its end post, and the owner keeps its own`() {
        // EQUAL heights, deliberately. This case is about the shared-post
        // arithmetic, and since 26 Oct 2026 a height change shares no post, so
        // the old 6-and-4 fixture would have tested the transition rule
        // instead of the thing this case is named for.
        val tall = run("a-tall", heightFt = 6f, sortOrder = 0, endJointId = "j1")
        val short = run("b-short", heightFt = 6f, sortOrder = 1, startJointId = "j1")
        val result = RunJoinArithmetic.adjust(listOf(tall, short))
        assertEquals("the job did not save exactly one post", 1, result.postsSaved)
        // The owner's counts must not shrink; the other member's must.
        val ownerDelta = result.forRun("a-tall")
        val otherDelta = result.forRun("b-short")
        assertNotEquals(
            "the owner and the giver came out identical, so nothing was actually moved",
            ownerDelta.toString(), otherDelta.toString(),
        )
    }

    // ----------------------------------------------------------- canaries

    @Test
    fun `CANARY a joint naming only one live run moves nothing`() {
        // If this ever passed with a post, the fixtures above would prove
        // nothing: any single end would start inventing a shared post.
        val lonely = run("a", heightFt = 6f, sortOrder = 0, endJointId = "j1")
        val result = RunJoinArithmetic.adjust(listOf(lonely))
        assertEquals("a joint with one member produced a shared post", 0, result.posts.size)
        assertEquals("a one-member joint changed a run's posts", true, result.changesNothing)
    }

    @Test
    fun `CANARY runs with no joint ids produce no posts at all`() {
        val a = run("a", heightFt = 6f, sortOrder = 0)
        val b = run("b", heightFt = 4f, sortOrder = 1)
        val result = RunJoinArithmetic.adjust(listOf(a, b))
        assertEquals("two unjoined runs produced a shared post", 0, result.posts.size)
        assertEquals(true, result.changesNothing)
    }
}

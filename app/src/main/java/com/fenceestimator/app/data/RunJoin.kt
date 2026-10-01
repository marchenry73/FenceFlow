package com.fenceestimator.app.data

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

/*
 * JOINED RUN ENDS: where the end of one fence run and the end of another are the
 * same post.
 *
 * STATUS, READ THIS FIRST. This file is storage and a repository API, and nothing
 * more.
 *
 *  - NOT YET REACHED BY THE PRICE. Neither the phone's EstimateEngine nor the
 *    server's pricing takeoff reads a row of this table, so no post count, price
 *    or material list changes because it exists. A job with no joins has no rows
 *    here and prices exactly as it did before. The two places that will have to
 *    read it are the post arithmetic in EstimateEngine (cornerPosts and endPosts
 *    are taken per run from the geometry) and the same step in the pricing
 *    takeoff under supabase/functions/_shared/pricing. Until they do, a join is a
 *    recorded fact that nothing acts on. tests/a33-join-model-storage.test.mjs
 *    fails if any file other than this one, AppDatabase.kt and Repository.kt
 *    starts using this API, so this paragraph cannot go stale unnoticed.
 *  - NOT YET REACHED BY ANY SCREEN. The drawing screen does not call
 *    Repository.joinRunEnds or unjoinRunEnd.
 *  - NOT SYNCED. There is no cloud table, no push and no pull for these rows, and
 *    the table is deliberately NOT in SyncTables.ALL: that list drives the
 *    deletion reaper, which would ask the cloud for a table that does not exist
 *    yet. Until sync lands a join lives on this phone only. It is inside this
 *    phone's backup file, and signing out or wiping the phone loses it without
 *    the unsynced-work warning mentioning it (UnsyncedSummary counts jobs and
 *    files, not these). When sync is built, a free end must travel as the empty
 *    string and never as a null: the phone's JSON drops nulls (explicitNulls is
 *    false in cloudJson), so a null would leave the cloud's old label in place
 *    and an unjoin would never reach the office. The pull maps the empty string
 *    back to null. Locally it has to be null, because the unique index on
 *    (jointId, runId) would refuse two free ends of one run holding the same
 *    empty string.
 *
 * RELATION TO docs/JOINING_RUNS.md. That spec records the same fact as two text
 * columns on fence_runs, start_joint and end_joint, riding the existing run sync.
 * This table holds the same facts as rows: a run's start_joint is the jointId of
 * its START row when that joint is live and the empty string otherwise, and
 * end_joint likewise. Both cannot be the home of a join. Whichever is chosen, the
 * other should be removed while that is still free, which is before any build
 * at schema 48 exists. What separates them: rows here are not rewritten by an
 * edit to the run (no whole-row last-edit-wins clobbering) and the schema refuses
 * the nonsense instead of every reader doing it; the columns design needs no new
 * table, policy or sync step, and a join edit fires the run row's existing
 * triggers (the re-approval fingerprint still has to be taught to read the
 * columns), where nothing at all fires on a join here.
 *
 * WHAT A ROW IS. One row is one END of one run: START is the first point of the
 * run's line, END is the last. A row whose jointId is not null says "this end is
 * at the point named jointId". Every row sharing a jointId is at one post. A
 * jointId held by fewer than two rows is not a join, and every read here treats it
 * as free (the queries say so themselves), so a half-deleted join can never be
 * read as a post. A row whose jointId is null is a free end that was once joined:
 * unjoining writes a null rather than deleting the row, so no user action here
 * ever needs a cloud tombstone.
 *
 * A JOIN IS A FACT THE OWNER CREATES, NEVER READ OFF COORDINATES. Nothing in this
 * table stores a position. Two points at identical coordinates are not joined
 * until somebody joins them, and dragging a point can neither create nor destroy
 * one. The other side of that: a join does not follow a point that is dragged
 * away, or an end that moves because points were added after it. Whoever prices
 * from these rows still has to check that the two ends are where the join says.
 *
 * WHY THE ENDS ARE NAMED START AND END and not by vertex number: a vertex number
 * slides to a different corner the moment a point is inserted or deleted in the
 * middle of the run. The first and last point stay the first and last. Reversing
 * a run swaps its ends, so whatever reverses a run must swap its join rows too;
 * nothing reverses a run today.
 *
 * WHY A LABEL AND NOT A TABLE OF PAIRS. A pair table (run, end, run, end) cannot
 * refuse a join to itself, cannot refuse the same pair stored twice the other way
 * round, and has no way to say three ends meet, unless it carries a CHECK
 * constraint, which Room cannot put on a table it creates for a fresh install
 * (only phones that upgraded would have it). A row per end with a shared label is
 * refused by three unique indexes, which Room does declare, so a fresh install and
 * an upgraded phone refuse exactly the same things:
 *  - the same end twice: unique (runId, atEnd). An end has one row, so one point.
 *  - an end joined to the other end of its own run: unique (jointId, runId). A
 *    run is at a given point once. A run whose line closes on itself is a closed
 *    loop, which the run already has a flag for.
 *  - the same row recorded twice: unique (syncId).
 * Deleting a run deletes its rows: the foreign key on runId cascades, and every way
 * a run is removed (Room's delete, the reaper's raw delete by sync id, a job
 * delete cascading through its runs) is a SQL delete on fence_runs, so all of them
 * cascade. The rows left behind in a joint of three are still a joint; a joint of
 * two that loses a run is a lone end and reads as free.
 *
 * THREE OR MORE RUNS AT ONE POINT. No cap. A run into the middle of a back fence
 * is drawn as the back fence in two runs that meet at that post, plus the side run
 * joined to the same point. The third end simply takes the label the first two
 * share; so does a fourth. What is refused is only: a run joining a point it is
 * already at, and joining two ends that are each already at a DIFFERENT point
 * (that would merge two posts, and is left to the owner to do deliberately by
 * unjoining one end first). A join to the interior of a run is not expressible.
 *
 * WHAT THE SCHEMA CANNOT SAY, and who says it instead. That the two runs belong to
 * the same job is refused by Repository.joinRunEnds (and every read here is per
 * job). That a run is still joinable (not since turned into a closed loop,
 * typed-in footage or a teardown run, which a drawing restore can do to a run that
 * already has joins) is checked when a join is made and must be checked again by
 * whatever prices, every time it prices.
 *
 * CONFLICTS BETWEEN PHONES. This is the shape the future sync inherits, and what
 * the schema itself already guarantees. Each end has one row and one sync id
 * derived from its run's sync id, so two phones touching the same end touch the
 * same cloud row, and last edit wins per end.
 *  - Both phones join the same two sides: each writes both rows with its own
 *    random label, in one transaction with one stamp. A sync that carries the two
 *    rows of a join together leaves both ends on one label whoever wins. If one
 *    ever splits them, both read as free: the old, higher bill, never a post that
 *    is not there.
 *  - One phone joins while another deletes a run: a row cannot exist for a run
 *    that is gone (the foreign key), so the delete takes the rows with it. The
 *    pull must skip rows whose run it cannot find, as it already does for every
 *    other child of a run.
 *  - Two phones put both ends of one run at the same point: the guarded update
 *    (setJoint) refuses the second instead of throwing, so a pull cannot wedge the
 *    sync on a constraint error. The pull must keep its own end as it was.
 * Labels are random on purpose. A label derived from the pair could collide with a
 * label already in use and silently merge two posts, which under-counts posts.
 */

/** Which end of a run's line: START is its first point, END its last. */
enum class RunEnd {
    START, END;

    /** The value stored in [RunJoin.atEnd]. */
    val atEnd: Boolean get() = this == END
}

/**
 * What [Repository.joinRunEnds] did. Only [JOINED] wrote anything.
 */
enum class JoinResult {
    /** The two ends are now at one point. */
    JOINED,
    /** They already were. Nothing was written. */
    ALREADY_JOINED,
    /** Both ends are of one run, or the other end of that run is already at this point. */
    SAME_RUN,
    /** One of the runs is not on this phone. */
    RUN_NOT_FOUND,
    /** The runs belong to different jobs. */
    DIFFERENT_JOBS,
    /** One run is a closed loop: it has no free ends to join. */
    CLOSED_LOOP,
    /** One run is quoted from typed-in footage: it has no drawn line to join. */
    TYPED_FOOTAGE,
    /** One run is the old fence coming out and the other is the new one going in. */
    TEARDOWN_MISMATCH,
    /** Both ends already meet other runs, at different points. Unjoin one first. */
    AT_ANOTHER_POINT
}

/**
 * One end of one fence run, and the point it is at. See the header of this file for
 * what the three unique indexes refuse.
 */
@Entity(
    tableName = "run_joins",
    foreignKeys = [
        ForeignKey(
            entity = FenceRun::class,
            parentColumns = ["id"],
            childColumns = ["runId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [
        Index(value = ["runId", "atEnd"], unique = true),
        Index(value = ["jointId", "runId"], unique = true),
        Index(value = ["syncId"], unique = true)
    ]
)
data class RunJoin(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    /**
     * Derived from the run's sync id and the end by [syncIdFor], so every phone
     * names the same end the same way. Not random, and no default, so nothing can
     * create a row under an id that does not match its run and end.
     */
    val syncId: String,
    /** Local id of the run, as every other child row of a run keeps it. */
    val runId: Long,
    /** False for the run's first point, true for its last. See [RunEnd]. */
    val atEnd: Boolean,
    /** The point this end is at, shared by every end at that point. Null: free. */
    val jointId: String? = null,
    /** This phone's last-edit clock for this end, for the sync that is not built yet. */
    val updatedAt: Long = System.currentTimeMillis()
) {
    companion object {
        /**
         * The stable sync id of one end of one run. Same construction as the
         * takeoff lines' ids (EstimateEngine.deterministicSyncId): the MD5 of a
         * name, which supabase/functions/_shared/pricing/uuid3.ts reproduces
         * byte for byte.
         */
        fun syncIdFor(runSyncId: String, atEnd: Boolean): String =
            java.util.UUID.nameUUIDFromBytes(
                ("fenceflow-run-join:" + runSyncId + ":" + (if (atEnd) "end" else "start")).toByteArray()
            ).toString()
    }
}

/**
 * The reads and writes behind joined run ends. There is NO row removal here and
 * none may be added: an unjoin is [setJoint] with a null, and rows go only when
 * their run goes, through the foreign key.
 *
 * Every read of joints counts a joint as live only when two or more ends hold its
 * label, in the query itself, so no caller can forget to.
 */
@Dao
interface RunJoinDao {
    /** The live join rows of one job, in the same run order as the runs themselves. */
    @Query(
        "SELECT rj.* FROM run_joins rj " +
            "INNER JOIN fence_runs r ON r.id = rj.runId " +
            "WHERE r.jobId = :jobId AND rj.jointId IS NOT NULL " +
            "AND rj.jointId IN (SELECT jointId FROM run_joins WHERE jointId IS NOT NULL " +
            "GROUP BY jointId HAVING COUNT(*) >= 2) " +
            "ORDER BY r.sortOrder ASC, r.syncId ASC, rj.atEnd ASC"
    )
    fun observeLiveForJob(jobId: Long): Flow<List<RunJoin>>

    /** See [observeLiveForJob]. */
    @Query(
        "SELECT rj.* FROM run_joins rj " +
            "INNER JOIN fence_runs r ON r.id = rj.runId " +
            "WHERE r.jobId = :jobId AND rj.jointId IS NOT NULL " +
            "AND rj.jointId IN (SELECT jointId FROM run_joins WHERE jointId IS NOT NULL " +
            "GROUP BY jointId HAVING COUNT(*) >= 2) " +
            "ORDER BY r.sortOrder ASC, r.syncId ASC, rj.atEnd ASC"
    )
    suspend fun getLiveForJob(jobId: Long): List<RunJoin>

    /** The live point this end is at, or null if it is free or alone at its label. */
    @Query(
        "SELECT jointId FROM run_joins WHERE runId = :runId AND atEnd = :atEnd AND jointId IS NOT NULL " +
            "AND jointId IN (SELECT jointId FROM run_joins WHERE jointId IS NOT NULL " +
            "GROUP BY jointId HAVING COUNT(*) >= 2)"
    )
    suspend fun liveJointOf(runId: Long, atEnd: Boolean): String?

    /** How many ends of this run hold this label: 0 or 1, and never 2, by the index. */
    @Query("SELECT COUNT(*) FROM run_joins WHERE jointId = :jointId AND runId = :runId")
    suspend fun countRunAtJoint(jointId: String, runId: Long): Int

    /**
     * Makes sure the end has a row, free. Does nothing if it has one already (-1).
     * Only ever called with a null jointId, because IGNORE would also swallow a
     * clash on the (jointId, runId) index.
     */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertEndIfAbsent(row: RunJoin): Long

    /**
     * Puts an end at a point, or (null) frees it. Returns 1 if it did, 0 if there is
     * no such row or the change would put both ends of the run at one point, which
     * is refused here rather than thrown, so a caller that gets 0 has lost nothing.
     */
    @Query(
        "UPDATE run_joins SET jointId = :jointId, updatedAt = :at " +
            "WHERE runId = :runId AND atEnd = :atEnd " +
            "AND (:jointId IS NULL OR NOT EXISTS (SELECT 1 FROM run_joins o " +
            "WHERE o.jointId = :jointId AND o.runId = :runId AND o.atEnd <> :atEnd))"
    )
    suspend fun setJoint(runId: Long, atEnd: Boolean, jointId: String?, at: Long): Int
}

/** What [planJoin] decided: the result, and for [JoinResult.JOINED] the point both ends go to. */
internal data class JoinPlan(val result: JoinResult, val jointId: String? = null)

/**
 * Decides a join from what is already known, writing nothing, so every rule is in
 * one place and the Repository only carries the plan out.
 *
 * [jointA] and [jointB] are the LIVE points the two ends are at now (null: free).
 * [runBAlreadyAtA] is whether run B already has an end at [jointA], and
 * [runAAlreadyAtB] the same the other way: joining would then put both ends of that
 * run at one point. [newJointId] is the label to use if both ends are free.
 */
internal fun planJoin(
    runA: FenceRun?,
    runB: FenceRun?,
    jointA: String?,
    jointB: String?,
    runBAlreadyAtA: Boolean,
    runAAlreadyAtB: Boolean,
    newJointId: String
): JoinPlan {
    if (runA == null || runB == null) return JoinPlan(JoinResult.RUN_NOT_FOUND)
    if (runA.id == runB.id) return JoinPlan(JoinResult.SAME_RUN)
    if (runA.jobId != runB.jobId) return JoinPlan(JoinResult.DIFFERENT_JOBS)
    if (runA.closedLoop || runB.closedLoop) return JoinPlan(JoinResult.CLOSED_LOOP)
    if (runA.usesManualFeet || runB.usesManualFeet) return JoinPlan(JoinResult.TYPED_FOOTAGE)
    if (runA.isTeardown != runB.isTeardown) return JoinPlan(JoinResult.TEARDOWN_MISMATCH)
    if (jointA != null && jointA == jointB) return JoinPlan(JoinResult.ALREADY_JOINED)
    if (jointA != null && jointB != null) return JoinPlan(JoinResult.AT_ANOTHER_POINT)
    if (jointA != null) {
        return if (runBAlreadyAtA) JoinPlan(JoinResult.SAME_RUN) else JoinPlan(JoinResult.JOINED, jointA)
    }
    if (jointB != null) {
        return if (runAAlreadyAtB) JoinPlan(JoinResult.SAME_RUN) else JoinPlan(JoinResult.JOINED, jointB)
    }
    return JoinPlan(JoinResult.JOINED, newJointId)
}

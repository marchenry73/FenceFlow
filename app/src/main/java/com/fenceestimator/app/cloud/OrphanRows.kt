package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.FieldChange

/**
 * A pulled row whose job left this phone while the pass was running.
 *
 * Every child table (fence runs, line items, steps, markers, punch list,
 * field changes, change orders, shifts, expenses, payments) holds a Room
 * foreign key to its job. The pulls already skip a row whose job is not here
 * -- but they decide that from a job list read once, at the top of the pull,
 * and the pull then spends seconds on the network before writing. A job
 * removed in between (a sign-out's wipe, the Account screen's own JobSync
 * pass deleting a tombstoned or forgotten kept job, a delete on screen) left
 * the list stale, and the insert hit SQLite's FOREIGN KEY constraint (787):
 * one crew phone on 1.512, 2026-09-21, at FieldChangeDao.insert. That throw
 * ended pullJobChildren outright, so every table after field changes --
 * change orders, shifts, steps, markers -- was skipped too, and the pass
 * reported as failed.
 *
 * A row whose parent has gone is now skipped, the same outcome the up-front
 * check was always meant to give: if the job comes back, the next pass brings
 * the row with it. Nothing else is caught -- any other failure still throws.
 */
internal fun isOrphanedWrite(error: Throwable): Boolean =
    generateSequence(error) { it.cause }.take(12).any { e ->
        val m = e.message.orEmpty()
        "FOREIGN KEY constraint failed" in m || "SQLITE_CONSTRAINT_FOREIGNKEY" in m
    }

/**
 * Runs one pulled row's write, or answers null when its parent is no longer
 * on this phone (see [isOrphanedWrite]). Callers skip the row on null.
 */
internal inline fun <T> skipIfOrphaned(write: () -> T): T? =
    try {
        write()
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: Exception) {
        if (!isOrphanedWrite(e)) throw e
        null
    }

/**
 * Field changes from the cloud onto this phone: new ones inserted, known ones
 * merged, and one whose job left mid-pass skipped rather than ending the pull.
 * Split out of EntitySync.pullJobChildren so a test can run it with an orphan
 * row and watch the rows after it still land.
 *
 * @return how many rows were written.
 */
internal suspend fun mergeFieldChanges(
    cloudChanges: List<CloudFieldChange>,
    jobIdBySyncId: Map<String, Long>,
    localBySyncId: Map<String, FieldChange>,
    insert: suspend (FieldChange) -> Unit,
    update: suspend (FieldChange) -> Unit,
    now: Long = System.currentTimeMillis()
): Int {
    var added = 0
    cloudChanges.forEach { row ->
        val jobId = jobIdBySyncId[row.jobSyncId] ?: return@forEach
        val existing = localBySyncId[row.syncId]
        val at = CloudTime.parseMillis(row.at) ?: now
        if (existing == null) {
            skipIfOrphaned {
                insert(
                    FieldChange(
                        syncId = row.syncId, jobId = jobId, summary = row.summary, detail = row.detail,
                        changedBy = row.changedBy, changedByRole = row.changedByRole, at = at,
                        acknowledgedAt = CloudTime.parseMillis(row.acknowledgedAt),
                        isRequest = row.isRequest,
                        approvedAt = CloudTime.parseMillis(row.approvedAt),
                        rejectedAt = CloudTime.parseMillis(row.rejectedAt),
                        decidedBy = row.decidedBy, decisionNote = row.decisionNote
                    )
                )
            } ?: return@forEach
            added++
        } else {
            // A decision already made here is never un-made by a cloud row
            // that has not heard about it yet; the cloud wins when it
            // actually carries one. Same ratchet as shift approvals.
            val cloudApproved = CloudTime.parseMillis(row.approvedAt)
            val cloudRejected = CloudTime.parseMillis(row.rejectedAt)
            val cloudDecided = cloudApproved != null || cloudRejected != null
            val merged = existing.copy(
                summary = row.summary, detail = row.detail,
                acknowledgedAt = existing.acknowledgedAt ?: CloudTime.parseMillis(row.acknowledgedAt),
                approvedAt = if (cloudDecided) cloudApproved else existing.approvedAt,
                rejectedAt = if (cloudDecided) cloudRejected else existing.rejectedAt,
                decidedBy = if (cloudDecided) row.decidedBy else existing.decidedBy,
                decisionNote = if (cloudDecided) row.decisionNote else existing.decisionNote
            )
            if (merged != existing) {
                skipIfOrphaned { update(merged) } ?: return@forEach
                added++
            }
        }
    }
    return added
}

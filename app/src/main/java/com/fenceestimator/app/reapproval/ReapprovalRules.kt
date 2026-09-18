package com.fenceestimator.app.reapproval

/**
 * Pure predicates behind the job-screen re-approval banner and the
 * survey-screen warning dialog (docs/REAPPROVAL_RULE.md). No SQLite, no
 * Compose, no clock -- callers pass in the fields already read off the job,
 * which is what keeps this testable off device.
 */

/**
 * True once the server has withdrawn the customer's approval because the
 * drawing changed materially. This is the single switch behind: the amber
 * job-screen banner, counting the job in "waiting on the customer" rather
 * than "approved" on the dashboard, and the crew "do not build yet" wording.
 */
fun needsReapproval(reapprovalRequiredAt: Long?): Boolean = reapprovalRequiredAt != null

/**
 * Whether editing the drawing should warn before the edit lands.
 *
 * Only meaningful while there is an approval to lose: a job that was never
 * approved has nothing to withdraw, and a job that already needs
 * re-approval has already had its one warning -- editing it further does
 * not throw away a second approval.
 */
fun shouldWarnBeforeEditingDrawing(quoteApprovedAt: Long?, reapprovalRequiredAt: Long?): Boolean =
    quoteApprovedAt != null && !needsReapproval(reapprovalRequiredAt)

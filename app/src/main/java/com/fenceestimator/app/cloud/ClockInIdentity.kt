package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Employee

/**
 * Who a clock-in actually belongs to.
 *
 * Clocking in used to take its identity from the JOB'S ASSIGNMENT, not from
 * whoever was holding the phone. Clock in on an unassigned job and you got a
 * shift with no employee and a rate of zero -- one that looked completely
 * ordinary in every list, because nothing marked it as wrong. Three such
 * shifts reached the live database before anyone noticed.
 *
 * The signed-in person is who worked the shift; the job's assignment is only
 * a fallback for the roster case where the account clocking in (an owner or
 * foreman running the app for the crew) has no employee record of its own.
 * If neither resolves to a real person, the caller must refuse to clock in --
 * recording a shift for nobody is exactly the bug this exists to close.
 */
object ClockInIdentity {

    sealed class Result {
        /** A real person to bill the shift to, and today's rate as a local placeholder. */
        data class Resolved(
            val employeeId: Long,
            val hourlyRate: Double,
            /**
             * True when this is the JOB'S assignee rather than the signed-in
             * person -- an owner or foreman with no crew record of their own,
             * running the app for the crew on a shared phone.
             *
             * A clock-in does not care which it was; a screen that lists those
             * shifts back does. Saying "your hours" over somebody else's shifts
             * is how a crew member reads a colleague's unapproved work as their
             * own, so the caller needs to be able to tell the two apart.
             */
            val viaJobAssignment: Boolean = false
        ) : Result()

        /**
         * Neither the signed-in person nor the job's assignment resolved to an
         * employee. The caller must not clock in and must tell the person why --
         * a silent no-op just leaves them tapping a dead button, and clocking in
         * anyway is the exact bug this type exists to prevent.
         */
        object NoIdentity : Result()
    }

    /**
     * MAY THE SIGNED-IN PERSON CLOCK IN AT ALL?
     *
     * A different question from [resolve], which answers WHOSE shift it is.
     * This one is the permission, and it is per person: March, 6 Nov 2026,
     * asked for the clock to be offered to everyone rather than split by role,
     * with a switch deciding who may use it, and chose "person" over a
     * company-wide rule.
     *
     * NO CREW RECORD MEANS YES. An owner with no record of their own is the
     * state every single-person business is in, and refusing them on a missing
     * row would take the clock away from exactly the people it was just opened
     * for. The record is a place to say NO, not a licence to say yes.
     *
     * Matched the same two ways as [resolve] -- the profile link first, then
     * the email -- so one person cannot be identified by one rule and
     * permitted by the other. The job's assignee is deliberately NOT consulted:
     * whether somebody may clock in is about them, not about the job they are
     * standing on.
     */
    fun canClockIn(
        employees: List<Employee>,
        signedInProfileId: String?,
        signedInEmail: String?
    ): Boolean {
        val self = employees.firstOrNull {
            it.profileId.isNotBlank() && signedInProfileId != null && it.profileId == signedInProfileId
        } ?: employees.firstOrNull { OwnWork.isSamePerson(it, signedInEmail) }
        return self?.canClockIn ?: true
    }

    /**
     * @param employees the company roster, active and inactive alike.
     * @param assignedEmployeeId the job's own assignment, used only as a fallback.
     * @param signedInProfileId the signed-in account's id, matched against
     *   [Employee.profileId] -- the direct, unambiguous link between an
     *   account and a crew record, where one has been recorded.
     * @param signedInEmail used only when no employee carries a profile id yet,
     *   via the same email match [OwnWork] already relies on elsewhere.
     */
    fun resolve(
        employees: List<Employee>,
        assignedEmployeeId: Long?,
        signedInProfileId: String?,
        signedInEmail: String?
    ): Result {
        val self = employees.firstOrNull {
            it.profileId.isNotBlank() && signedInProfileId != null && it.profileId == signedInProfileId
        } ?: employees.firstOrNull { OwnWork.isSamePerson(it, signedInEmail) }

        val assigned = assignedEmployeeId?.let { id -> employees.firstOrNull { it.id == id } }

        val employee = self ?: assigned
        return if (employee != null) {
            Result.Resolved(employee.id, employee.hourlyRate, viaJobAssignment = self == null)
        } else {
            Result.NoIdentity
        }
    }
}

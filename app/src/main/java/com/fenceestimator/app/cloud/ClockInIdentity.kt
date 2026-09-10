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
        data class Resolved(val employeeId: Long, val hourlyRate: Double) : Result()

        /**
         * Neither the signed-in person nor the job's assignment resolved to an
         * employee. The caller must not clock in and must tell the person why --
         * a silent no-op just leaves them tapping a dead button, and clocking in
         * anyway is the exact bug this type exists to prevent.
         */
        object NoIdentity : Result()
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
            Result.Resolved(employee.id, employee.hourlyRate)
        } else {
            Result.NoIdentity
        }
    }
}

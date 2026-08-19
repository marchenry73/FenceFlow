package com.fenceestimator.app.cloud

import com.fenceestimator.app.data.Employee
import com.fenceestimator.app.data.TimeEntry

/**
 * Whether a piece of work belongs to the person looking at it.
 *
 * Exists to stop anyone signing off their own hours. A crew lead may approve
 * their team's shifts -- that is the point of making them a lead -- but nobody
 * approves the shift that pays them, whatever their role. That is not a
 * statement about trust; it is the control that means the timesheet can be
 * shown to an accountant, or to the person being paid, without an argument.
 *
 * ## How identity is worked out, and the limit of it
 *
 * The app has no link between a signed-in account and a crew record. Clocking
 * in uses the job's *assigned* employee rather than whoever is holding the
 * phone, so the two were never connected.
 *
 * Matching on email address closes that without a schema change: a crew record
 * carrying the address its owner signs in with is that person. Where the email
 * is blank, the person's name is compared instead, which is weaker but better
 * than nothing.
 *
 * **The limit is real and worth stating.** A crew member with no email and a
 * name that does not match their profile cannot be recognised, and would be
 * able to approve their own shift. The fix is a proper account-to-crew link,
 * which is worth doing; until then, filling in crew email addresses is what
 * makes this work. The same gap is why the rule is not also enforced in RLS --
 * the database cannot answer a question the data model cannot express.
 */
object OwnWork {

    /**
     * @return true when [entry] appears to be the signed-in person's own shift.
     *
     * Deliberately returns false when identity cannot be established, because
     * the alternative is an app where nobody can approve anything as soon as
     * one crew record is missing an email.
     */
    fun isOwnShift(
        entry: TimeEntry,
        employees: List<Employee>,
        signedInEmail: String?,
        signedInName: String? = null
    ): Boolean {
        val employeeId = entry.employeeId ?: return false
        val employee = employees.firstOrNull { it.id == employeeId } ?: return false
        return isSamePerson(employee, signedInEmail, signedInName)
    }

    /** Whether [employee] is the person signed in. */
    fun isSamePerson(
        employee: Employee,
        signedInEmail: String?,
        signedInName: String? = null
    ): Boolean {
        val email = signedInEmail?.trim()?.lowercase().orEmpty()
        val recordEmail = employee.email.trim().lowercase()
        if (email.isNotEmpty() && recordEmail.isNotEmpty()) {
            return recordEmail == email
        }
        // No email on one side or the other. Fall back to the name, which is
        // weaker -- two people called Dave on one crew defeat it -- but catches
        // the ordinary case of a crew record entered without an address.
        val name = signedInName?.trim()?.lowercase().orEmpty()
        val recordName = employee.name.trim().lowercase()
        return name.isNotEmpty() && recordName.isNotEmpty() && name == recordName
    }
}

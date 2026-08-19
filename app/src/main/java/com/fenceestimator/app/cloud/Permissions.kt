package com.fenceestimator.app.cloud

/**
 * The individual things a person can be allowed to do.
 *
 * Roles were the whole story before this, and roles are too blunt for a real
 * crew. The foreman who has been there nine years should be able to see job
 * money; the new hire on the same role should not. The office manager needs
 * payments but must never delete a signed change order. Forcing those people
 * into six fixed roles means either handing someone the owner login -- which is
 * what actually happens -- or the app being in the way.
 *
 * So a role sets the starting point and each person can be adjusted from there.
 * Every screen asks about a named capability rather than a role, which is what
 * makes the adjustment mean anything.
 *
 * @param label what the owner sees on the toggle
 * @param description the consequence of granting it, in plain terms
 * @param sensitive true for the ones that lose money or destroy records if
 *   granted carelessly -- shown with a warning rather than as an ordinary row
 */
enum class Permission(
    val label: String,
    val description: String,
    val sensitive: Boolean = false
) {
    SEE_MONEY(
        "See prices and money",
        "Job totals, margins, costs and what customers have paid."
    ),
    EDIT_JOBS(
        "Create and edit jobs",
        "Customer details, fence spec, and the drawing."
    ),
    EDIT_CATALOG_AND_SETTINGS(
        "Change catalog and settings",
        "Material prices, pricing tiers and company settings. Affects every future estimate.",
        sensitive = true
    ),
    SCHEDULE_AND_ASSIGN(
        "Schedule work and assign crew",
        "Move jobs around the calendar and put people on them."
    ),
    REQUEST_PAYMENT(
        "Ask customers for money",
        "Create payment links and send invoices.",
        sensitive = true
    ),
    RECORD_REFUNDS(
        "Record refunds",
        "Give money back on a job. Changes what the customer owes.",
        sensitive = true
    ),
    RECORD_FIELD_WORK(
        "Record work on site",
        "Checklists, photos, clock in and out."
    ),
    SEE_CUSTOMER_CONTACT(
        "See customer contact details",
        "Phone numbers and email addresses."
    ),
    SEE_REPORTS(
        "See reports",
        "Revenue, collected, outstanding, and the detail behind them."
    ),
    APPROVE_TIME(
        "Approve crew hours",
        "Confirm clock-outs before they count towards pay.",
        sensitive = true
    ),
    APPROVE_PLAN_CHANGES(
        "Approve plan changes",
        "Accept or reject changes the crew ask for on the fence line."
    ),
    DELETE_RECORDS(
        "Delete records",
        "There is no undo. A deleted signed change order or paid invoice is the " +
            "evidence you would need in a dispute.",
        sensitive = true
    ),
    SHARE_INVITE_CODE(
        "Share the team invite code",
        "The code lets someone join your company. Anyone holding it can put " +
            "themselves on your team.",
        sensitive = true
    ),
    MANAGE_ACCESS(
        "Manage who can do what",
        "Change other people's access, including granting this. Give it to nobody you " +
            "would not hand the owner login to.",
        sensitive = true
    );

    companion object {
        /** Everything, for the owner and for working signed-out on your own phone. */
        val ALL: Set<Permission> = values().toSet()
    }
}

/**
 * Where each role starts before anyone adjusts it.
 *
 * Deletion is absent from every one of these, including manager. A mistaken
 * delete on a signed change order or a paid invoice destroys the record you
 * need in a dispute, and there is no undo -- so it has to be granted to a named
 * person on purpose, never inherited by being given a job title.
 */
val UserRole.defaultPermissions: Set<Permission>
    get() = when (this) {
        UserRole.OWNER -> Permission.ALL

        UserRole.MANAGER -> setOf(
            Permission.SEE_MONEY, Permission.EDIT_JOBS, Permission.EDIT_CATALOG_AND_SETTINGS,
            Permission.SCHEDULE_AND_ASSIGN, Permission.REQUEST_PAYMENT, Permission.RECORD_FIELD_WORK,
            Permission.SEE_CUSTOMER_CONTACT, Permission.SEE_REPORTS, Permission.APPROVE_TIME,
            Permission.APPROVE_PLAN_CHANGES
            // Deliberately no SHARE_INVITE_CODE and no MANAGE_ACCESS. Handing
            // out the code is handing out entry to the company, and a manager
            // who needs to do it can be given it by name.
        )

        UserRole.SALES -> setOf(
            Permission.SEE_MONEY, Permission.EDIT_JOBS, Permission.SEE_CUSTOMER_CONTACT
        )

        UserRole.ACCOUNTANT -> setOf(
            Permission.SEE_MONEY, Permission.REQUEST_PAYMENT, Permission.RECORD_REFUNDS,
            Permission.SEE_CUSTOMER_CONTACT, Permission.SEE_REPORTS
        )

        // A crew lead signs off their team's hours -- that is what makes them
        // a lead rather than another pair of hands. Never their own, though:
        // that rule lives in OwnWork and applies whatever the role, so a lead
        // holding this permission still cannot approve the shift that pays
        // them.
        UserRole.FOREMAN -> setOf(
            Permission.SCHEDULE_AND_ASSIGN, Permission.RECORD_FIELD_WORK,
            Permission.SEE_CUSTOMER_CONTACT, Permission.APPROVE_TIME,
            Permission.APPROVE_PLAN_CHANGES
        )

        UserRole.CREW -> setOf(Permission.RECORD_FIELD_WORK)
    }

/**
 * Per-person adjustments on top of a role, stored as one short string.
 *
 * Written as differences from the role rather than as the whole set, so that
 * changing what a role means later carries through to everyone who was never
 * specifically adjusted. Storing the resolved set would freeze every person at
 * the day they were added.
 *
 * Format is `+PERMISSION` to grant and `-PERMISSION` to take away, comma
 * separated: `+SEE_MONEY,-DELETE_RECORDS`.
 */
object PermissionOverrides {

    fun parse(raw: String?): Pair<Set<Permission>, Set<Permission>> {
        if (raw.isNullOrBlank()) return emptySet<Permission>() to emptySet()
        val granted = mutableSetOf<Permission>()
        val revoked = mutableSetOf<Permission>()
        raw.split(",").forEach { token ->
            val trimmed = token.trim()
            if (trimmed.length < 2) return@forEach
            val permission = runCatching { Permission.valueOf(trimmed.substring(1)) }.getOrNull()
                ?: return@forEach
            when (trimmed.first()) {
                '+' -> granted += permission
                '-' -> revoked += permission
            }
        }
        return granted to revoked
    }

    fun encode(role: UserRole, effective: Set<Permission>): String {
        val base = role.defaultPermissions
        val granted = (effective - base).map { "+${it.name}" }
        val revoked = (base - effective).map { "-${it.name}" }
        return (granted + revoked).sorted().joinToString(",")
    }

    /**
     * What this person can actually do.
     *
     * Revocation is applied last and wins over a grant for the same permission.
     * A contradictory override should take access away rather than give it: the
     * cost of being wrong in that direction is someone asking to be let in,
     * versus someone quietly having access nobody meant to give.
     */
    fun resolve(role: UserRole, raw: String?): Set<Permission> {
        val (granted, revoked) = parse(raw)
        return role.defaultPermissions + granted - revoked
    }
}

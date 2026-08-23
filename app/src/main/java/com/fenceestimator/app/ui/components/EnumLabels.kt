package com.fenceestimator.app.ui.components

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.fenceestimator.app.R
import com.fenceestimator.app.cloud.Permission
import com.fenceestimator.app.cloud.UserRole
import com.fenceestimator.app.data.ExpenseCategory
import com.fenceestimator.app.data.FenceType
import com.fenceestimator.app.data.HoaApprovalStatus
import com.fenceestimator.app.data.HomeCard
import com.fenceestimator.app.data.JobStatus
import com.fenceestimator.app.data.MaterialCategory
import com.fenceestimator.app.data.MaterialRole
import com.fenceestimator.app.data.PaymentMethod
import com.fenceestimator.app.data.PaymentStatus
import com.fenceestimator.app.data.PermitStatus
import com.fenceestimator.app.data.PhotoKind
import com.fenceestimator.app.data.ReviewTemplate
import com.fenceestimator.app.data.SiteMarkerKind
import com.fenceestimator.app.ui.pipeline.PipelineStage
import com.fenceestimator.app.ui.reports.HourFilter
import com.fenceestimator.app.ui.reports.ReportPreset

/**
 * How enum values are written when a person reads them.
 *
 * The app was calling `name.replace("_", " ")` in thirty-odd places, which
 * produces "CHAIN LINK" and "LINE POST" -- shouting, and inconsistent with
 * every other label on the screen. Worse, some of those strings end up on a
 * customer's quote, where "ORNAMENTAL IRON" reads as a database field that
 * escaped rather than a product being sold.
 *
 * Names are written the way the trade writes them, not the way the enum
 * spells them.
 *
 * Two flavours live here:
 *
 *  - `labelRes()` returns the string resource id, for code that has a
 *    `Context` but no composition -- click handlers, dropdown text builders,
 *    report detail sheets. Pair it with `context.getString(...)`.
 *  - `label()` is the `@Composable` convenience that reads the same resource
 *    through [stringResource], for anything drawn on screen.
 *
 * The plain `label` *properties* on [FenceType], [MaterialCategory] and
 * [MaterialRole] are the English fallbacks used by non-UI code (the PDF
 * exporter, which has no Context at the point of drawing). Screens should use
 * the resource-backed functions instead.
 */

/** "CHAIN_LINK" -> "Chain Link". The fallback when nothing better is defined. */
fun String.toTitleCase(): String =
    split('_').filter { it.isNotEmpty() }.joinToString(" ") { word ->
        word.lowercase().replaceFirstChar { it.uppercase() }
    }

val FenceType.label: String
    get() = when (this) {
        FenceType.VINYL -> "Vinyl"
        FenceType.WOOD -> "Wood"
        FenceType.CHAIN_LINK -> "Chain Link"
        FenceType.ALUMINUM -> "Aluminum"
        FenceType.ORNAMENTAL_IRON -> "Ornamental Iron"
        FenceType.SPLIT_RAIL -> "Split Rail"
        FenceType.COMPOSITE -> "Composite"
        // Parts that fit any fence -- concrete, fasteners, generic hardware.
        // "Universal" alone reads as a brand; this says what it means.
        FenceType.UNIVERSAL -> "Fits Any Fence"
    }

val MaterialCategory.label: String
    get() = when (this) {
        MaterialCategory.PANEL -> "Panels"
        MaterialCategory.POST -> "Posts"
        MaterialCategory.CAP -> "Caps"
        MaterialCategory.CONCRETE -> "Concrete"
        MaterialCategory.HARDWARE -> "Hardware"
        MaterialCategory.GATE -> "Gates"
        MaterialCategory.TRIM -> "Trim"
        MaterialCategory.FABRIC -> "Fabric"
        MaterialCategory.RAIL -> "Rails"
        MaterialCategory.PICKET -> "Pickets"
        MaterialCategory.MISC -> "Other"
    }

val MaterialRole.label: String
    get() = when (this) {
        MaterialRole.LINE_POST -> "Line post"
        MaterialRole.END_POST -> "End post"
        MaterialRole.CORNER_POST -> "Corner post"
        MaterialRole.GATE_POST -> "Gate post"
        MaterialRole.BLANK_POST -> "Blank post"
        MaterialRole.POST_CAP -> "Post cap"
        MaterialRole.CONCRETE_BAG -> "Concrete"
        MaterialRole.HOLE_PLUG -> "Hole plug"
        MaterialRole.GATE_PANEL -> "Gate panel"
        MaterialRole.HINGE_SET -> "Hinges"
        MaterialRole.CHAIN_FABRIC -> "Chain link fabric"
        MaterialRole.TOP_RAIL -> "Top rail"
        MaterialRole.TENSION_WIRE -> "Tension wire"
        MaterialRole.TENSION_BAND -> "Tension band"
        MaterialRole.BRACE_BAND -> "Brace band"
        MaterialRole.RAIL_END -> "Rail end"
        MaterialRole.BARBED_WIRE_ARM -> "Barbed wire arm"
        MaterialRole.PRIVACY_SLAT -> "Privacy slat"
        MaterialRole.WOOD_PICKET -> "Picket"
        MaterialRole.WOOD_RAIL -> "Rail"
        MaterialRole.GATE_FRAME_KIT -> "Gate frame kit"
        MaterialRole.NONE -> "Other"
        // Single words that title-case correctly on their own.
        else -> name.toTitleCase()
    }

// ---------------------------------------------------------------------------
// Resource-backed labels
// ---------------------------------------------------------------------------

@StringRes
fun FenceType.labelRes(): Int = when (this) {
    FenceType.VINYL -> R.string.enum_fence_vinyl
    FenceType.WOOD -> R.string.enum_fence_wood
    FenceType.CHAIN_LINK -> R.string.enum_fence_chain_link
    FenceType.ALUMINUM -> R.string.enum_fence_aluminum
    FenceType.ORNAMENTAL_IRON -> R.string.enum_fence_ornamental_iron
    FenceType.SPLIT_RAIL -> R.string.enum_fence_split_rail
    FenceType.COMPOSITE -> R.string.enum_fence_composite
    FenceType.UNIVERSAL -> R.string.enum_fence_universal
}

@Composable
fun FenceType.label(): String = stringResource(labelRes())

@StringRes
fun MaterialCategory.labelRes(): Int = when (this) {
    MaterialCategory.PANEL -> R.string.enum_cat_panel
    MaterialCategory.POST -> R.string.enum_cat_post
    MaterialCategory.CAP -> R.string.enum_cat_cap
    MaterialCategory.CONCRETE -> R.string.enum_cat_concrete
    MaterialCategory.HARDWARE -> R.string.enum_cat_hardware
    MaterialCategory.GATE -> R.string.jd_gates
    MaterialCategory.TRIM -> R.string.enum_cat_trim
    MaterialCategory.FABRIC -> R.string.enum_cat_fabric
    MaterialCategory.RAIL -> R.string.enum_cat_rail
    MaterialCategory.PICKET -> R.string.enum_cat_picket
    MaterialCategory.MISC -> R.string.enum_cat_misc
}

@Composable
fun MaterialCategory.label(): String = stringResource(labelRes())

@StringRes
fun MaterialRole.labelRes(): Int = when (this) {
    MaterialRole.PANEL -> R.string.enum_role_panel
    MaterialRole.GATE_PANEL -> R.string.enum_role_gate_panel
    MaterialRole.LINE_POST -> R.string.enum_role_line_post
    MaterialRole.END_POST -> R.string.enum_role_end_post
    MaterialRole.CORNER_POST -> R.string.enum_role_corner_post
    MaterialRole.GATE_POST -> R.string.enum_role_gate_post
    MaterialRole.POST_CAP -> R.string.enum_role_post_cap
    MaterialRole.CONCRETE_BAG -> R.string.enum_cat_concrete
    MaterialRole.HOLE_PLUG -> R.string.enum_role_hole_plug
    MaterialRole.BLANK_POST -> R.string.enum_role_blank_post
    MaterialRole.HINGE_SET -> R.string.enum_role_hinge_set
    MaterialRole.LATCH -> R.string.enum_role_latch
    MaterialRole.HANDLE -> R.string.enum_role_handle
    MaterialRole.BRACE -> R.string.enum_role_brace
    MaterialRole.STIFFENER -> R.string.enum_role_stiffener
    MaterialRole.TRIM -> R.string.enum_role_trim
    MaterialRole.WOOD_PICKET -> R.string.enum_role_wood_picket
    MaterialRole.WOOD_RAIL -> R.string.enum_role_wood_rail
    MaterialRole.GATE_FRAME_KIT -> R.string.enum_role_gate_frame_kit
    MaterialRole.CHAIN_FABRIC -> R.string.enum_role_chain_fabric
    MaterialRole.TOP_RAIL -> R.string.enum_role_top_rail
    MaterialRole.TENSION_WIRE -> R.string.enum_role_tension_wire
    MaterialRole.TENSION_BAND -> R.string.enum_role_tension_band
    MaterialRole.BRACE_BAND -> R.string.enum_role_brace_band
    MaterialRole.RAIL_END -> R.string.enum_role_rail_end
    MaterialRole.BARBED_WIRE_ARM -> R.string.enum_role_barbed_wire_arm
    MaterialRole.PRIVACY_SLAT -> R.string.enum_role_privacy_slat
    MaterialRole.NONE -> R.string.enum_other
}

@Composable
fun MaterialRole.label(): String = stringResource(labelRes())

/** Same wording the home screen's status pills use, so a job reads the same everywhere. */
@StringRes
fun JobStatus.labelRes(): Int = when (this) {
    JobStatus.DRAFT -> R.string.home_status_draft
    JobStatus.SENT -> R.string.home_status_sent
    JobStatus.ACCEPTED -> R.string.home_status_accepted
    JobStatus.COMPLETED -> R.string.home_status_completed
    JobStatus.DECLINED -> R.string.home_status_declined
}

@Composable
fun JobStatus.label(): String = stringResource(labelRes())

@StringRes
fun PaymentStatus.labelRes(): Int = when (this) {
    PaymentStatus.UNPAID -> R.string.enum_payment_unpaid
    PaymentStatus.DEPOSIT_PAID -> R.string.enum_payment_deposit_paid
    PaymentStatus.PAID_IN_FULL -> R.string.enum_payment_paid_in_full
}

@Composable
fun PaymentStatus.label(): String = stringResource(labelRes())

/** The `label` property stays for non-UI code; screens read the resource. */
@StringRes
fun PaymentMethod.labelRes(): Int = when (this) {
    PaymentMethod.CARD -> R.string.enum_method_card
    PaymentMethod.CASH -> R.string.enum_method_cash
    PaymentMethod.CHECK -> R.string.enum_method_check
    PaymentMethod.BANK_TRANSFER -> R.string.enum_method_bank_transfer
    PaymentMethod.OTHER -> R.string.enum_other
}

@Composable
fun PaymentMethod.label(): String = stringResource(labelRes())

@StringRes
fun HoaApprovalStatus.labelRes(): Int = when (this) {
    HoaApprovalStatus.NOT_REQUIRED -> R.string.enum_status_not_required
    HoaApprovalStatus.PENDING -> R.string.enum_status_pending
    HoaApprovalStatus.APPROVED -> R.string.enum_status_approved
    HoaApprovalStatus.DENIED -> R.string.enum_status_denied
}

@Composable
fun HoaApprovalStatus.label(): String = stringResource(labelRes())

@StringRes
fun PermitStatus.labelRes(): Int = when (this) {
    PermitStatus.NOT_REQUIRED -> R.string.enum_status_not_required
    PermitStatus.PENDING -> R.string.enum_status_pending
    PermitStatus.APPROVED -> R.string.enum_status_approved
}

@Composable
fun PermitStatus.label(): String = stringResource(labelRes())

@StringRes
fun ExpenseCategory.labelRes(): Int = when (this) {
    ExpenseCategory.FUEL -> R.string.enum_expense_fuel
    ExpenseCategory.EQUIPMENT_RENTAL -> R.string.enum_expense_equipment_rental
    ExpenseCategory.PERMIT_FEE -> R.string.enum_expense_permit_fee
    ExpenseCategory.OTHER -> R.string.enum_other
}

@Composable
fun ExpenseCategory.label(): String = stringResource(labelRes())

@StringRes
fun PhotoKind.labelRes(): Int = when (this) {
    PhotoKind.BEFORE -> R.string.misc_photo_before
    PhotoKind.AFTER -> R.string.misc_photo_after
    PhotoKind.JOBSITE -> R.string.enum_photo_jobsite
}

@Composable
fun PhotoKind.label(): String = stringResource(labelRes())

@StringRes
fun SiteMarkerKind.labelRes(): Int = when (this) {
    SiteMarkerKind.EXISTING_FENCE -> R.string.misc_marker_old_fence
    SiteMarkerKind.HOUSE -> R.string.misc_marker_house
    SiteMarkerKind.POOL -> R.string.misc_marker_pool
    SiteMarkerKind.DRIVEWAY -> R.string.misc_marker_driveway
    SiteMarkerKind.EASEMENT -> R.string.misc_marker_easement
    SiteMarkerKind.UTILITY -> R.string.misc_marker_utility
    SiteMarkerKind.TREE -> R.string.misc_marker_tree
    SiteMarkerKind.SLOPE -> R.string.misc_marker_slope
    SiteMarkerKind.OBSTACLE -> R.string.misc_marker_obstacle
}

@Composable
fun SiteMarkerKind.label(): String = stringResource(labelRes())

// -- Roles and permissions -------------------------------------------------

@StringRes
fun UserRole.labelRes(): Int = when (this) {
    UserRole.OWNER -> R.string.enum_role_owner
    UserRole.MANAGER -> R.string.enum_role_manager
    UserRole.SALES -> R.string.rep_cat_sales
    UserRole.ACCOUNTANT -> R.string.enum_role_accountant
    UserRole.FOREMAN -> R.string.enum_role_foreman
    UserRole.CREW -> R.string.enum_role_crew
}

@Composable
fun UserRole.label(): String = stringResource(labelRes())

@StringRes
fun UserRole.descriptionRes(): Int = when (this) {
    UserRole.OWNER -> R.string.enum_role_owner_desc
    UserRole.MANAGER -> R.string.enum_role_manager_desc
    UserRole.SALES -> R.string.enum_role_sales_desc
    UserRole.ACCOUNTANT -> R.string.enum_role_accountant_desc
    UserRole.FOREMAN -> R.string.enum_role_foreman_desc
    UserRole.CREW -> R.string.enum_role_crew_desc
}

@Composable
fun UserRole.description(): String = stringResource(descriptionRes())

@StringRes
fun Permission.labelRes(): Int = when (this) {
    Permission.SEE_MONEY -> R.string.enum_perm_see_money
    Permission.EDIT_JOBS -> R.string.enum_perm_edit_jobs
    Permission.EDIT_CATALOG_AND_SETTINGS -> R.string.enum_perm_edit_catalog_and_settings
    Permission.SCHEDULE_AND_ASSIGN -> R.string.enum_perm_schedule_and_assign
    Permission.REQUEST_PAYMENT -> R.string.enum_perm_request_payment
    Permission.RECORD_REFUNDS -> R.string.enum_perm_record_refunds
    Permission.RECORD_FIELD_WORK -> R.string.enum_perm_record_field_work
    Permission.SEE_CUSTOMER_CONTACT -> R.string.enum_perm_see_customer_contact
    Permission.SEE_REPORTS -> R.string.enum_perm_see_reports
    Permission.APPROVE_TIME -> R.string.enum_perm_approve_time
    Permission.APPROVE_PLAN_CHANGES -> R.string.enum_perm_approve_plan_changes
    Permission.DELETE_RECORDS -> R.string.enum_perm_delete_records
    Permission.SHARE_INVITE_CODE -> R.string.enum_perm_share_invite_code
    Permission.MANAGE_ACCESS -> R.string.enum_perm_manage_access
}

@Composable
fun Permission.label(): String = stringResource(labelRes())

@StringRes
fun Permission.descriptionRes(): Int = when (this) {
    Permission.SEE_MONEY -> R.string.enum_perm_see_money_desc
    Permission.EDIT_JOBS -> R.string.enum_perm_edit_jobs_desc
    Permission.EDIT_CATALOG_AND_SETTINGS -> R.string.enum_perm_edit_catalog_and_settings_desc
    Permission.SCHEDULE_AND_ASSIGN -> R.string.enum_perm_schedule_and_assign_desc
    Permission.REQUEST_PAYMENT -> R.string.enum_perm_request_payment_desc
    Permission.RECORD_REFUNDS -> R.string.enum_perm_record_refunds_desc
    Permission.RECORD_FIELD_WORK -> R.string.enum_perm_record_field_work_desc
    Permission.SEE_CUSTOMER_CONTACT -> R.string.enum_perm_see_customer_contact_desc
    Permission.SEE_REPORTS -> R.string.enum_perm_see_reports_desc
    Permission.APPROVE_TIME -> R.string.enum_perm_approve_time_desc
    Permission.APPROVE_PLAN_CHANGES -> R.string.enum_perm_approve_plan_changes_desc
    Permission.DELETE_RECORDS -> R.string.enum_perm_delete_records_desc
    Permission.SHARE_INVITE_CODE -> R.string.enum_perm_share_invite_code_desc
    Permission.MANAGE_ACCESS -> R.string.enum_perm_manage_access_desc
}

@Composable
fun Permission.description(): String = stringResource(descriptionRes())

// -- Home screen cards -----------------------------------------------------

@StringRes
fun HomeCard.labelRes(): Int = when (this) {
    HomeCard.SCHEDULED_THIS_WEEK -> R.string.home_booked_this_week
    HomeCard.WON_THIS_MONTH -> R.string.enum_home_won_this_month
    HomeCard.COLLECTED_THIS_MONTH -> R.string.home_collected_this_month
    HomeCard.OUTSTANDING -> R.string.jd_still_owed
    HomeCard.UNPAID_JOBS -> R.string.enum_home_unpaid_jobs
    HomeCard.HOURS_TO_APPROVE -> R.string.enum_home_hours_to_approve
    HomeCard.DRAFT_ESTIMATES -> R.string.enum_home_drafts
    HomeCard.OVERRUNNING -> R.string.enum_home_running_late
}

@Composable
fun HomeCard.label(): String = stringResource(labelRes())

@StringRes
fun HomeCard.explainsRes(): Int = when (this) {
    HomeCard.SCHEDULED_THIS_WEEK -> R.string.enum_home_booked_this_week_desc
    HomeCard.WON_THIS_MONTH -> R.string.enum_home_won_this_month_desc
    HomeCard.COLLECTED_THIS_MONTH -> R.string.enum_home_collected_this_month_desc
    HomeCard.OUTSTANDING -> R.string.enum_home_still_owed_desc
    HomeCard.UNPAID_JOBS -> R.string.enum_home_unpaid_jobs_desc
    HomeCard.HOURS_TO_APPROVE -> R.string.enum_home_hours_to_approve_desc
    HomeCard.DRAFT_ESTIMATES -> R.string.enum_home_drafts_desc
    HomeCard.OVERRUNNING -> R.string.enum_home_running_late_desc
}

@Composable
fun HomeCard.explains(): String = stringResource(explainsRes())

// -- Review request templates ----------------------------------------------

@StringRes
fun ReviewTemplate.labelRes(): Int = when (this) {
    ReviewTemplate.STRAIGHTFORWARD -> R.string.enum_review_straightforward
    ReviewTemplate.AFTER_A_PROBLEM -> R.string.enum_review_after_a_problem
    ReviewTemplate.REPEAT_CUSTOMER -> R.string.enum_review_repeat_customer
    ReviewTemplate.BIG_JOB -> R.string.enum_review_big_job
    ReviewTemplate.QUIET_NUDGE -> R.string.enum_review_quiet_nudge
}

@Composable
fun ReviewTemplate.label(): String = stringResource(labelRes())

@StringRes
fun ReviewTemplate.describesRes(): Int = when (this) {
    ReviewTemplate.STRAIGHTFORWARD -> R.string.enum_review_straightforward_desc
    ReviewTemplate.AFTER_A_PROBLEM -> R.string.enum_review_after_a_problem_desc
    ReviewTemplate.REPEAT_CUSTOMER -> R.string.enum_review_repeat_customer_desc
    ReviewTemplate.BIG_JOB -> R.string.enum_review_big_job_desc
    ReviewTemplate.QUIET_NUDGE -> R.string.enum_review_quiet_nudge_desc
}

@Composable
fun ReviewTemplate.describes(): String = stringResource(describesRes())

// -- Pipeline board and report filters -------------------------------------

@StringRes
fun PipelineStage.labelRes(): Int = when (this) {
    PipelineStage.LEAD -> R.string.enum_pipeline_lead
    PipelineStage.ESTIMATING -> R.string.enum_pipeline_estimating
    PipelineStage.QUOTE_SENT -> R.string.enum_pipeline_quote_sent
    PipelineStage.APPROVED -> R.string.enum_status_approved
    PipelineStage.DEPOSIT_PAID -> R.string.enum_pipeline_deposit_paid
    PipelineStage.SCHEDULED -> R.string.enum_pipeline_scheduled
    PipelineStage.INSTALLED -> R.string.enum_pipeline_installed
    PipelineStage.COMPLETE -> R.string.enum_pipeline_paid_in_full
    PipelineStage.LOST -> R.string.enum_pipeline_lost
}

@Composable
fun PipelineStage.label(): String = stringResource(labelRes())

@StringRes
fun ReportPreset.labelRes(): Int = when (this) {
    ReportPreset.WEEK -> R.string.enum_preset_week
    ReportPreset.MONTH -> R.string.enum_preset_month
    ReportPreset.QUARTER -> R.string.enum_preset_quarter
    ReportPreset.YEAR -> R.string.enum_preset_year
    ReportPreset.ALL -> R.string.enum_preset_all
    ReportPreset.CUSTOM -> R.string.jd_tier_custom
}

@Composable
fun ReportPreset.label(): String = stringResource(labelRes())

@StringRes
fun HourFilter.labelRes(): Int = when (this) {
    HourFilter.ALL -> R.string.enum_hours_all
    HourFilter.EARLY -> R.string.enum_hours_early
    HourFilter.WORK -> R.string.enum_hours_work
    HourFilter.LATE -> R.string.enum_hours_late
}

@Composable
fun HourFilter.label(): String = stringResource(labelRes())
